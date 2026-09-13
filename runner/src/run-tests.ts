/**
 * Runner step 1: execute the deliverable's acceptance tests and produce result.json.
 *
 *   npm run runner:test   (from repo root)  ->  runner/out/result.json
 *
 * Env: AGREEMENT_ID (default 1), MILESTONE_INDEX (default 0),
 *      RUNNER_IMAGE_DIGEST (optional assertion of the reviewed source fingerprint).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { REPO_ROOT, runnerFingerprint, testSuiteHash } from "./policy";
import { sourceProvenance } from "./provenance";
import { canonicalHash } from "./hash";
import type { Acceptance, CriterionResult, RunnerResult, VitestReport } from "./types";

export type { Acceptance, CriterionResult, RunnerResult } from "./types";

export const DEFAULT_RUNNER_IMAGE_DIGEST = runnerFingerprint();
export const DELIVERABLE_DIR = path.resolve(__dirname, "..", "..", "example-deliverable");
export const OUT_DIR = path.resolve(__dirname, "..", "out");

/** Require one exact match per criterion, and a successful overall report. */
export function matchCriteria(
  acceptance: Acceptance,
  report: VitestReport
): { criteria: CriterionResult[]; passed: boolean } {
  if (acceptance.trigger !== "all_tier1_pass") throw new Error("unsupported acceptance trigger");
  const ids = new Set<string>();
  for (const c of acceptance.criteria) {
    if (!c.id || ids.has(c.id) || !c.test?.trim() || !Number.isInteger(c.tier) || c.tier < 1) {
      throw new Error("invalid or duplicate acceptance criterion");
    }
    ids.add(c.id);
  }
  const assertions = report.testResults.flatMap((file) => file.assertionResults);
  const criteria = acceptance.criteria.map((c) => {
    const hits = assertions.filter((a) => a.fullName === c.test || a.title === c.test);
    if (hits.length === 0) return { id: c.id, passed: false, evidence: "no matching test" };
    if (hits.length !== 1) return { id: c.id, passed: false, evidence: "ambiguous test name" };
    const hit = hits[0];
    const ok = hit.status === "passed";
    const ms = Math.round(hit.duration ?? 0);
    const observation = hit.meta?.podEvidence;
    if (observation !== undefined) {
      if (typeof observation !== "string" || !observation.trim() || Buffer.byteLength(observation) > 4096)
        return { id: c.id, passed: false, evidence: "invalid or oversized HTTP observation" };
      try {
        const captured = JSON.parse(observation);
        if (!captured || typeof captured !== "object" || Array.isArray(captured)) throw new Error("invalid_observation");
        return {
          id: c.id, passed: ok,
          evidence: JSON.stringify({ test: hit.title ?? c.test, status: hit.status, durationMs: ms, observation: captured }),
        };
      } catch {
        return { id: c.id, passed: false, evidence: "invalid HTTP observation JSON" };
      }
    }
    return { id: c.id, passed: ok, evidence: `${hit.title ?? c.test} ${ok ? "✓" : "✗"} ${ms}ms` };
  });
  const tier1 = criteria.filter((_, i) => acceptance.criteria[i].tier === 1);
  const passed =
    report.success !== false && !(report.numFailedTestSuites! > 0) && tier1.length > 0 && tier1.every((r) => r.passed);
  return { criteria, passed };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function logUrl(): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return "local";
}

export interface RunOptions {
  deliverableDir?: string;
  /** null = do not write result.json */
  outDir?: string | null;
  agreementId?: number;
  milestoneIndex?: number;
  runnerImageDigest?: string;
  /** capture test output instead of streaming it */
  quiet?: boolean;
}

/** Execute the reviewed suite directly; never execute a candidate package script/config. */
export function runAcceptance(opts: RunOptions = {}): RunnerResult {
  const deliverableDir = opts.deliverableDir ?? DELIVERABLE_DIR;
  const outDir = opts.outDir === undefined ? OUT_DIR : opts.outDir;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of ["result.json", "result.signed.json"]) fs.rmSync(path.join(outDir, file), { force: true });
  }
  const acceptance = readJson<Acceptance>(path.join(deliverableDir, "acceptance.json"));
  const trustedAcceptance = readJson<Acceptance>(path.join(DELIVERABLE_DIR, "acceptance.json"));
  const provenance = sourceProvenance(deliverableDir);
  if (acceptance.testSuiteHash !== testSuiteHash() || canonicalHash(acceptance) !== canonicalHash(trustedAcceptance)) {
    throw new Error("acceptance/test suite differs from the reviewed policy; agree a new hash before running");
  }
  const digest = runnerFingerprint();
  const requestedDigest = opts.runnerImageDigest || process.env.RUNNER_IMAGE_DIGEST;
  if (requestedDigest && requestedDigest !== digest)
    throw new Error("runner fingerprint differs from configured digest");
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-report-"));
  const reportFile = path.join(reportDir, "report.json");
  // No signing credentials in the child. This is NOT an OS sandbox: run candidate code only in a disposable, secret-free host.
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "CI"]) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  childEnv.POD_DELIVERABLE_DIR = path.resolve(deliverableDir);
  let exitCode: number | null = null;
  let report: VitestReport = { success: false, testResults: [] };
  try {
    const proc = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        path.join(REPO_ROOT, "runner/acceptance/vitest.config.ts"),
        "--reporter=json",
        "--outputFile",
        reportFile,
      ],
      {
        cwd: REPO_ROOT,
        env: childEnv,
        encoding: "utf8",
        timeout: 20000,
        stdio: opts.quiet ? "pipe" : "inherit",
      }
    );
    exitCode = proc.status;
    if (fs.existsSync(reportFile)) report = readJson<VitestReport>(reportFile);
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
  const { criteria, passed: criteriaPassed } = matchCriteria(acceptance, report);
  const passed = exitCode === 0 && report.success === true && criteriaPassed;
  const result: RunnerResult = {
    agreementId: opts.agreementId ?? Number(process.env.AGREEMENT_ID ?? 1),
    milestoneIndex: opts.milestoneIndex ?? Number(process.env.MILESTONE_INDEX ?? 0),
    acceptanceHash: canonicalHash(acceptance),
    ...provenance,
    runnerImageDigest: digest,
    criteria,
    passed,
    timestamp: Math.floor(Date.now() / 1000),
    logUrl: logUrl(),
    execution: { exitCode, reportSuccess: report.success === true },
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}

if (require.main === module) {
  const result = runAcceptance();
  for (const c of result.criteria) console.log(`  ${c.passed ? "PASS" : "FAIL"} ${c.id}  ${c.evidence}`);
  console.log(`[runner] passed=${result.passed} commit=${result.commitHash.slice(0, 7)}`);
  console.log(`[runner] acceptanceHash=${result.acceptanceHash}`);
  console.log(`[runner] resultHash=${canonicalHash(result)}`);
  console.log(`[runner] sourceHash=${result.sourceHash} committed=${result.sourceCommitted}`);
  console.log(`[runner] wrote ${path.join(OUT_DIR, "result.json")}`);

  // GitHub Actions job summary (markdown), if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = result.criteria.map((c) => `| ${c.id} | ${c.passed ? "PASS" : "FAIL"} | ${c.evidence} |`).join("\n");
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Proof of Delivery — verification ${result.passed ? "PASSED" : "FAILED"}\n\n` +
        `commit \`${result.commitHash}\`  \nacceptanceHash \`${result.acceptanceHash}\`  \nresultHash \`${canonicalHash(
          result
        )}\`\n\n` +
        `| criterion | passed | evidence |\n|---|---|---|\n${rows}\n`
    );
  }
  // A failed verdict is still a valid, signable result (VerificationFailed on-chain) — do not fail the job here.
}
