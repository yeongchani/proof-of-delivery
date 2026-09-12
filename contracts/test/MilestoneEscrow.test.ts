import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import fs from "fs";
import path from "path";
import { canonicalHash } from "../../runner/src/hash";
import {
  VERIFICATION_RESULT_TYPES,
  domainFor,
  toMessage,
  type VerificationResultMessage,
} from "../../runner/src/eip712";
import type { RunnerResult } from "../../runner/src/run-tests";

const USDC = (n: string) => ethers.parseUnits(n, 6);
const WINDOW = 3n * 24n * 60n * 60n; // 3 days
const BOND = USDC("50");
const AMOUNT = USDC("300");
const COMMIT = "7b1603f00000000000000000000000000000abcd";
const DIGEST = ethers.id("pod-runner:v0");

enum State { Unfunded, Funded, Submitted, Challenged, Released, Refunded }

function loadAcceptance() {
  const file = path.join(__dirname, "..", "..", "example-deliverable", "acceptance.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function deployFixture() {
  const [arbiter, client, developer, runner, stranger] = await ethers.getSigners();
  const token = await ethers.deployContract("MockERC20", ["Mock USDC", "USDC", 6]);
  await token.mint(client.address, USDC("1000"));
  const escrow = await ethers.deployContract("MilestoneEscrow", [arbiter.address]);
  const acceptanceHash = canonicalHash(loadAcceptance());
  return { arbiter, client, developer, runner, stranger, token, escrow, acceptanceHash };
}

async function createdFixture() {
  const f = await deployFixture();
  const tx = await f.escrow
    .connect(f.client)
    .createAgreement(
      f.developer.address,
      f.runner.address,
      DIGEST,
      await f.token.getAddress(),
      WINDOW,
      BOND,
      [AMOUNT],
      [f.acceptanceHash],
    );
  return { ...f, createTx: tx, agreementId: 1n };
}

async function fundedFixture() {
  const f = await createdFixture();
  await f.token.connect(f.client).approve(await f.escrow.getAddress(), AMOUNT + BOND);
  await f.escrow.connect(f.client).fundMilestone(f.agreementId, 0);
  return f;
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

function makeResult(f: Fixture, overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    agreementId: 1,
    milestoneIndex: 0,
    acceptanceHash: f.acceptanceHash,
    commitHash: COMMIT,
    runnerImageDigest: DIGEST,
    criteria: [{ id: "AC-1", passed: true, evidence: "health ✓ 12ms" }],
    passed: true,
    timestamp: 1757600000,
    logUrl: "local",
    ...overrides,
  };
}

async function signResult(
  signer: HardhatEthersSigner,
  escrowAddress: string,
  message: VerificationResultMessage,
): Promise<string> {
  const { chainId } = await ethers.provider.getNetwork();
  return signer.signTypedData(domainFor(chainId, escrowAddress), VERIFICATION_RESULT_TYPES, message);
}

async function submittedFixture() {
  const f = await fundedFixture();
  const message = toMessage(makeResult(f));
  const sig = await signResult(f.runner, await f.escrow.getAddress(), message);
  await f.escrow.connect(f.stranger).submitResult(f.agreementId, 0, message, sig);
  return { ...f, message };
}

async function challengedFixture() {
  const f = await submittedFixture();
  await f.escrow.connect(f.client).challenge(f.agreementId, 0);
  return f;
}

describe("MilestoneEscrow", () => {
  it("1. createAgreement stores fields and emits AgreementCreated", async () => {
    const f = await loadFixture(createdFixture);

    await expect(f.createTx)
      .to.emit(f.escrow, "AgreementCreated")
      .withArgs(1n, f.client.address, f.developer.address, f.runner.address, 1n);

    const a = await f.escrow.getAgreement(1);
    expect(a.client).to.equal(f.client.address);
    expect(a.developer).to.equal(f.developer.address);
    expect(a.runner).to.equal(f.runner.address);
    expect(a.runnerImageDigest).to.equal(DIGEST);
    expect(a.token).to.equal(await f.token.getAddress());
    expect(a.challengeWindow).to.equal(WINDOW);
    expect(a.challengeBond).to.equal(BOND);
    expect(a.milestoneCount).to.equal(1n);
    expect(a.terminated).to.equal(false);

    const m = await f.escrow.getMilestone(1, 0);
    expect(m.amount).to.equal(AMOUNT);
    expect(m.acceptanceHash).to.equal(f.acceptanceHash);
    expect(m.state).to.equal(State.Unfunded);

    await expect(
      f.escrow
        .connect(f.client)
        .createAgreement(f.developer.address, f.runner.address, DIGEST, await f.token.getAddress(), WINDOW, BOND, [AMOUNT], []),
    ).to.be.revertedWithCustomError(f.escrow, "LengthMismatch");
  });

  it("2. fundMilestone moves tokens and sets Funded; non-client reverts NotClient", async () => {
    const f = await loadFixture(createdFixture);
    const escrowAddr = await f.escrow.getAddress();
    await f.token.connect(f.client).approve(escrowAddr, AMOUNT);

    await expect(f.escrow.connect(f.stranger).fundMilestone(1, 0)).to.be.revertedWithCustomError(f.escrow, "NotClient");

    const tx = await f.escrow.connect(f.client).fundMilestone(1, 0);
    await expect(tx).to.emit(f.escrow, "MilestoneFunded").withArgs(1n, 0n, AMOUNT);
    await expect(tx).to.changeTokenBalances(f.token, [f.client, f.escrow], [-AMOUNT, AMOUNT]);

    expect((await f.escrow.getMilestone(1, 0)).state).to.equal(State.Funded);
  });

  it("3. submitResult with valid runner signature & passed=true -> Submitted, releasableAt = submittedAt + window", async () => {
    const f = await loadFixture(fundedFixture);
    const message = toMessage(makeResult(f));
    const sig = await signResult(f.runner, await f.escrow.getAddress(), message);

    await expect(f.escrow.connect(f.stranger).submitResult(1, 0, message, sig))
      .to.emit(f.escrow, "VerificationSubmitted")
      .withArgs(1n, 0n, message.commitHash, message.resultHash, anyValue);

    const m = await f.escrow.getMilestone(1, 0);
    expect(m.state).to.equal(State.Submitted);
    expect(m.resultHash).to.equal(message.resultHash);
    expect(m.commitHash).to.equal(message.commitHash);
    expect(m.submittedAt).to.equal(BigInt(await time.latest()));
    expect(await f.escrow.releasableAt(1, 0)).to.equal(m.submittedAt + WINDOW);
  });

  it("4. submitResult signed by a stranger -> BadSigner", async () => {
    const f = await loadFixture(fundedFixture);
    const message = toMessage(makeResult(f));
    const sig = await signResult(f.stranger, await f.escrow.getAddress(), message);
    await expect(f.escrow.submitResult(1, 0, message, sig)).to.be.revertedWithCustomError(f.escrow, "BadSigner");
  });

  it("5. wrong acceptanceHash -> HashMismatch; wrong runnerImageDigest -> DigestMismatch", async () => {
    const f = await loadFixture(fundedFixture);
    const escrowAddr = await f.escrow.getAddress();

    const badHash = toMessage(makeResult(f, { acceptanceHash: ethers.id("tampered acceptance") }));
    await expect(
      f.escrow.submitResult(1, 0, badHash, await signResult(f.runner, escrowAddr, badHash)),
    ).to.be.revertedWithCustomError(f.escrow, "HashMismatch");

    const badDigest = toMessage(makeResult(f, { runnerImageDigest: ethers.id("pod-runner:evil") }));
    await expect(
      f.escrow.submitResult(1, 0, badDigest, await signResult(f.runner, escrowAddr, badDigest)),
    ).to.be.revertedWithCustomError(f.escrow, "DigestMismatch");
  });

  it("6. submitResult passed=false -> state stays Funded, emits VerificationFailed", async () => {
    const f = await loadFixture(fundedFixture);
    const message = toMessage(
      makeResult(f, { passed: false, criteria: [{ id: "AC-1", passed: false, evidence: "health ✗ 5ms" }] }),
    );
    const sig = await signResult(f.runner, await f.escrow.getAddress(), message);

    await expect(f.escrow.submitResult(1, 0, message, sig))
      .to.emit(f.escrow, "VerificationFailed")
      .withArgs(1n, 0n, message.commitHash, message.resultHash);

    const m = await f.escrow.getMilestone(1, 0);
    expect(m.state).to.equal(State.Funded);
    expect(m.submittedAt).to.equal(0n);
  });

  it("7. release before window -> WindowOpen; after time travel -> Released, developer paid", async () => {
    const f = await loadFixture(submittedFixture);
    await expect(f.escrow.release(1, 0)).to.be.revertedWithCustomError(f.escrow, "WindowOpen");

    await time.increase(WINDOW + 1n);

    const tx = await f.escrow.connect(f.stranger).release(1, 0);
    await expect(tx).to.emit(f.escrow, "Released").withArgs(1n, 0n, AMOUNT);
    await expect(tx).to.changeTokenBalances(f.token, [f.escrow, f.developer], [-AMOUNT, AMOUNT]);
    expect((await f.escrow.getMilestone(1, 0)).state).to.equal(State.Released);
  });

  it("8. challenge locks; release reverts InvalidState; resolveChallenge pays winner amount + bond", async () => {
    const f = await loadFixture(submittedFixture);
    await expect(f.escrow.connect(f.stranger).challenge(1, 0)).to.be.revertedWithCustomError(f.escrow, "NotClient");

    const challengeTx = await f.escrow.connect(f.client).challenge(1, 0);
    await expect(challengeTx).to.emit(f.escrow, "Challenged").withArgs(1n, 0n, f.client.address, BOND);
    await expect(challengeTx).to.changeTokenBalances(f.token, [f.client, f.escrow], [-BOND, BOND]);
    const locked = await f.escrow.getMilestone(1, 0);
    expect(locked.state).to.equal(State.Challenged);
    expect(locked.challenger).to.equal(f.client.address);

    await time.increase(WINDOW + 1n);
    await expect(f.escrow.release(1, 0)).to.be.revertedWithCustomError(f.escrow, "InvalidState");
    await expect(f.escrow.connect(f.stranger).resolveChallenge(1, 0, true)).to.be.revertedWithCustomError(
      f.escrow,
      "NotArbiter",
    );

    // developer wins: amount + bond -> developer
    const devWins = await f.escrow.connect(f.arbiter).resolveChallenge(1, 0, true);
    await expect(devWins).to.emit(f.escrow, "ChallengeResolved").withArgs(1n, 0n, true);
    await expect(devWins).to.changeTokenBalances(f.token, [f.escrow, f.developer], [-(AMOUNT + BOND), AMOUNT + BOND]);
    expect((await f.escrow.getMilestone(1, 0)).state).to.equal(State.Released);

    // client wins: amount + bond -> client (fresh snapshot)
    const g = await loadFixture(challengedFixture);
    const clientWins = await g.escrow.connect(g.arbiter).resolveChallenge(1, 0, false);
    await expect(clientWins).to.emit(g.escrow, "ChallengeResolved").withArgs(1n, 0n, false);
    await expect(clientWins).to.changeTokenBalances(g.token, [g.escrow, g.client], [-(AMOUNT + BOND), AMOUNT + BOND]);
    expect((await g.escrow.getMilestone(1, 0)).state).to.equal(State.Refunded);
    expect(await g.token.balanceOf(g.client.address)).to.equal(USDC("1000"));
  });

  it("9. challenge after window -> WindowClosed", async () => {
    const f = await loadFixture(submittedFixture);
    await time.increase(WINDOW + 1n);
    await expect(f.escrow.connect(f.client).challenge(1, 0)).to.be.revertedWithCustomError(f.escrow, "WindowClosed");
  });
});
