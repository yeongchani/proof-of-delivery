import { canonicalHash } from "./hash";
import type { Acceptance, RunnerResult } from "./types";
import type { ReviewInput, ReviewResult } from "./ai-review";
import { validateReviewRecord } from "./ai-review";

/** Deliberately limited to agreed criteria and captured output, with no account identities or secrets. */
export function reviewInputFor(
  execution: RunnerResult,
  acceptance: Acceptance
): ReviewInput {
  return {
    criteria: acceptance.criteria.map((c) => ({
      id: c.id,
      description: c.desc,
    })),
    evidence: execution.criteria.map((c) => ({
      id: c.id,
      text: JSON.stringify({ passed: c.passed, evidence: c.evidence }),
    })),
  };
}

/** Local validation before a trusted signer reviews the hash. This is not runtime attestation. */
export function buildAuthorityEvidence(
  execution: RunnerResult,
  ai: ReviewResult,
  acceptance: Acceptance,
  expectedPolicyHash: string,
  chainId: bigint
) {
  validateReviewRecord(ai, expectedPolicyHash);
  if (
    execution.sourceCommitted !== true ||
    !/^0x[0-9a-f]{64}$/.test(execution.sourceHash ?? "") ||
    !/^[0-9a-f]{40}$/.test(execution.commitHash) ||
    /^0+$/.test(execution.commitHash)
  )
    throw new Error("committed source evidence required");
  if (execution.acceptanceHash !== canonicalHash(acceptance))
    throw new Error("acceptance substitution");
  if (
    ai.inputHash !== canonicalHash(reviewInputFor(execution, acceptance)) ||
    ai.policyHash !== expectedPolicyHash
  )
    throw new Error("AI input or policy substitution");
  if (ai.mode !== "live" && ai.mode !== "synthetic")
    throw new Error("unknown AI mode");
  if (ai.mode === "synthetic" && chainId !== 31337n)
    throw new Error("synthetic AI evidence is local-demo-only");
  const required = acceptance.criteria.filter((c) => c.tier === 1);
  const criteriaValid =
    new Set(acceptance.criteria.map((c) => c.id)).size ===
      acceptance.criteria.length &&
    acceptance.criteria.length > 0 &&
    execution.criteria.length === acceptance.criteria.length &&
    ai.criteria.length === acceptance.criteria.length &&
    acceptance.criteria.every(
      (c) =>
        execution.criteria.filter((x) => x.id === c.id).length === 1 &&
        ai.criteria.filter((x) => x.id === c.id).length === 1
    );
  if (!criteriaValid)
    throw new Error("incomplete or duplicate criteria evidence");
  const passed =
    execution.passed === true &&
    execution.execution?.exitCode === 0 &&
    execution.execution.reportSuccess === true &&
    required.length > 0 &&
    required.every(
      (c) => execution.criteria.find((x) => x.id === c.id)?.passed === true
    ) &&
    ai.passed === true &&
    !ai.error &&
    ai.criteria.every((c) => c.passed === true);
  const evidence = { version: 1, execution, ai, passed, mode: ai.mode };
  return { ...evidence, resultHash: canonicalHash(evidence) };
}
