/** Acceptance criteria file (example-deliverable/acceptance.json). Its canonical keccak256 is the on-chain acceptanceHash. */
export interface Criterion {
  id: string;
  tier: number;
  desc: string;
  /** substring matched against the test's full name */
  test: string;
}

export interface Acceptance {
  version: string;
  agreement: string;
  milestone: number;
  criteria: Criterion[];
  trigger: "all_tier1_pass" | string;
}

export interface CriterionResult {
  id: string;
  passed: boolean;
  evidence: string;
}

/** result.json produced by the runner. Its canonical keccak256 is the on-chain resultHash. */
export interface RunnerResult {
  agreementId: number;
  milestoneIndex: number;
  acceptanceHash: string;
  /** 40-hex git commit (git rev-parse HEAD) */
  commitHash: string;
  runnerImageDigest: string;
  criteria: CriterionResult[];
  passed: boolean;
  timestamp: number;
  logUrl: string;
}

/** Subset of the vitest JSON reporter output that the runner consumes. */
export interface VitestAssertion {
  fullName?: string;
  title?: string;
  status: string;
  duration?: number | null;
}

export interface VitestReport {
  testResults: { name?: string; assertionResults: VitestAssertion[] }[];
}
