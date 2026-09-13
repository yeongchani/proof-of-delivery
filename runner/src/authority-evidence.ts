import { canonicalHash } from "./hash";
import type { Acceptance, RunnerResult } from "./types";
import type { ReviewInput, ReviewResult } from "./ai-review";
import { validateReviewInput, validateReviewRecord } from "./ai-review";
import { validateSourceEvidence } from "./source-review";

function historicalInputFor(
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

/** Both roles receive the same actual source snapshot; comments and code are untrusted evidence. */
export function reviewInputFor(
  execution: RunnerResult,
  acceptance: Acceptance
): ReviewInput {
  const source = validateSourceEvidence(
    execution.sourceEvidence,
    execution.sourceHash ?? "",
    acceptance
  );
  const input = historicalInputFor(execution, acceptance);
  const ids = new Set(input.evidence.map((e) => e.id));
  let index = 0;
  for (const file of source.files) {
    let id: string;
    do {
      id = `source-${String(++index).padStart(3, "0")}`;
    } while (ids.has(id));
    ids.add(id);
    input.evidence.push({
      id,
      text: JSON.stringify({
        kind: "untrusted-source",
        path: file.path,
        content: file.content,
      }),
    });
  }
  // No silent truncation of files, escaped content, criteria, or aggregate input.
  return validateReviewInput(input);
}

/** Local validation before a trusted signer reviews the hash. This is not runtime attestation. */
export function buildAuthorityEvidence(
  execution: RunnerResult,
  ai: ReviewResult,
  acceptance: Acceptance,
  expectedPolicyHash: string,
  chainId: bigint
) {
  return buildEvidence(
    execution,
    ai,
    acceptance,
    expectedPolicyHash,
    chainId,
    false
  );
}

/** Archive-only verification of v1 records. Never use this function to authorize a new settlement. */
export function verifyHistoricalAuthorityEvidenceV1(
  execution: RunnerResult,
  ai: ReviewResult,
  acceptance: Acceptance,
  expectedPolicyHash: string,
  chainId: bigint
) {
  if (execution.sourceEvidence !== undefined)
    throw new Error("historical v1 records do not contain source snapshots");
  return buildEvidence(
    execution,
    ai,
    acceptance,
    expectedPolicyHash,
    chainId,
    true
  );
}

function buildEvidence(
  execution: RunnerResult,
  ai: ReviewResult,
  acceptance: Acceptance,
  expectedPolicyHash: string,
  chainId: bigint,
  historical: boolean
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
    ai.inputHash !==
      canonicalHash(
        historical
          ? historicalInputFor(execution, acceptance)
          : reviewInputFor(execution, acceptance)
      ) ||
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
  const evidence = {
    version: historical ? 1 : 2,
    execution,
    ai,
    passed,
    mode: ai.mode,
  };
  return { ...evidence, resultHash: canonicalHash(evidence) };
}
