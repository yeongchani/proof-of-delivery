import { describe, expect, it } from "vitest";
import {
  buildAuthorityEvidence,
  reviewInputFor,
} from "../src/authority-evidence";
import { canonicalHash } from "../src/hash";
import { runDualReview } from "../src/ai-review";
import { createFixtureProvider } from "../src/ai-provider";
import type { RunnerResult } from "../src/types";

const hash = "0x" + "1".repeat(64);
const acceptance = {
  criteria: [{ id: "AC-1", desc: "health", tier: 1, test: "health" }],
  version: "1",
  agreement: "demo",
  milestone: 0,
  trigger: "all_tier1_pass",
};
const execution: RunnerResult = {
  agreementId: 1,
  milestoneIndex: 0,
  acceptanceHash: canonicalHash(acceptance),
  commitHash: "a".repeat(40),
  sourceHash: hash,
  sourceCommitted: true,
  runnerImageDigest: hash,
  criteria: [{ id: "AC-1", passed: true, evidence: "health passed" }],
  passed: true,
  timestamp: 1234,
  logUrl: "local",
  execution: { exitCode: 0, reportSuccess: true },
};
async function review(e = execution) {
  const input = reviewInputFor(e, acceptance);
  const response = {
    content: JSON.stringify({
      criteria: [
        {
          id: "AC-1",
          passed: true,
          citations: [{ evidenceId: "AC-1", quote: input.evidence[0].text }],
        },
      ],
    }),
  };
  return runDualReview(input, {
    provider: createFixtureProvider([response, response]),
  });
}
describe("authority settlement evidence binding", () => {
  it("binds execution and AI evidence and labels local synthetic mode", async () => {
    const ai = await review();
    const result = buildAuthorityEvidence(
      execution,
      ai,
      acceptance,
      ai.policyHash,
      31337n
    );
    expect(result.passed).toBe(true);
    expect(result.mode).toBe("synthetic");
    expect(result.resultHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("never uses synthetic review or a relabeled synthetic record for a public chain", async () => {
    const ai = await review();
    expect(() =>
      buildAuthorityEvidence(execution, ai, acceptance, ai.policyHash, 421614n)
    ).toThrow();
    expect(() =>
      buildAuthorityEvidence(
        execution,
        { ...ai, mode: "live" },
        acceptance,
        ai.policyHash,
        421614n
      )
    ).toThrow();
  });
  it("rejects embedded input, hash or policy substitution and uncommitted input", async () => {
    const ai = await review();
    expect(() =>
      buildAuthorityEvidence(
        execution,
        { ...ai, inputHash: "bad" },
        acceptance,
        ai.policyHash,
        31337n
      )
    ).toThrow();
    expect(() =>
      buildAuthorityEvidence(
        execution,
        {
          ...ai,
          input: { ...ai.input, evidence: [{ id: "AC-1", text: "other" }] },
        },
        acceptance,
        ai.policyHash,
        31337n
      )
    ).toThrow();
    expect(() =>
      buildAuthorityEvidence(execution, ai, acceptance, "bad", 31337n)
    ).toThrow();
    expect(() =>
      buildAuthorityEvidence(
        { ...execution, sourceCommitted: false },
        ai,
        acceptance,
        ai.policyHash,
        31337n
      )
    ).toThrow();
  });
  it("does not allow an AI pass to override failed execution", async () => {
    const failed = {
      ...execution,
      passed: false,
      execution: { exitCode: 1, reportSuccess: false },
    };
    const ai = await review(failed);
    expect(
      buildAuthorityEvidence(failed, ai, acceptance, ai.policyHash, 31337n)
        .passed
    ).toBe(false);
  });
  it("rejects altered vote summaries before signing evidence", async () => {
    const ai = await review();
    const altered = {
      ...ai,
      criteria: ai.criteria.map((c) => ({ ...c, passVotes: 0 })),
    };
    expect(() =>
      buildAuthorityEvidence(
        execution,
        altered,
        acceptance,
        ai.policyHash,
        31337n
      )
    ).toThrow();
  });
});
