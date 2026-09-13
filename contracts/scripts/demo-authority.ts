import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { runAcceptance } from "../../runner/src/run-tests";
import { runnerFingerprint } from "../../runner/src/policy";
import { canonicalHash } from "../../runner/src/hash";
import { runDualReview, reviewPolicyHash } from "../../runner/src/ai-review";
import { createFixtureProvider } from "../../runner/src/ai-provider";
import { createCodexProviderFromEnv } from "../../runner/src/codex-provider";
import {
  reviewInputFor,
  buildAuthorityEvidence,
} from "../../runner/src/authority-evidence";
import { sealDelivery, openDelivery } from "../../runner/src/delivery";
import { dueAction } from "../../runner/src/keeper";
import { collectSourceEvidence } from "../../runner/src/source-review";

const DAY = 86400;
const units = (s: string) => ethers.parseUnits(s, 6);
const TYPES = {
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

async function main() {
  const began = performance.now();
  const [arbiter, client, developer, runner, nextRunner, caller] =
    await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  assert.equal(
    chainId,
    31337n,
    "This demo uses PUBLIC test wallets: local chain only"
  );
  const root = path.resolve(__dirname, "../..");
  const acceptance = JSON.parse(
    fs.readFileSync(
      path.join(root, "example-deliverable/acceptance.json"),
      "utf8"
    )
  );
  // Seal every reviewed source file and the agreed criteria, not only the sample entry point.
  const source = Buffer.from(JSON.stringify(collectSourceEvidence(path.join(root, "example-deliverable"))));
  const delivery = sealDelivery(source);
  if (process.env.POD_DEMO_AI && process.env.POD_DEMO_AI !== "codex")
    throw new Error("Unknown demo AI mode");
  const liveProvider =
    process.env.POD_DEMO_AI === "codex"
      ? await createCodexProviderFromEnv()
      : undefined;
  const model = liveProvider?.model ?? "synthetic-demo-v1";
  const mode = liveProvider?.mode ?? "synthetic";
  const timeoutMs = liveProvider ? 60000 : 30000;
  const policyHash = reviewPolicyHash(model, { mode, timeoutMs });
  // Both parties approve this full manifest before deposits. The encrypted package is not a production distribution service.
  const manifest = {
    version: 1,
    acceptance,
    aiPolicyHash: policyHash,
    sourcePackageHash: delivery.packageHash,
    sourceKeyHash: delivery.keyHash,
    runnerDigest: runnerFingerprint(),
  };
  const token: any = await ethers.deployContract("MockERC20", [
    "Mock USDC",
    "USDC",
    6,
  ]);
  const escrow: any = await ethers.deployContract("AuthorityEscrow", [
    arbiter.address,
  ]);
  const address = await escrow.getAddress();
  const domain = {
    name: "AuthorityEscrow",
    version: "1",
    chainId,
    verifyingContract: address,
  };
  await token.mint(client.address, units("1000"));
  await token.mint(developer.address, units("100"));
  await token.connect(client).approve(address, units("1000"));
  await token.connect(developer).approve(address, units("100"));
  const terms = {
    developer: developer.address,
    runner: runner.address,
    token: await token.getAddress(),
    acceptanceHash: canonicalHash(manifest),
    runnerDigest: manifest.runnerDigest,
    policyHash,
    amount: units("300"),
    devBond: units("30"),
    challengeBond: units("10"),
    challengeWindow: 3 * DAY,
    deliveryDuration: 14 * DAY,
    disputeDuration: 7 * DAY,
    retentionBps: 1000,
    retentionPeriod: 30 * DAY,
    sourceKeyHash: delivery.keyHash,
  };
  const transactions: { step: string; hash: string }[] = [];
  const track = async (step: string, action: Promise<any>) => {
    const tx = await action;
    await tx.wait();
    transactions.push({ step, hash: tx.hash });
    console.log(step);
  };
  console.log(
    "PoD: LOCAL token transfers + REAL API tests and source evidence + " +
      (liveProvider ? "LIVE Codex CLI review" : "SYNTHETIC AI responses") +
      " (not a model accuracy benchmark)"
  );
  await track(
    "1. Client proposes fixed terms; developer accepts",
    escrow.connect(client).createAgreement(terms)
  );
  await track(
    "   Developer approval recorded",
    escrow.connect(developer).acceptAgreement(1)
  );
  await track(
    "2. Client deposits 300; developer deposits collateral 30",
    escrow.connect(client).fund(1)
  );
  await track(
    "   Developer collateral recorded",
    escrow.connect(developer).depositDevBond(1)
  );
  const execution = runAcceptance({
    agreementId: 1,
    milestoneIndex: 0,
    outDir: null,
    quiet: true,
  });
  assert.equal(execution.passed, true);
  const input = reviewInputFor(execution, acceptance);
  const response = {
    content: JSON.stringify({
      criteria: input.criteria.map((c) => ({
        id: c.id,
        passed: true,
        citations: [
          {
            evidenceId: c.id,
            quote: input.evidence.find((e) => e.id === c.id)!.text,
          },
        ],
      })),
    }),
  };
  const ai = await runDualReview(input, {
    provider:
      liveProvider ?? createFixtureProvider([response, response], model),
    timeoutMs,
  });
  fs.mkdirSync(path.join(root, "runner/out"), { recursive: true });
  if (liveProvider)
    fs.writeFileSync(
      path.join(root, "runner/out/authority-demo.codex.review.json"),
      JSON.stringify(ai, null, 2) + "\n"
    );
  const evidence = buildAuthorityEvidence(
    execution,
    ai,
    acceptance,
    policyHash,
    chainId
  );
  assert.equal(evidence.passed, true);
  // The verifier checks the sealed delivery privately before signing; the client gets the key only at settlement.
  assert.deepEqual(
    JSON.parse(openDelivery(delivery.envelope, delivery.key, manifest.sourceKeyHash, manifest.sourcePackageHash).toString("utf8")),
    execution.sourceEvidence
  );
  console.log(
    `3. Actual acceptance checks passed; ${ai.mode} dual-review pipeline calls=${ai.calls}`
  );
  const message = {
    agreementId: 1,
    authorityVersion: 1,
    acceptanceHash: terms.acceptanceHash,
    runnerDigest: terms.runnerDigest,
    policyHash,
    resultHash: evidence.resultHash,
    sourceHash: execution.sourceHash!,
    passed: evidence.passed,
    expiry: (await time.latest()) + DAY,
  };
  const oldSignature = await runner.signTypedData(domain, TYPES, message);
  await track(
    "4. Revoke old authority",
    escrow.connect(client).revokeAuthority(1)
  );
  await track(
    "   Client approves replacement",
    escrow.connect(client).approveAuthority(1, nextRunner.address, 3)
  );
  await track(
    "   Developer approves identical replacement",
    escrow.connect(developer).approveAuthority(1, nextRunner.address, 3)
  );
  await assert.rejects(escrow.connect(developer).revealSourceKey(1, delivery.key));
  console.log("5. Early source-key disclosure rejected; encrypted package remains sealed");
  await assert.rejects(escrow.submitResult(message, oldSignature), /binding/);
  console.log("   Old signed result rejected after authority change");
  const current = { ...message, authorityVersion: 3 };
  const signature = await nextRunner.signTypedData(domain, TYPES, current);
  await track(
    "6. Authorized result submitted",
    escrow.connect(caller).submitResult(current, signature)
  );
  await assert.rejects(escrow.connect(client).revokeAuthority(1), /authority frozen/);
  await assert.rejects(escrow.connect(developer).revealSourceKey(1, delivery.key));
  await assert.rejects(escrow.release(1), /release/);
  await time.increaseTo((await escrow.getAgreement(1)).challengeDeadline);
  assert.equal(
    dueAction(await escrow.getAgreement(1), BigInt(await time.latest())),
    null
  );
  await track(
    "7. Reveal committed key and pay 270 plus collateral 30 atomically; retain 30",
    escrow.connect(developer).revealSourceKey(1, delivery.key)
  );
  assert.deepEqual(
    openDelivery(delivery.envelope, delivery.key, manifest.sourceKeyHash, manifest.sourcePackageHash),
    source
  );
  assert.equal(await token.balanceOf(developer.address), units("370"));
  assert.equal(await token.balanceOf(address), units("30"));
  await assert.rejects(escrow.releaseRetention(1), /retention/);
  await time.increaseTo((await escrow.getAgreement(1)).retentionDeadline);
  assert.equal(
    dueAction(await escrow.getAgreement(1), BigInt(await time.latest())),
    "releaseRetention"
  );
  await track(
    "8. After 30 simulated days, remaining 30 paid",
    escrow.connect(caller).releaseRetention(1)
  );
  assert.equal(await token.balanceOf(developer.address), units("400"));
  assert.equal(await token.balanceOf(address), 0n);
  await assert.rejects(escrow.release(1), /release/);

  await track(
    "9. Second agreement: demonstrate unanswered delivery timeout",
    escrow
      .connect(client)
      .createAgreement({ ...terms, sourceKeyHash: ethers.ZeroHash })
  );
  await escrow.connect(developer).acceptAgreement(2);
  await escrow.connect(client).fund(2);
  await escrow.connect(developer).depositDevBond(2);
  await time.increaseTo((await escrow.getAgreement(2)).deliveryDeadline);
  assert.equal(
    dueAction(await escrow.getAgreement(2), BigInt(await time.latest())),
    "refundTimeout"
  );
  await track(
    "   Refund client price and developer collateral to their owners",
    escrow.connect(caller).refundTimeout(2)
  );
  assert.equal(await token.balanceOf(client.address), units("700"));
  assert.equal(await token.balanceOf(developer.address), units("400"));
  assert.equal(await token.balanceOf(address), 0n);
  const report = {
    version: 1,
    network: "hardhat-local",
    aiMode: ai.mode,
    modelAccuracyMeasured: false,
    timeTravel: true,
    manifest,
    delivery: {
      envelope: delivery.envelope,
      packageHash: delivery.packageHash,
      revealedKey: delivery.key, // Public in SourceKeyRevealed; included for offline inspection of the sample.
    },
    evidence,
    signedResult: { domain, message: current, signature },
    transactions,
    finalBalances: { client: "700", developer: "400", escrow: "0" },
    elapsedMs: performance.now() - began,
  };
  fs.mkdirSync(path.join(root, "runner/out"), { recursive: true });
  fs.writeFileSync(
    path.join(
      root,
      liveProvider
        ? "runner/out/authority-demo.codex.json"
        : "runner/out/authority-demo.json"
    ),
    JSON.stringify(
      report,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    ) + "\n"
  );
  console.table(report.finalBalances);
  console.log(
    "Evidence: " +
      (liveProvider
        ? "runner/out/authority-demo.codex.json"
        : "runner/out/authority-demo.json") +
      ". This is NOT a testnet deployment or a model accuracy benchmark."
  );
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
