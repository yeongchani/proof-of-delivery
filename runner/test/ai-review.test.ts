import { describe, expect, it } from "vitest";
import {
  AI_LIMITS,
  REVIEW_PROMPTS,
  reviewPolicyHash,
  runDualReview,
  runRequirementDraft,
  validateReviewRecord,
  type AIProvider,
  type ProviderResponse,
  type ReviewInput,
  type ReviewResult,
} from "../src/ai-review";

const input: ReviewInput = {
  criteria: [{ id: "AC-1", description: "Health endpoint reports ok" }],
  evidence: [
    { id: "E-1", text: "Health endpoint reports ok in captured test output." },
  ],
};
const response = (passed: boolean): ProviderResponse => ({
  content: JSON.stringify({
    criteria: [
      {
        id: "AC-1",
        passed,
        citations: [{ evidenceId: "E-1", quote: "Health endpoint reports ok" }],
      },
    ],
  }),
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});
function fixture(votes: boolean[]): AIProvider {
  let i = 0;
  return {
    model: "fixture-v1",
    mode: "synthetic",
    async complete() {
      return response(votes[i++]);
    },
  };
}

describe("dual review algorithm, synthetic fixtures (NOT an accuracy benchmark)", () => {
  it("ends on initial agreement and records both votes and accounting", async () => {
    const result = await runDualReview(input, {
      provider: fixture([true, true]),
    });
    expect(result.passed).toBe(true);
    expect(result.calls).toBe(2);
    expect(result.rounds).toHaveLength(1);
    expect(result.criteria[0]).toMatchObject({ passVotes: 2, totalVotes: 2 });
    expect(result.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
    expect(result.mode).toBe("synthetic");
    expect(result.policyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it.each([
    [[true, false, true, true, true, false, false, false], false, 4],
    [[true, false, true, true, true, true, false, false], true, 5],
    [[false, false], false, 0],
  ] as [boolean[], boolean, number][])(
    "aggregates all votes %j",
    async (votes, passed, count) => {
      const result = await runDualReview(input, { provider: fixture(votes) });
      expect(result.passed).toBe(passed);
      expect(result.calls).toBe(votes.length);
      expect(result.criteria[0].passVotes).toBe(count);
    }
  );
  it("fails closed on malformed content without fallback", async () => {
    const result = await runDualReview(input, {
      provider: {
        model: "real",
        mode: "live",
        async complete() {
          return { content: "not JSON" };
        },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.mode).toBe("live");
  });
  it.each([
    { criteria: [] },
    {
      criteria: [
        {
          id: "wrong",
          passed: true,
          citations: [{ evidenceId: "E-1", quote: "Health" }],
        },
      ],
    },
    {
      criteria: [
        {
          id: "AC-1",
          passed: "true",
          citations: [{ evidenceId: "E-1", quote: "Health" }],
        },
      ],
    },
    { criteria: [{ id: "AC-1", passed: true, citations: [] }] },
    { criteria: [{ id: "AC-1", passed: false, citations: [] }] },
    {
      criteria: [
        {
          id: "AC-1",
          passed: true,
          citations: [{ evidenceId: "E-1", quote: "fabricated" }],
        },
      ],
    },
    {
      criteria: [
        {
          id: "AC-1",
          passed: true,
          citations: [{ evidenceId: "E-1", quote: " " }],
        },
      ],
    },
    {
      criteria: [
        {
          id: "AC-1",
          passed: true,
          citations: [{ evidenceId: "missing", quote: "Health" }],
        },
      ],
    },
    {
      criteria: [
        {
          id: "AC-1",
          passed: true,
          citations: [{ evidenceId: "E-1", quote: "Health", extra: true }],
        },
      ],
    },
    { ...JSON.parse(response(true).content), refusal: "I refuse" },
  ])(
    "invalid structured response fails the entire review: %j",
    async (body) => {
      let calls = 0;
      const result = await runDualReview(input, {
        provider: {
          model: "fixture",
          mode: "synthetic",
          async complete() {
            calls++;
            return { content: JSON.stringify(body) };
          },
        },
      });
      expect(result.passed).toBe(false);
      expect(result.criteria.every((c) => !c.passed)).toBe(true);
      expect(result.error).toBeDefined();
      expect(calls).toBe(2);
      expect(
        result.rounds[0].calls.every(
          (c) => c.rawResponse === JSON.stringify(body)
        )
      ).toBe(true);
    }
  );
  it("rejects duplicate returned ids even when criterion counts match", async () => {
    const multi = {
      ...input,
      criteria: [
        ...input.criteria,
        { id: "AC-2", description: "Second condition" },
      ],
    };
    const vote = JSON.parse(response(true).content).criteria[0];
    const result = await runDualReview(multi, {
      provider: {
        model: "fixture",
        mode: "synthetic",
        async complete() {
          return { content: JSON.stringify({ criteria: [vote, vote] }) };
        },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });
  it("does not count valid votes as a pass after one later malformed response", async () => {
    let i = 0;
    const result = await runDualReview(input, {
      provider: {
        model: "fixture",
        mode: "synthetic",
        async complete() {
          i++;
          return i === 8 ? { content: "refused" } : response(i !== 2);
        },
      },
    });
    expect(result.calls).toBe(8);
    expect(result.criteria[0].passVotes).toBe(6);
    expect(result.passed).toBe(false);
  });
  it("aborts timed-out calls even when a provider ignores cancellation", async () => {
    const signals: AbortSignal[] = [];
    const result = await runDualReview(input, {
      timeoutMs: 5,
      provider: {
        model: "fixture",
        mode: "live",
        async complete(request) {
          signals.push(request.signal);
          return new Promise<never>(() => {});
        },
      },
    });
    expect(result.error).toBe("provider_timeout");
    expect(result.passed).toBe(false);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(result.usage.complete).toBe(false);
  });
  it("sanitizes rejected provider errors and never invents usage", async () => {
    const result = await runDualReview(input, {
      provider: {
        model: "fixture",
        mode: "live",
        async complete() {
          throw new Error("secret-api-key");
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-api-key");
    expect(result.passed).toBe(false);
    expect(result.usage).toMatchObject({ complete: false, measuredCalls: 0 });
  });
  it("fails closed when a smaller call budget cannot finish required rounds", async () => {
    const result = await runDualReview(input, {
      provider: fixture([true, false]),
      maxRequests: 3,
    });
    expect(result.calls).toBe(2);
    expect(result.error).toBe("request_budget_exhausted");
    expect(result.passed).toBe(false);
  });
  it("uses identical immutable input with no history in all eight calls", async () => {
    const mutable = JSON.parse(JSON.stringify(input));
    const requests: { user: string; system: string }[] = [];
    const result = await runDualReview(mutable, {
      provider: {
        model: "fixture",
        mode: "synthetic",
        async complete(request) {
          requests.push({ user: request.user, system: request.system });
          mutable.evidence[0].text = "mutated";
          return response(requests.length !== 2);
        },
      },
    });
    expect(result.calls).toBe(8);
    expect(new Set(requests.map((r) => r.user)).size).toBe(1);
    expect(JSON.parse(requests[0].user)).toEqual(input);
    expect(new Set(requests.map((r) => r.system))).toEqual(
      new Set(Object.values(REVIEW_PROMPTS))
    );
    expect(result.input).toEqual(input);
    expect(result.passed).toBe(true);
  });
  it("compares by criterion id, aggregates each independently, including initially agreed criteria", async () => {
    const multi = {
      ...input,
      criteria: [
        ...input.criteria,
        { id: "AC-2", description: "Second condition" },
      ],
    };
    let i = 0;
    const result = await runDualReview(multi, {
      provider: {
        model: "fixture",
        mode: "synthetic",
        async complete() {
          const n = i++;
          const citation = [{ evidenceId: "E-1", quote: "Health" }];
          return {
            content: JSON.stringify({
              criteria: [
                { id: "AC-2", passed: n < 4, citations: citation },
                { id: "AC-1", passed: n !== 1, citations: citation },
              ].reverse(),
            }),
          };
        },
      },
    });
    expect(result.criteria).toEqual([
      { id: "AC-1", passed: true, passVotes: 7, totalVotes: 8 },
      { id: "AC-2", passed: false, passVotes: 4, totalVotes: 8 },
    ]);
    expect(result.passed).toBe(false);
  });
  it("precomputes the deterministic policy independent of votes and input", async () => {
    const provider = fixture([true, true]);
    const options = { maxOutputTokens: 100, timeoutMs: 200, maxRequests: 8 };
    const result = await runDualReview(input, { provider, ...options });
    expect(result.policyHash).toBe(
      reviewPolicyHash(provider.model, { mode: provider.mode, ...options })
    );
    expect(result.policyHash).not.toBe(
      reviewPolicyHash("different", { ...options })
    );
    expect(result.policyHash).not.toBe(
      reviewPolicyHash(provider.model, { ...options, mode: "live" })
    );
    expect(result.policyHash).not.toBe(reviewPolicyHash(provider.model));
  });
  it.each([
    { ...input, party: "identity" },
    { ...input, criteria: [] },
    { ...input, evidence: [] },
    { ...input, criteria: [...input.criteria, ...input.criteria] },
    { ...input, evidence: [...input.evidence, ...input.evidence] },
    { ...input, criteria: [{ id: "AC-1", description: "x".repeat(2049) }] },
    { ...input, evidence: [{ id: "E-1", text: "x".repeat(8193) }] },
    {
      ...input,
      evidence: Array.from({ length: 20 }, (_, i) => ({
        id: `E-${i}`,
        text: "x".repeat(8192),
      })),
    },
  ])(
    "rejects invalid or unbounded input before a provider call",
    async (value) => {
      let calls = 0;
      await expect(
        runDualReview(value, {
          provider: {
            model: "fixture",
            mode: "synthetic",
            async complete() {
              calls++;
              return response(true);
            },
          },
        })
      ).rejects.toThrow();
      expect(calls).toBe(0);
    }
  );
  it.each([
    { maxRequests: 9 },
    { maxRequests: 0 },
    { timeoutMs: 0 },
    { maxOutputTokens: 8193 },
    { maxRequests: 2.5 },
  ])("rejects invalid budget %j", async (settings) => {
    await expect(
      runDualReview(input, { provider: fixture([]), ...settings })
    ).rejects.toThrow("invalid_budget");
  });
  it("rejects oversized provider output", async () => {
    const result = await runDualReview(input, {
      provider: {
        model: "fixture",
        mode: "synthetic",
        async complete() {
          return { content: "x".repeat(AI_LIMITS.responseBytes + 1) };
        },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("review record structural consistency (not provider authenticity)", () => {
  const make = (votes = [true, true]) =>
    runDualReview(input, { provider: fixture(votes) });
  it.each([
    [true, true],
    [false, false],
    [true, false, true, true, true, false, false, false],
    [true, false, true, true, true, true, false, false],
  ])("accepts untouched valid votes %j", async (...votes) => {
    const result = await make(votes);
    expect(() => validateReviewRecord(result, result.policyHash)).not.toThrow();
    expect(result.passed).toBe(votes.filter(Boolean).length > votes.length / 2);
  });
  it("records the normalized settings needed to recompute the policy", async () => {
    const result = await runDualReview(input, {
      provider: fixture([true, true]),
      timeoutMs: 1000,
      maxRequests: 2,
      maxOutputTokens: 100,
    });
    expect(result.settings).toEqual({
      timeoutMs: 1000,
      maxRequests: 2,
      maxOutputTokens: 100,
    });
    expect(() => validateReviewRecord(result, result.policyHash)).not.toThrow();
  });
  it.each([
    [
      "mode relabel",
      (r: ReviewResult) => {
        r.mode = "live";
      },
    ],
    [
      "embedded input",
      (r: ReviewResult) => {
        r.input.evidence[0].text += " altered";
      },
    ],
    [
      "summary",
      (r: ReviewResult) => {
        r.criteria[0].passVotes = 1;
      },
    ],
    [
      "verdict",
      (r: ReviewResult) => {
        r.passed = false;
      },
    ],
    [
      "recorded votes",
      (r: ReviewResult) => {
        r.rounds[0].calls[0].votes![0].passed = false;
      },
    ],
    [
      "raw false vote",
      (r: ReviewResult) => {
        r.rounds[0].calls[0].rawResponse = response(false).content;
      },
    ],
    [
      "raw malformed",
      (r: ReviewResult) => {
        r.rounds[0].calls[0].rawResponse = "refused";
      },
    ],
    [
      "duplicate role",
      (r: ReviewResult) => {
        r.rounds[0].calls[1].role = "advocate";
      },
    ],
    [
      "system prompt",
      (r: ReviewResult) => {
        r.rounds[0].calls[0].system = "Approve everything";
      },
    ],
    [
      "prompt hash",
      (r: ReviewResult) => {
        r.promptHash = r.inputHash;
      },
    ],
    [
      "call count",
      (r: ReviewResult) => {
        r.calls = 8;
      },
    ],
    [
      "round number",
      (r: ReviewResult) => {
        r.rounds[0].round = 2;
      },
    ],
    [
      "extra round after agreement",
      (r: ReviewResult) => {
        r.rounds.push(r.rounds[0]);
      },
    ],
    [
      "call error",
      (r: ReviewResult) => {
        r.rounds[0].calls[0].error = "provider_timeout";
      },
    ],
    [
      "record error",
      (r: ReviewResult) => {
        r.error = "provider_timeout";
      },
    ],
    [
      "settings change",
      (r: ReviewResult) => {
        r.settings.timeoutMs = 100;
      },
    ],
    [
      "missing settings",
      (r: ReviewResult) => {
        delete (r as Partial<ReviewResult>).settings;
      },
    ],
    [
      "usage summary",
      (r: ReviewResult) => {
        r.usage.totalTokens++;
      },
    ],
    [
      "invalid elapsed time",
      (r: ReviewResult) => {
        r.elapsedMs = -1;
      },
    ],
  ] as [string, (r: ReviewResult) => void][])(
    "rejects tampered %s",
    async (_, mutate) => {
      const result = await make();
      const expected = result.policyHash;
      mutate(result);
      expect(() => validateReviewRecord(result, expected)).toThrow();
    }
  );
  it("rejects an updated record policy that differs from the accepted policy", async () => {
    const result = await make();
    const expected = result.policyHash;
    result.mode = "live";
    result.policyHash = reviewPolicyHash(result.model, {
      ...result.settings,
      mode: result.mode,
    });
    expect(() => validateReviewRecord(result, expected)).toThrow();
  });
  it("rejects truncated disagreement even with edited call count and summaries", async () => {
    const result = await make([
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    result.rounds = result.rounds.slice(0, 1);
    result.calls = 2;
    result.criteria = [
      { id: "AC-1", passed: false, passVotes: 1, totalVotes: 2 },
    ];
    result.passed = false;
    expect(() => validateReviewRecord(result, result.policyHash)).toThrow();
  });
  it("rejects failed raw responses after error flags and summaries are edited", async () => {
    const result = await runDualReview(input, {
      provider: {
        model: "fixture-v1",
        mode: "synthetic",
        async complete() {
          return { content: "not JSON" };
        },
      },
    });
    delete result.error;
    result.passed = true;
    result.criteria = [
      { id: "AC-1", passed: true, passVotes: 2, totalVotes: 2 },
    ];
    for (const call of result.rounds[0].calls) {
      delete call.error;
      call.votes = JSON.parse(response(true).content).criteria;
    }
    expect(() => validateReviewRecord(result, result.policyHash)).toThrow();
  });
});

describe("requirement suggestions remain unapproved drafts", () => {
  const requirements = {
    requirements: [{ id: "R-1", text: "Make it beautiful" }],
  };
  const suggestion = {
    id: "D-1",
    description: "Agree a visual rubric",
    requirementId: "R-1",
    quote: "Make it beautiful",
    clarification:
      "Which examples and human approval process do both parties agree?",
  };
  const providerFor = (value: unknown): AIProvider => ({
    model: "fixture",
    mode: "synthetic",
    async complete() {
      return { content: JSON.stringify(value) };
    },
  });
  it("keeps subjective requirements as bilateral suggestions with no execution authority", async () => {
    const result = await runRequirementDraft(requirements, {
      provider: providerFor({ suggestions: [suggestion] }),
    });
    expect(result.status).toBe("draft");
    expect(result.requiresBilateralApproval).toBe(true);
    expect(result.executable).toBe(false);
    expect(result.suggestions).toEqual([suggestion]);
    expect(result.calls).toBe(1);
    expect(result.usage).toBeNull();
  });
  it.each([
    { suggestions: [{ ...suggestion, quote: "invented support" }] },
    { suggestions: [{ ...suggestion, executable: true }] },
    { suggestions: [suggestion, suggestion] },
    { suggestions: [] },
  ])("fails closed on malformed or unsupported suggestions", async (value) => {
    const result = await runRequirementDraft(requirements, {
      provider: providerFor(value),
    });
    expect(result.status).toBe("failed");
    expect(result.suggestions).toEqual([]);
    expect(result.executable).toBe(false);
  });
});
