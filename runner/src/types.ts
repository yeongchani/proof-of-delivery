/** Acceptance criteria file (example-deliverable/acceptance.json). Its canonical keccak256 is the on-chain acceptanceHash. */
export interface Criterion {
  id: string;
  tier: number;
  desc: string;
  /** Exact title or full test name; multiple matches are rejected. */
  test: string;
}

export interface Acceptance {
  version: string;
  agreement: string;
  milestone: number;
  criteria: Criterion[];
  trigger: "all_tier1_pass" | string;
  testSuiteHash?: string;
}

export interface CriterionResult {
  id: string;
  passed: boolean;
  evidence: string;
}

/** Complete, bounded UTF-8 snapshot of the provenance inputs; never truncated. */
export interface SourceEvidence {
  version: 1;
  files: { path: string; content: string }[];
}

/** result.json produced by the runner. Its canonical keccak256 is the on-chain resultHash. */
export interface RunnerResult {
  agreementId: number;
  milestoneIndex: number;
  acceptanceHash: string;
  /** 40-hex git commit (git rev-parse HEAD) */
  commitHash: string;
  sourceHash?: string;
  sourceCommitted?: boolean;
  sourceEvidence?: SourceEvidence;
  runnerImageDigest: string;
  criteria: CriterionResult[];
  passed: boolean;
  timestamp: number;
  logUrl: string;
  execution?: { exitCode: number | null; reportSuccess: boolean };
}

/** Subset of the vitest JSON reporter output that the runner consumes. */
export interface VitestAssertion {
  meta?: { podEvidence?: unknown };
  fullName?: string;
  title?: string;
  status: string;
  duration?: number | null;
}

export interface VitestReport {
  success?: boolean;
  numFailedTestSuites?: number;
  testResults: { name?: string; assertionResults: VitestAssertion[] }[];
}
