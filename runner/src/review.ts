import fs from "fs";
import path from "path";
import { canonicalHash } from "./hash";
import { REPO_ROOT, runnerFingerprint, testSuiteHash } from "./policy";
import type { Acceptance, RunnerResult } from "./types";

/** A human-reviewed hash is an explicit authorization boundary, not proof of honest execution. */
export function validateReviewedResult(
  value: unknown,
  reviewedHash: string | undefined
): asserts value is RunnerResult {
  if (
    !reviewedHash ||
    !/^0x[0-9a-fA-F]{64}$/.test(reviewedHash) ||
    canonicalHash(value) !== reviewedHash.toLowerCase()
  ) {
    throw new Error("REVIEWED_RESULT_HASH must match the exact result reviewed in a separate, trusted environment");
  }
  const r = value as RunnerResult;
  const acceptance = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "example-deliverable/acceptance.json"), "utf8")
  ) as Acceptance;
  if (
    acceptance.testSuiteHash !== testSuiteHash() ||
    r.acceptanceHash !== canonicalHash(acceptance) ||
    r.runnerImageDigest !== runnerFingerprint()
  ) {
    throw new Error("result does not match the reviewed acceptance/runner policy");
  }
  if (
    !Number.isSafeInteger(r.agreementId) ||
    r.agreementId < 1 ||
    !Number.isSafeInteger(r.milestoneIndex) ||
    r.milestoneIndex < 0 ||
    !Number.isSafeInteger(r.timestamp) ||
    r.timestamp < 1 ||
    typeof r.commitHash !== "string" ||
    !/^[0-9a-f]{40}$/.test(r.commitHash) ||
    /^0+$/.test(r.commitHash) ||
    r.sourceCommitted !== true ||
    typeof r.sourceHash !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(r.sourceHash) ||
    typeof r.passed !== "boolean" ||
    typeof r.logUrl !== "string" ||
    !Array.isArray(r.criteria) ||
    r.criteria.length !== acceptance.criteria.length
  ) {
    throw new Error("invalid result metadata or unknown commit");
  }
  for (const c of acceptance.criteria) {
    const matches = r.criteria.filter((x) => x.id === c.id);
    if (matches.length !== 1 || typeof matches[0].passed !== "boolean" || typeof matches[0].evidence !== "string")
      throw new Error("invalid criterion results");
  }
  if (
    !r.execution ||
    !(r.execution.exitCode === null || (Number.isInteger(r.execution.exitCode) && r.execution.exitCode >= 0)) ||
    typeof r.execution.reportSuccess !== "boolean"
  ) {
    throw new Error("missing execution status");
  }
  const tier1 = acceptance.criteria.filter((c) => c.tier === 1);
  const expectedPass =
    r.execution.exitCode === 0 &&
    r.execution.reportSuccess &&
    tier1.length > 0 &&
    tier1.every((c) => r.criteria.find((x) => x.id === c.id)!.passed);
  if (r.passed !== expectedPass) throw new Error("verdict contradicts execution/criterion results");
}
