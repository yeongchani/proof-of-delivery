import { describe, expect, it } from "vitest";
import {
  buildAuthorityEvidence,
  reviewInputFor,
  verifyHistoricalAuthorityEvidenceV1,
} from "../src/authority-evidence";
import fs from "fs";
import path from "path";
import { canonicalHash } from "../src/hash";
import { runDualReview } from "../src/ai-review";
import { createFixtureProvider } from "../src/ai-provider";
import { sourceEvidenceHash } from "../src/source-review";
import type { SourceEvidence } from "../src/types";
import type { RunnerResult } from "../src/types";

const hash = "0x" + "1".repeat(64);
const acceptance = {
  criteria: [{ id: "AC-1", desc: "health", tier: 1, test: "health" }],
  version: "1",
  agreement: "demo",
  milestone: 0,
  trigger: "all_tier1_pass",
};
const sourceEvidence: SourceEvidence = {
  version: 1,
  files: [
    { path: "acceptance.json", content: JSON.stringify(acceptance) },
    { path: "src/app.ts", content: "export const health = () => true;" },
  ],
};
const execution: RunnerResult = {
  agreementId: 1,
  milestoneIndex: 0,
  acceptanceHash: canonicalHash(acceptance),
  commitHash: "a".repeat(40),
  sourceHash: sourceEvidenceHash(sourceEvidence),
  sourceEvidence,
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
          citations: [
            { evidenceId: "AC-1", quote: input.evidence[0].text },
            {
              evidenceId: input.evidence.find((e) =>
                e.text.includes("src/app.ts")
              )!.id,
              quote: "export const health",
            },
          ],
        },
      ],
    }),
  };
  return runDualReview(input, {
    provider: createFixtureProvider([response, response]),
  });
}
describe("authority settlement evidence binding", () => {
  it("preserves archived v1 hashes only through the historical verifier", () => {
    const record = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../fixtures/codex-live/authority-demo.json"),
        "utf8"
      )
    );
    const args = [
      record.evidence.execution,
      record.evidence.ai,
      record.manifest.acceptance,
      record.manifest.aiPolicyHash,
      31337n,
    ] as const;
    expect(verifyHistoricalAuthorityEvidenceV1(...args).resultHash).toBe(
      record.signedResult.message.resultHash
    );
    expect(() => buildAuthorityEvidence(...args)).toThrow(/source/i);
  });
  it("requires actual source snapshots for new settlement evidence", async () => {
    const ai = await review();
    expect(() =>
      buildAuthorityEvidence(
        { ...execution, sourceEvidence: undefined },
        ai,
        acceptance,
        ai.policyHash,
        31337n
      )
    ).toThrow(/source/i);
  });
  it("binds actual code and its path to the AI input and rejects source substitution", async () => {
    const ai = await review();
    expect(
      ai.input.evidence.some(
        (e) =>
          e.text.includes("src/app.ts") &&
          e.text.includes("export const health")
      )
    ).toBe(true);
    const changed = structuredClone(execution);
    changed.sourceEvidence!.files[1].content =
      "export const health = () => false;";
    expect(() =>
      buildAuthorityEvidence(changed, ai, acceptance, ai.policyHash, 31337n)
    ).toThrow(/source/i);
    expect(
      buildAuthorityEvidence(execution, ai, acceptance, ai.policyHash, 31337n)
        .version
    ).toBe(2);
  });
  it("does not confuse a changed source acceptance with the agreed acceptance", () => {
    const changed = structuredClone(execution);
    changed.sourceEvidence!.files[0].content = JSON.stringify({
      ...acceptance,
      agreement: "other",
    });
    changed.sourceHash = sourceEvidenceHash(changed.sourceEvidence);
    expect(() => reviewInputFor(changed, acceptance)).toThrow(/acceptance/i);
  });
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
