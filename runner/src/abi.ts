/** Minimal human-readable ABI for MilestoneEscrow (only what the runner needs). */
export const ESCROW_ABI = [
  "function submitResult(uint256 agreementId, uint256 index, (uint256 agreementId, uint256 milestoneIndex, bytes32 acceptanceHash, bytes32 commitHash, bytes32 runnerImageDigest, bytes32 resultHash, bool passed, uint64 timestamp) r, bytes runnerSignature)",
  "function getAgreement(uint256 agreementId) view returns ((address client, address developer, address runner, bytes32 runnerImageDigest, address token, uint64 challengeWindow, uint256 challengeBond, uint256 milestoneCount, bool terminated))",
  "function getMilestone(uint256 agreementId, uint256 index) view returns ((uint256 amount, bytes32 acceptanceHash, uint8 state, bytes32 resultHash, bytes32 commitHash, uint64 submittedAt, address challenger))",
  "function releasableAt(uint256 agreementId, uint256 index) view returns (uint64)",
  "event VerificationSubmitted(uint256 indexed agreementId, uint256 indexed index, bytes32 commitHash, bytes32 resultHash, uint64 releasableAt)",
  "event VerificationFailed(uint256 indexed agreementId, uint256 indexed index, bytes32 commitHash, bytes32 resultHash)",
];

export const MILESTONE_STATES = ["Unfunded", "Funded", "Submitted", "Challenged", "Released", "Refunded"] as const;
