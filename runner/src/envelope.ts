import { getAddress, verifyTypedData } from "ethers";
import { domainFor, messageToJson, toMessage, VERIFICATION_RESULT_TYPES } from "./eip712";
import type { VerificationResultMessage } from "./eip712";
import { canonicalHash } from "./hash";
import { validateReviewedResult } from "./review";

/** Validate imported evidence against the reviewed result and the actual on-chain runner. */
export function validateSignedEnvelope(
  value: unknown,
  reviewedHash: string | undefined,
  chainId: bigint | number | string,
  escrowAddress: string,
  runnerAddress: string
): VerificationResultMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid signed envelope");
  const { result, domain, message, signature } = value as Record<string, unknown>;
  validateReviewedResult(result, reviewedHash);
  const expectedMessage = toMessage(result);
  if (canonicalHash(message) !== canonicalHash(messageToJson(expectedMessage))) {
    throw new Error("signed message does not match result");
  }

  const expectedDomain = domainFor(chainId, escrowAddress);
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) throw new Error("invalid signed domain");
  const d = domain as Record<string, unknown>;
  if (
    Object.keys(d).sort().join(",") !== "chainId,name,verifyingContract,version" ||
    d.name !== expectedDomain.name || d.version !== expectedDomain.version ||
    !["string", "number", "bigint"].includes(typeof d.chainId) ||
    BigInt(d.chainId as string | number | bigint) !== BigInt(chainId) ||
    typeof d.verifyingContract !== "string" ||
    getAddress(d.verifyingContract) !== getAddress(escrowAddress)
  ) {
    throw new Error("signed domain does not match target protocol/network/escrow");
  }
  if (typeof signature !== "string") throw new Error("invalid envelope signature");
  const recovered = verifyTypedData(expectedDomain, VERIFICATION_RESULT_TYPES, expectedMessage, signature);
  if (getAddress(recovered) !== getAddress(runnerAddress)) {
    throw new Error("signature is not from agreement runner");
  }
  return expectedMessage;
}
