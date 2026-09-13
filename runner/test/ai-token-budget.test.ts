import { describe, expect, it } from "vitest";
import {
  runDualReview,
  runRequirementDraft,
  validateReviewRecord,
  type AIProvider,
  type TokenUsage,
} from "../src/ai-review";

const input = {
  criteria: [{ id: "AC-1", description: "Health endpoint reports ok" }],
  evidence: [{ id: "E-1", text: "Health endpoint reports ok" }],
};
const requirements = {
  requirements: [{ id: "R-1", text: "Health endpoint reports ok" }],
};
const reviewContent = JSON.stringify({
  criteria: [
    {
      id: "AC-1",
      passed: true,
      citations: [{ evidenceId: "E-1", quote: "Health endpoint reports ok" }],
    },
  ],
});
const draftContent = JSON.stringify({
  suggestions: [
    {
      id: "AC-1",
      description: "Health endpoint reports ok",
      requirementId: "R-1",
      quote: "Health endpoint reports ok",
      clarification: "Agree on the response body before approval.",
    },
  ],
});
const usageAt = (outputTokens: number): TokenUsage => ({
  inputTokens: 10,
  outputTokens,
  totalTokens: 10 + outputTokens,
});
function provider(content: string, usage?: TokenUsage): AIProvider {
  return {
    model: "token-budget-fixture",
    mode: "synthetic",
    async complete() {
      return { content, ...(usage === undefined ? {} : { usage }) };
    },
  };
}
const review = (usage?: TokenUsage) =>
  runDualReview(input, {
    provider: provider(reviewContent, usage),
    maxOutputTokens: 100,
  });
const draft = (usage?: TokenUsage) =>
  runRequirementDraft(requirements, {
    provider: provider(draftContent, usage),
    maxOutputTokens: 100,
  });

describe("common per-response output token budget", () => {
  it("rejects valid review votes when the provider reports 101 tokens against a 100 cap", async () => {
    const result = await review(usageAt(101));
    expect(result.passed).toBe(false);
    expect(result.error).toBe("invalid_or_failed_provider_response");
    expect(result.criteria[0].passed).toBe(false);
  });

  it("rejects an offline record with over-cap usage even when its totals are consistent", async () => {
    const result = await review(usageAt(100));
    const expectedPolicyHash = result.policyHash;
    expect(() => validateReviewRecord(result, expectedPolicyHash)).not.toThrow();
    result.rounds[0].calls[0].usage = usageAt(101);
    result.usage.outputTokens = 201;
    result.usage.totalTokens = 221;
    expect(() => validateReviewRecord(result, expectedPolicyHash)).toThrow();
  });

  it("rejects valid requirement suggestions when reported output exceeds the cap", async () => {
    const result = await draft(usageAt(101));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("invalid_or_failed_provider_response");
    expect(result.suggestions).toEqual([]);
  });

  it("allows exactly 100 tokens per call, including replay, even when the aggregate exceeds 100", async () => {
    const result = await review(usageAt(100));
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 200,
      totalTokens: 220,
      measuredCalls: 2,
      complete: true,
    });
    expect(() => validateReviewRecord(result, result.policyHash)).not.toThrow();
  });

  it("allows requirement drafts exactly at the output cap", async () => {
    const result = await draft(usageAt(100));
    expect(result.status).toBe("draft");
    expect(result.usage).toEqual(usageAt(100));
  });

  it("preserves unknown review usage and accepts its replay without inventing tokens", async () => {
    const result = await review();
    expect(result.passed).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      measuredCalls: 0,
      complete: false,
    });
    expect(result.rounds[0].calls.every((call) => call.usage === null)).toBe(true);
    expect(() => validateReviewRecord(result, result.policyHash)).not.toThrow();
  });

  it("preserves unknown requirement draft usage", async () => {
    const result = await draft();
    expect(result.status).toBe("draft");
    expect(result.usage).toBeNull();
  });

  it.each([
    ["negative", { inputTokens: 10, outputTokens: -1, totalTokens: 9 }],
    ["fractional", { inputTokens: 10, outputTokens: 1.5, totalTokens: 11.5 }],
    ["inconsistent total", { inputTokens: 10, outputTokens: 1, totalTokens: 12 }],
    ["missing field", { inputTokens: 10, outputTokens: 1 }],
    ["null", null],
  ])("continues rejecting malformed %s usage in common processing and replay", async (_, value) => {
    const usage = value as TokenUsage;
    expect((await review(usage)).passed).toBe(false);
    expect((await draft(usage)).status).toBe("failed");
    // Null is the existing record representation of unknown usage.
    if (value !== null) {
      const result = await review(usageAt(100));
      result.rounds[0].calls[0].usage = usage;
      expect(() => validateReviewRecord(result, result.policyHash)).toThrow();
    }
  });
});
