import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { Wallet, verifyTypedData } from "ethers";
import { canonicalHash } from "../src/hash";
import { runnerFingerprint } from "../src/policy";
import { VERIFICATION_RESULT_TYPES } from "../src/eip712";

const root = path.resolve(__dirname, "../..");
const acceptance = JSON.parse(fs.readFileSync(path.join(root, "example-deliverable/acceptance.json"), "utf8"));
function sign(overrides: Record<string, unknown> = {}, reviewed = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-sign-test-"));
  const result = {
    agreementId: 1,
    milestoneIndex: 0,
    acceptanceHash: canonicalHash(acceptance),
    commitHash: "1".repeat(40),
    sourceHash: "0x" + "1".repeat(64),
    sourceCommitted: true,
    runnerImageDigest: runnerFingerprint(),
    criteria: acceptance.criteria.map((c: { id: string }) => ({ id: c.id, passed: true, evidence: "checked" })),
    passed: true,
    timestamp: 1757600000,
    logUrl: "local",
    execution: { exitCode: 0, reportSuccess: true },
    ...overrides,
  };
  const input = path.join(dir, "result.json"),
    output = path.join(dir, "result.signed.json");
  fs.writeFileSync(input, JSON.stringify(result));
  const env = {
    ...process.env,
    RESULT_FILE: input,
    SIGNED_RESULT_FILE: output,
    RUNNER_PRIVATE_KEY: Wallet.createRandom().privateKey,
    CHAIN_ID: "31337",
    ESCROW_ADDRESS: "0x0000000000000000000000000000000000000001",
    REVIEWED_RESULT_HASH: reviewed ? canonicalHash(result) : "",
  };
  const proc = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "runner/src/sign.ts")],
    { cwd: root, encoding: "utf8", env }
  );
  const signed = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: proc.status, signed, stderr: proc.stderr };
}
describe("reviewed result signing", () => {
  it("refuses a configured signing request without the reviewed result hash", () => {
    expect(sign({}, false).status).not.toBe(0);
  });
  it("refuses a successful verdict if execution failed", () => {
    expect(sign({ execution: { exitCode: 1, reportSuccess: false } }).status).not.toBe(0);
  });
  it("refuses a result from a different verification policy", () => {
    expect(sign({ runnerImageDigest: "0x" + "0".repeat(64) }).status).not.toBe(0);
  });
  it("refuses unknown commits", () => {
    expect(sign({ commitHash: "0".repeat(40) }).status).not.toBe(0);
  });
  it("refuses results for source changes not committed to Git", () => {
    expect(sign({ sourceCommitted: false }).status).not.toBe(0);
  });
  it("signs only the reviewed result and the signature recovers its actual signer", () => {
    const { status, signed, stderr } = sign();
    expect(status, stderr).toBe(0);
    expect(signed).not.toBeNull();
    expect(verifyTypedData(signed.domain, VERIFICATION_RESULT_TYPES, signed.message, signed.signature)).toBe(
      signed.signer
    );
  });
});
