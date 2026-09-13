import type { Signer, TypedDataDomain, TypedDataField } from "ethers";
import { canonicalHash, commitToBytes32 } from "./hash";
import type { RunnerResult } from "./types";

export const EIP712_NAME = "ProofOfDelivery";
export const EIP712_VERSION = "1";

export const VERIFICATION_RESULT_TYPES: Record<string, TypedDataField[]> = {
  VerificationResult: [
    { name: "agreementId", type: "uint256" },
    { name: "milestoneIndex", type: "uint256" },
    { name: "acceptanceHash", type: "bytes32" },
    { name: "commitHash", type: "bytes32" },
    { name: "runnerImageDigest", type: "bytes32" },
    { name: "resultHash", type: "bytes32" },
    { name: "passed", type: "bool" },
    { name: "timestamp", type: "uint64" },
  ],
};

/** Mirrors `IMilestoneEscrow.VerificationResult`. */
export interface VerificationResultMessage {
  agreementId: bigint;
  milestoneIndex: bigint;
  acceptanceHash: string;
  commitHash: string;
  runnerImageDigest: string;
  resultHash: string;
  passed: boolean;
  timestamp: bigint;
}

export function domainFor(chainId: bigint | number | string, verifyingContract: string): TypedDataDomain {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId: BigInt(chainId), verifyingContract };
}

/** result.json -> EIP-712 struct. resultHash = canonicalHash(result), commitHash = left-padded bytes32. */
export function toMessage(result: RunnerResult): VerificationResultMessage {
  return {
    agreementId: BigInt(result.agreementId),
    milestoneIndex: BigInt(result.milestoneIndex),
    acceptanceHash: result.acceptanceHash,
    commitHash: commitToBytes32(result.commitHash),
    runnerImageDigest: result.runnerImageDigest,
    resultHash: canonicalHash(result),
    passed: result.passed,
    timestamp: BigInt(result.timestamp),
  };
}

export async function signResultMessage(
  signer: Signer,
  chainId: bigint | number | string,
  verifyingContract: string,
  message: VerificationResultMessage
): Promise<string> {
  return signer.signTypedData(domainFor(chainId, verifyingContract), VERIFICATION_RESULT_TYPES, message);
}

/** JSON-safe form of the message (bigint -> string) for result.signed.json. */
export function messageToJson(m: VerificationResultMessage): Record<string, string | boolean> {
  return {
    agreementId: m.agreementId.toString(),
    milestoneIndex: m.milestoneIndex.toString(),
    acceptanceHash: m.acceptanceHash,
    commitHash: m.commitHash,
    runnerImageDigest: m.runnerImageDigest,
    resultHash: m.resultHash,
    passed: m.passed,
    timestamp: m.timestamp.toString(),
  };
}

export function messageFromJson(j: Record<string, string | boolean>): VerificationResultMessage {
  return {
    agreementId: BigInt(j.agreementId as string),
    milestoneIndex: BigInt(j.milestoneIndex as string),
    acceptanceHash: j.acceptanceHash as string,
    commitHash: j.commitHash as string,
    runnerImageDigest: j.runnerImageDigest as string,
    resultHash: j.resultHash as string,
    passed: j.passed as boolean,
    timestamp: BigInt(j.timestamp as string),
  };
}
