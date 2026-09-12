/**
 * Runner step 1: execute the deliverable's acceptance tests and produce result.json.
 *
 *   npm run runner:test   (from repo root)  ->  runner/out/result.json
 *
 * Env: AGREEMENT_ID (default 1), MILESTONE_INDEX (default 0),
 *      RUNNER_IMAGE_DIGEST (default keccak256("pod-runner:v0")).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { id as keccakId } from "ethers";
import { canonicalHash } from "./hash";
import type { Acceptance, CriterionResult, RunnerResult, VitestReport } from "./types";

export type { Acceptance, CriterionResult, RunnerResult } from "./types";

export const DEFAULT_RUNNER_IMAGE_DIGEST = keccakId("pod-runner:v0");
export const DELIVERABLE_DIR = path.resolve(__dirname, "..", "..", "example-deliverable");
export const OUT_DIR = path.resolve(__dirname, "..", "out");

/** Map each acceptance criterion to a test (substring match on the test's full name). trigger: all_tier1_pass. */
export function matchCriteria(
  acceptance: Acceptance,
  report: VitestReport,
): { criteria: CriterionResult[]; passed: boolean } {
  const assertions = report.testResults.flatMap((file) => file.assertionResults);
  const criteria = acceptance.criteria.map((c) => {
    const needle = c.test.toLowerCase();
    const hit = assertions.find((a) => (a.fullName ?? a.title ?? "").toLowerCase().includes(needle));
    if (!hit) return { id: c.id, passed: false, evidence: "no matching test" };
    const ok = hit.status === "passed";
    const ms = Math.round(hit.duration ?? 0);
    return { id: c.id, passed: ok, evidence: `${hit.title ?? c.test} ${ok ? "✓" : "✗"} ${ms}ms` };
  });
  const tier1 = criteria.filter((_, i) => acceptance.criteria[i].tier === 1);
  const passed = tier1.length > 0 && tier1.every((r) => r.passed);
  return { criteria, passed };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function gitHead(cwd: string): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi && /^[0-9a-f]{40}$/.test(fromCi)) return fromCi;
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const sha = (r.stdout ?? "").trim();
  if (r.status === 0 && /^[0-9a-f]{40}$/.test(sha)) return sha;
  console.warn("[runner] git HEAD unavailable, using zero commit");
  return "0".repeat(40);
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

/** Run `npm test` in the deliverable, parse test-results.json, build result.json. */
export function runAcceptance(opts: RunOptions = {}): RunnerResult {
  const deliverableDir = opts.deliverableDir ?? DELIVERABLE_DIR;
  const outDir = opts.outDir === undefined ? OUT_DIR : opts.outDir;
  const acceptance = readJson<Acceptance>(path.join(deliverableDir, "acceptance.json"));
  const reportFile = path.join(deliverableDir, "test-results.json");
  if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);

  const proc = spawnSync("npm", ["test"], {
    cwd: deliverableDir,
    shell: true,
    encoding: "utf8",
    stdio: opts.quiet ? "pipe" : "inherit",
  });
  if (!fs.existsSync(reportFile)) {
    throw new Error(`test run produced no ${reportFile} (exit ${proc.status})\n${proc.stderr ?? ""}`);
  }

  const { criteria, passed } = matchCriteria(acceptance, readJson<VitestReport>(reportFile));
  const result: RunnerResult = {
    agreementId: opts.agreementId ?? Number(process.env.AGREEMENT_ID ?? 1),
    milestoneIndex: opts.milestoneIndex ?? Number(process.env.MILESTONE_INDEX ?? 0),
    acceptanceHash: canonicalHash(acceptance),
    commitHash: gitHead(deliverableDir),
    runnerImageDigest: opts.runnerImageDigest ?? process.env.RUNNER_IMAGE_DIGEST ?? DEFAULT_RUNNER_IMAGE_DIGEST,
    criteria,
    passed,
    timestamp: Math.floor(Date.now() / 1000),
    logUrl: logUrl(),
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
  console.log(`[runner] wrote ${path.join(OUT_DIR, "result.json")}`);
  process.exit(result.passed ? 0 : 1);
}
