import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { Wallet } from "ethers";
import { validateSignedEnvelope } from "../src/envelope";
import { domainFor, messageToJson, toMessage, VERIFICATION_RESULT_TYPES } from "../src/eip712";
import { canonicalHash } from "../src/hash";
import { REPO_ROOT, runnerFingerprint } from "../src/policy";
import type { Acceptance, RunnerResult } from "../src/types";

const chainId = 31337n;
const escrowAddress = "0x0000000000000000000000000000000000000001";

async function fixture() {
  const runner = Wallet.createRandom();
  const acceptance = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "example-deliverable/acceptance.json"), "utf8")
  ) as Acceptance;
  const result: RunnerResult = {
    agreementId: 1,
    milestoneIndex: 0,
    acceptanceHash: canonicalHash(acceptance),
    commitHash: "1".repeat(40),
    sourceHash: "0x" + "1".repeat(64),
    sourceCommitted: true,
    runnerImageDigest: runnerFingerprint(),
    criteria: acceptance.criteria.map(c => ({ id: c.id, passed: true, evidence: "checked" })),
    passed: true,
    timestamp: 1757600000,
    logUrl: "local",
    execution: { exitCode: 0, reportSuccess: true },
  };
  const domain = { ...domainFor(chainId, escrowAddress), chainId: String(chainId) };
  const message = messageToJson(toMessage(result));
  const signature = await runner.signTypedData(domain, VERIFICATION_RESULT_TYPES, message);
  const envelope = { result, domain, message, signature, signer: runner.address };
  const reviewedHash = canonicalHash(result);
  const validate = (hash: string | undefined = reviewedHash) =>
    validateSignedEnvelope(envelope, hash, chainId, escrowAddress, runner.address);
  return { runner, envelope, reviewedHash, validate };
}

describe("signed submission envelope", () => {
  it("returns the typed message for a valid reviewed signature", async () => {
    const { envelope, validate } = await fixture();
    expect(validate()).toEqual(toMessage(envelope.result));
  });

  it("rejects a tampered message even with a new valid runner signature", async () => {
    const { runner, envelope, validate } = await fixture();
    envelope.message.agreementId = "2";
    envelope.signature = await runner.signTypedData(envelope.domain, VERIFICATION_RESULT_TYPES, envelope.message);
    expect(() => validate()).toThrow(/message does not match result/);
  });

  it("rejects changes to result fields outside the typed message", async () => {
    const { envelope, validate } = await fixture();
    envelope.result.criteria[0].evidence = "changed after review";
    expect(() => validate()).toThrow(/REVIEWED_RESULT_HASH/);
  });

  it("rejects a newly reviewed result if the signed result hash is stale", async () => {
    const { envelope, validate } = await fixture();
    envelope.result.logUrl = "changed";
    expect(() => validate(canonicalHash(envelope.result))).toThrow(/message does not match result/);
  });

  it("rejects the wrong reviewed hash", async () => {
    const { validate } = await fixture();
    expect(() => validate("0x" + "0".repeat(64))).toThrow(/REVIEWED_RESULT_HASH/);
  });

  it("rejects a missing reviewed hash", async () => {
    const { envelope, runner } = await fixture();
    expect(() => validateSignedEnvelope(envelope, undefined, chainId, escrowAddress, runner.address))
      .toThrow(/REVIEWED_RESULT_HASH/);
  });

  it("enforces the shared committed-source review policy", async () => {
    const { envelope, validate } = await fixture();
    envelope.result.sourceCommitted = false;
    expect(() => validate(canonicalHash(envelope.result))).toThrow(/metadata|commit/);
  });

  it.each([
    ["chainId", "1"],
    ["verifyingContract", "0x0000000000000000000000000000000000000002"],
    ["name", "OtherProtocol"],
    ["version", "2"],
  ])("rejects a different domain %s even if correctly signed", async (field, value) => {
    const { runner, envelope, validate } = await fixture();
    Object.assign(envelope.domain, { [field]: value });
    envelope.signature = await runner.signTypedData(envelope.domain, VERIFICATION_RESULT_TYPES, envelope.message);
    expect(() => validate()).toThrow(/domain/);
  });

  it("rejects extra domain fields", async () => {
    const { envelope, validate } = await fixture();
    Object.assign(envelope.domain, { salt: "0x" + "0".repeat(64) });
    expect(() => validate()).toThrow(/domain/);
  });

  it("rejects an unregistered signer despite a forged signer label", async () => {
    const { envelope, validate } = await fixture();
    const attacker = Wallet.createRandom();
    envelope.signature = await attacker.signTypedData(envelope.domain, VERIFICATION_RESULT_TYPES, envelope.message);
    expect(() => validate()).toThrow(/signature is not from agreement runner/);
  });

  it("rejects a malformed signature", async () => {
    const { envelope, validate } = await fixture();
    envelope.signature = "0x1234";
    expect(() => validate()).toThrow();
  });
});
