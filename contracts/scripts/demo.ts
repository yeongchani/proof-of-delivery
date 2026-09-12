/**
 * End-to-end Proof of Delivery demo on the in-process Hardhat network.
 *
 *   npm run demo   (from repo root)
 *
 * Milestone 0: fund -> runner verifies (real tests) -> submit -> window passes -> auto release.
 * Milestone 1: fund -> submit -> client challenges -> arbiter rules for client -> refund + bond back.
 */
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import fs from "fs";
import path from "path";
import { canonicalHash } from "../../runner/src/hash";
import { runAcceptance, DEFAULT_RUNNER_IMAGE_DIGEST } from "../../runner/src/run-tests";
import { signResultMessage, toMessage } from "../../runner/src/eip712";

const STATES = ["Unfunded", "Funded", "Submitted", "Challenged", "Released", "Refunded"];
const USDC = (n: string) => ethers.parseUnits(n, 6);
const fmt = (x: bigint) => ethers.formatUnits(x, 6);
const short = (h: string) => h.slice(0, 10) + "…";
const WINDOW = 3 * 24 * 60 * 60; // 3 days
const BOND = USDC("50");
const AMOUNTS = [USDC("300"), USDC("200")];

function step(n: number, msg: string, tx?: { hash: string }) {
  console.log(`[${n}] ${msg}${tx ? `\n    tx ${tx.hash}` : ""}`);
}

function revertName(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /custom error '([A-Za-z0-9_]+)\(\)'/.exec(msg)?.[1] ?? msg.split("\n")[0];
}

async function main() {
  const t0 = Date.now();
  const [arbiter, client, developer, runner] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  console.log("Proof of Delivery — local demo (hardhat in-process network)\n");
  console.log(`  arbiter   ${arbiter.address}\n  client    ${client.address}\n  developer ${developer.address}\n  runner    ${runner.address}\n`);

  // 1. deploy + mint
  const token = await ethers.deployContract("MockERC20", ["Mock USDC", "USDC", 6]);
  await token.waitForDeployment();
  const escrow = await ethers.deployContract("MilestoneEscrow", [arbiter.address]);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  const mintTx = await token.mint(client.address, USDC("1000"));
  step(1, `Deployed MockERC20 ${await token.getAddress()} and MilestoneEscrow ${escrowAddr}; minted 1,000 USDC to client`, mintTx);

  // 2. acceptance hash
  const acceptanceFile = path.resolve(__dirname, "..", "..", "example-deliverable", "acceptance.json");
  const acceptance = JSON.parse(fs.readFileSync(acceptanceFile, "utf8"));
  const acceptanceHash = canonicalHash(acceptance);
  step(2, `acceptanceHash = ${acceptanceHash}\n    (keccak256 of canonical example-deliverable/acceptance.json, ${acceptance.criteria.length} criteria)`);

  // 3. create agreement
  const digest = DEFAULT_RUNNER_IMAGE_DIGEST;
  const createTx = await escrow
    .connect(client)
    .createAgreement(developer.address, runner.address, digest, await token.getAddress(), WINDOW, BOND, AMOUNTS, [acceptanceHash, acceptanceHash]);
  step(3, `client: createAgreement(id=1, developer, runner, digest=${short(digest)}, window=3 days, bond=50, milestones=[300, 200] USDC)`, createTx);

  // 4. fund milestone 0
  await token.connect(client).approve(escrowAddr, USDC("1000"));
  const fundTx = await escrow.connect(client).fundMilestone(1, 0);
  step(4, `client: approve + fundMilestone(1, 0) — 300 USDC escrowed, state=${STATES[Number((await escrow.getMilestone(1, 0)).state)]}`, fundTx);

  // 5. runner: run real acceptance tests, build result.json, sign
  const result = runAcceptance({ agreementId: 1, milestoneIndex: 0, runnerImageDigest: digest, quiet: true });
  const message = toMessage(result);
  const signature = await signResultMessage(runner, chainId, escrowAddr, message);
  step(5, `runner: ran example-deliverable acceptance tests (vitest) — passed=${result.passed}, commit=${result.commitHash.slice(0, 7)}`);
  for (const c of result.criteria) console.log(`      ${c.passed ? "PASS" : "FAIL"} ${c.id}  ${c.evidence}`);
  console.log(`    resultHash ${message.resultHash}\n    EIP-712 signature by runner ${short(signature)} (runner/out/result.json)`);

  // 6. submit
  const submitTx = await escrow.connect(runner).submitResult(1, 0, message, signature);
  const releasable = await escrow.releasableAt(1, 0);
  step(6, `Submitted. Releasable at ${releasable} (${new Date(Number(releasable) * 1000).toISOString()})`, submitTx);

  // 7. release too early
  try {
    await escrow.release(1, 0);
    throw new Error("release unexpectedly succeeded");
  } catch (err) {
    step(7, `release() before window -> reverted with ${revertName(err)}`);
  }

  // 8. time travel + release
  await time.increase(WINDOW + 1);
  const releaseTx = await escrow.release(1, 0);
  step(8, `evm_increaseTime(3 days + 1s) -> release() -> developer balance = ${fmt(await token.balanceOf(developer.address))} USDC`, releaseTx);

  // 9. challenge path on milestone 1
  const fund2 = await escrow.connect(client).fundMilestone(1, 1);
  const message2 = toMessage({ ...result, milestoneIndex: 1 });
  const sig2 = await signResultMessage(runner, chainId, escrowAddr, message2);
  const submit2 = await escrow.connect(runner).submitResult(1, 1, message2, sig2);
  const challengeTx = await escrow.connect(client).challenge(1, 1);
  const resolveTx = await escrow.connect(arbiter).resolveChallenge(1, 1, false);
  step(9, "challenge path on milestone 1: fund -> submit -> client challenge (bond 50) -> arbiter resolveChallenge(developerWins=false)");
  console.log(`    fund      ${fund2.hash}\n    submit    ${submit2.hash}\n    challenge ${challengeTx.hash}\n    resolve   ${resolveTx.hash}`);
  console.log(`    client refunded 200 + bond 50 back -> client balance = ${fmt(await token.balanceOf(client.address))} USDC`);

  // summary
  const m0 = await escrow.getMilestone(1, 0);
  const m1 = await escrow.getMilestone(1, 1);
  console.log("\nSummary");
  console.table([
    { milestone: 0, amount: `${fmt(m0.amount)} USDC`, state: STATES[Number(m0.state)], outcome: "auto-released to developer after challenge window", commit: result.commitHash.slice(0, 7) },
    { milestone: 1, amount: `${fmt(m1.amount)} USDC`, state: STATES[Number(m1.state)], outcome: "challenged, arbiter ruled for client, refund + bond returned", commit: result.commitHash.slice(0, 7) },
  ]);
  console.table([
    { account: "client", balance: `${fmt(await token.balanceOf(client.address))} USDC` },
    { account: "developer", balance: `${fmt(await token.balanceOf(developer.address))} USDC` },
    { account: "escrow", balance: `${fmt(await token.balanceOf(escrowAddr))} USDC` },
  ]);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
