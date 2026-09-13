import { getAddress, verifyTypedData, Wallet, ZeroAddress, ZeroHash } from "ethers";
import { buildAuthorityEvidence } from "./authority-evidence";
import { canonicalHash } from "./hash";
import { runnerFingerprint } from "./policy";
import type { Acceptance, RunnerResult } from "./types";
import type { ReviewResult } from "./ai-review";
import { openDelivery, type DeliveryEnvelope } from "./delivery";
import { validateSourceEvidence } from "./source-review";

export const AUTHORITY_RESULT_TYPES = {
  Result: [
    { name: "agreementId", type: "uint256" },
    { name: "authorityVersion", type: "uint256" },
    { name: "acceptanceHash", type: "bytes32" },
    { name: "runnerDigest", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "resultHash", type: "bytes32" },
    { name: "sourceHash", type: "bytes32" },
    { name: "passed", type: "bool" },
    { name: "expiry", type: "uint256" },
  ],
};

/** Decimal strings are the wire format; unsafe JS numbers are never rounded. */
export function authorityUint(value: unknown, label: string, positive = false): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`invalid ${label}`);
  if (!["string", "number", "bigint"].includes(typeof value) || !/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`invalid ${label}`);
  const n = BigInt(String(value));
  if (n >= 1n << 256n || (positive && n === 0n)) throw new Error(`invalid ${label}`);
  return n.toString();
}
export function authorityAddress(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid address");
  const address = getAddress(value);
  if (address === ZeroAddress) throw new Error("zero address");
  return address;
}
function hash(value: unknown, label: string, allowZero = false): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || (!allowZero && value.toLowerCase() === ZeroHash)) throw new Error(`invalid ${label}`);
  return value.toLowerCase();
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid authority object");
  return value as Record<string, any>;
}
function same(value: unknown, expected: unknown, label: string): void {
  if (canonicalHash(value) !== canonicalHash(expected)) throw new Error(`${label} mismatch`);
}
export function authorityDomain(chainId: bigint | number | string, escrowAddress: string) {
  return { name: "AuthorityEscrow", version: "1", chainId: authorityUint(chainId, "chain id", true), verifyingContract: authorityAddress(escrowAddress) };
}
export interface AuthorityManifest {
  version: 1;
  acceptance: Acceptance;
  aiPolicyHash: string;
  sourcePackageHash: string;
  sourceKeyHash: string;
  runnerDigest: string;
}
export interface AuthorityMessage {
  agreementId: string;
  authorityVersion: string;
  acceptanceHash: string;
  runnerDigest: string;
  policyHash: string;
  resultHash: string;
  sourceHash: string;
  passed: boolean;
  expiry: string;
}
export interface AuthorityChecks {
  acceptance: Acceptance;
  chainId: bigint | number | string;
  escrowAddress: string;
  /** Exact buildAuthorityEvidence(...).resultHash approved independently by the signer. */
  expectedReviewHash: string;
  expectedPolicyHash: string;
  now?: bigint;
}
export interface AuthoritySigningInput extends AuthorityChecks {
  execution: RunnerResult;
  ai: ReviewResult;
  manifest: AuthorityManifest;
  agreementId: bigint | number | string;
  authorityVersion: bigint | number | string;
  expiry: bigint | number | string;
  /** Signing only. Never copied into the public envelope. */
  delivery?: { envelope: DeliveryEnvelope; key: string };
}

/** Source-bound evidence is mandatory; historical execution-only evidence cannot be signed. */
export function prepareAuthorityResult(input: AuthoritySigningInput) {
  // Snapshot before any signer/RPC await so callers cannot change the signed object.
  const execution = JSON.parse(JSON.stringify(input.execution)) as RunnerResult;
  const ai = JSON.parse(JSON.stringify(input.ai)) as ReviewResult;
  const manifest = JSON.parse(JSON.stringify(input.manifest)) as AuthorityManifest;
  const acceptance = input.acceptance;
  const domain = authorityDomain(input.chainId, input.escrowAddress);
  const agreementId = authorityUint(input.agreementId, "agreement id", true);
  const authorityVersion = authorityUint(input.authorityVersion, "authority version", true);
  const expiry = authorityUint(input.expiry, "expiry", true);
  const now = input.now ?? BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(expiry) <= now) throw new Error("signature expiry must be in the future");
  const policyHash = hash(input.expectedPolicyHash, "expected policy hash");
  const reviewedHash = hash(input.expectedReviewHash, "expected review hash");
  object(acceptance); object(manifest); object(execution);
  if (manifest.version !== 1 || Object.keys(manifest).sort().join(",") !== "acceptance,aiPolicyHash,runnerDigest,sourceKeyHash,sourcePackageHash,version") throw new Error("invalid authority manifest");
  same(manifest.acceptance, acceptance, "manifest acceptance");
  if (manifest.aiPolicyHash !== policyHash) throw new Error("manifest policy mismatch");
  hash(manifest.sourcePackageHash, "source package hash", manifest.sourceKeyHash === ZeroHash);
  hash(manifest.sourceKeyHash, "source key hash", true);
  const digest = runnerFingerprint();
  if (manifest.runnerDigest !== digest || execution.runnerImageDigest !== digest) throw new Error("reviewed runner fingerprint mismatch");
  if (!Number.isSafeInteger(execution.agreementId) || authorityUint(execution.agreementId, "execution agreement", true) !== agreementId ||
      !Number.isSafeInteger(execution.milestoneIndex) || execution.milestoneIndex < 0 || execution.milestoneIndex !== acceptance.milestone ||
      !Number.isSafeInteger(execution.timestamp) || execution.timestamp < 1 || typeof execution.logUrl !== "string" || typeof execution.passed !== "boolean" ||
      !Array.isArray(execution.criteria) || execution.criteria.some(c => typeof c.passed !== "boolean" || typeof c.evidence !== "string")) throw new Error("execution metadata binding mismatch");
  const evidence = buildAuthorityEvidence(execution, ai, acceptance, policyHash, BigInt(domain.chainId));
  if (Number(evidence.version) !== 2) throw new Error("source-bound authority evidence version 2 required");
  if (evidence.resultHash !== reviewedHash) throw new Error("expected review hash mismatch");
  const message: AuthorityMessage = {
    agreementId, authorityVersion, acceptanceHash: canonicalHash(manifest), runnerDigest: digest,
    policyHash, resultHash: reviewedHash, sourceHash: hash(execution.sourceHash, "source hash"),
    passed: evidence.passed, expiry,
  };
  return { version: 1 as const, contractName: "AuthorityEscrow" as const, domain, manifest, evidence, message };
}
export type AuthorityEnvelope = ReturnType<typeof prepareAuthorityResult> & { signer: string; signature: string };

export async function signAuthorityEnvelope(input: AuthoritySigningInput, privateKey: string): Promise<AuthorityEnvelope> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("invalid AUTHORITY_PRIVATE_KEY");
  const prepared = prepareAuthorityResult(input);
  if (prepared.manifest.sourceKeyHash !== ZeroHash) {
    if (!input.delivery) throw new Error("encrypted delivery and key required before signing");
    const plaintext = openDelivery(input.delivery.envelope, input.delivery.key, prepared.manifest.sourceKeyHash, prepared.manifest.sourcePackageHash);
    const parsed = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(plaintext));
    const source = validateSourceEvidence(parsed, prepared.message.sourceHash, prepared.manifest.acceptance);
    const executedSource = validateSourceEvidence(prepared.evidence.execution.sourceEvidence, prepared.message.sourceHash, prepared.manifest.acceptance);
    same(source, executedSource, "encrypted delivery source");
  } else if (input.delivery) throw new Error("keyless manifest must omit encrypted delivery");
  const wallet = new Wallet(privateKey);
  const signature = await wallet.signTypedData(prepared.domain, AUTHORITY_RESULT_TYPES, prepared.message);
  return { ...prepared, signer: wallet.address, signature };
}

/** Rebuild all hashes from evidence; neither the embedded message nor claimed signer is trusted. */
export function validateAuthorityEnvelope(value: unknown, checks: AuthorityChecks): AuthorityEnvelope {
  const envelope = object(value);
  if (envelope.version !== 1 || envelope.contractName !== "AuthorityEscrow") throw new Error("invalid authority envelope version");
  const message = object(envelope.message);
  const evidence = object(envelope.evidence);
  // Signing requires strictly future expiry; submission follows the inclusive contract check.
  const now = checks.now ?? BigInt(Math.floor(Date.now() / 1000));
  const expiry = authorityUint(message.expiry, "expiry", true);
  if (BigInt(expiry) < now) throw new Error("authority signature expired");
  const prepared = prepareAuthorityResult({ ...checks, now: now - 1n, execution:evidence.execution, ai:evidence.ai, manifest:envelope.manifest,
    agreementId:message.agreementId, authorityVersion:message.authorityVersion, expiry });
  same(envelope.domain, prepared.domain, "authority domain");
  same(envelope.message, prepared.message, "authority message");
  same(envelope.evidence, prepared.evidence, "authority evidence");
  if (typeof envelope.signature !== "string") throw new Error("invalid authority signature");
  const signer = verifyTypedData(prepared.domain, AUTHORITY_RESULT_TYPES, prepared.message, envelope.signature);
  if (signer !== authorityAddress(envelope.signer)) throw new Error("authority signer mismatch");
  return { ...prepared, signature:envelope.signature, signer };
}

/** Compare against getAgreement at the same block used for the submission timestamp. */
export function validateAuthoritySubmission(message: AuthorityMessage, signer: string, agreement: any, now: bigint): void {
  const state = BigInt(agreement.state);
  if ((state !== 2n && state !== 7n) || agreement.revoked !== false || now >= BigInt(agreement.deliveryDeadline)) throw new Error("agreement is not open for submission");
  if (state === 7n && now < BigInt(agreement.challengeDeadline)) throw new Error("failed verdict challenge window remains open");
  if (now > BigInt(message.expiry)) throw new Error("authority signature expired");
  if (BigInt(message.authorityVersion) !== BigInt(agreement.authorityVersion)) throw new Error("authority version mismatch");
  if (authorityAddress(signer) !== authorityAddress(agreement.runner)) throw new Error("signature is not from current agreement runner");
  for (const field of ["acceptanceHash", "runnerDigest", "policyHash"] as const) {
    if (hash(message[field], field) !== hash(agreement.terms[field], field)) throw new Error(`agreement ${field} mismatch`);
  }
}
