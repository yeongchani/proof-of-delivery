import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const DAY = 86400;
const TYPES = { Result: [
  ["agreementId", "uint256"], ["authorityVersion", "uint256"],
  ["acceptanceHash", "bytes32"], ["runnerDigest", "bytes32"],
  ["policyHash", "bytes32"], ["resultHash", "bytes32"],
  ["sourceHash", "bytes32"], ["passed", "bool"], ["expiry", "uint256"],
].map(([name, type]) => ({ name, type })) };

async function fixture() {
  const [arbiter, client, developer, runner, other] = await ethers.getSigners();
  const token: any = await ethers.deployContract("MockERC20", ["USD", "USD", 6]);
  const escrow: any = await ethers.deployContract("AuthorityEscrow", [arbiter.address]);
  const key = ethers.hexlify(ethers.randomBytes(32));
  const terms = {
    developer: developer.address, runner: runner.address, token: await token.getAddress(),
    acceptanceHash: ethers.id("accept"), runnerDigest: ethers.id("runner"),
    policyHash: ethers.id("policy"), amount: 1000n, devBond: 100n, challengeBond: 50n,
    challengeWindow: DAY, deliveryDuration: 7 * DAY, disputeDuration: 3 * DAY,
    retentionBps: 1000, retentionPeriod: 30 * DAY, sourceKeyHash: ethers.keccak256(key),
  };
  for (const party of [client, developer]) {
    await token.mint(party.address, 10000n);
    await token.connect(party).approve(await escrow.getAddress(), 10000n);
  }
  await escrow.connect(client).createAgreement(terms);
  await escrow.connect(developer).acceptAgreement(1);
  await escrow.connect(client).fund(1);
  await escrow.connect(developer).depositDevBond(1);
  return { arbiter, client, developer, runner, other, token, escrow, terms, key };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function signed(f: Fixture, passed = true, id = 1) {
  const a = await f.escrow.getAgreement(id);
  const result = {
    agreementId: id, authorityVersion: a.authorityVersion,
    acceptanceHash: a.terms.acceptanceHash, runnerDigest: a.terms.runnerDigest,
    policyHash: a.terms.policyHash, resultHash: ethers.id(passed ? "pass" : "fail"),
    sourceHash: ethers.id("source"), passed, expiry: a.deliveryDeadline,
  };
  const signature = await f.runner.signTypedData({
    name: "AuthorityEscrow", version: "1", chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await f.escrow.getAddress(),
  }, TYPES, result);
  return { result, signature };
}
async function submit(f: Fixture, passed = true, id = 1) {
  const s = await signed(f, passed, id);
  await f.escrow.submitResult(s.result, s.signature);
  return f.escrow.getAgreement(id);
}
async function successor(f: Fixture, overrides: any = {}) {
  const id = await f.escrow.nextAgreementId();
  await f.escrow.connect(f.client).createAgreement({
    ...f.terms, acceptanceHash: ethers.id("new requirements"), ...overrides,
  });
  return id;
}
async function expectNeutral(f: Fixture) {
  expect(await f.token.balanceOf(f.client.address)).to.equal(10000n);
  expect(await f.token.balanceOf(f.developer.address)).to.equal(10000n);
  expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0n);
}

describe("AuthorityEscrow final-source handover", () => {
  it("rejects key disclosure before submission, then atomically reveals and pays after objections", async () => {
    const f = await loadFixture(fixture);
    await expect(f.escrow.connect(f.developer).revealSourceKey(1, f.key)).to.be.reverted;
    const a = await submit(f);
    expect(a.sourceRevealed).to.equal(false);
    expect(a.handoverDeadline).to.equal(a.challengeDeadline + BigInt(DAY));
    await expect(f.escrow.revealSourceKey(1, f.key)).to.be.reverted;
    await expect(f.escrow.connect(f.client).revokeAuthority(1)).to.be.reverted;
    await time.increaseTo(a.challengeDeadline);
    await expect(f.escrow.release(1)).to.be.reverted;
    await expect(f.escrow.revealSourceKey(1, ethers.toUtf8Bytes("wrong"))).to.be.reverted;
    await expect(f.escrow.connect(f.other).revealSourceKey(1, f.key)).to.emit(f.escrow, "SourceKeyRevealed");
    expect((await f.escrow.getAgreement(1)).state).to.equal(5);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(10900n);
    await expect(f.escrow.connect(f.client).revokeAuthority(1)).to.be.reverted;
    await expect(f.escrow.refundTimeout(1)).to.be.reverted;
    await expect(f.escrow.revealSourceKey(1, f.key)).to.be.reverted;
    await time.increaseTo((await f.escrow.getAgreement(1)).retentionDeadline);
    await f.escrow.releaseRetention(1);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(11000n);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0n);
  });
  it("rejects key disclosure in Accepted even before either deposit", async () => {
    const f = await loadFixture(fixture);
    const id = await successor(f);
    await f.escrow.connect(f.developer).acceptAgreement(id);
    await expect(f.escrow.revealSourceKey(id, f.key)).to.be.reverted;
  });
  it("bounds withheld-key refund and rejects late reveal at the exact boundary", async () => {
    const f = await loadFixture(fixture);
    const a = await submit(f);
    await time.increaseTo(a.handoverDeadline - 2n);
    await expect(f.escrow.refundTimeout(1)).to.be.reverted;
    await time.setNextBlockTimestamp(a.handoverDeadline);
    await expect(f.escrow.revealSourceKey(1, f.key)).to.be.reverted;
    await f.escrow.refundTimeout(1);
    await expectNeutral(f);
    await expect(f.escrow.revealSourceKey(1, f.key)).to.be.reverted;
    await expect(f.escrow.refundTimeout(1)).to.be.reverted;
  });
  for (const finish of ["deliver", "withhold"]) {
    it(`defers keyed developer arbitration award until handover: ${finish}`, async () => {
      const f = await loadFixture(fixture);
      await submit(f);
      await f.escrow.connect(f.client).challenge(1);
      await expect(f.escrow.revealSourceKey(1, f.key)).to.be.reverted;
      await f.escrow.connect(f.arbiter).resolve(1, true);
      const a = await f.escrow.getAgreement(1);
      expect(a.state).to.equal(8);
      expect(a.pendingChallengeAward).to.equal(50n);
      expect(a.handoverDeadline).to.equal(BigInt(await time.latest()) + BigInt(DAY));
      expect(await f.token.balanceOf(f.developer.address)).to.equal(9900n);
      await expect(f.escrow.release(1)).to.be.reverted;
      if (finish === "deliver") {
        await f.escrow.revealSourceKey(1, f.key);
        expect(await f.token.balanceOf(f.developer.address)).to.equal(10950n);
        expect((await f.escrow.getAgreement(1)).pendingChallengeAward).to.equal(0n);
      } else {
        await time.increaseTo(a.handoverDeadline);
        await f.escrow.refundTimeout(1);
        await expectNeutral(f);
      }
    });
  }
});

describe("AuthorityEscrow failed verification appeals", () => {
  it("records failure, preserves the whole appeal window beyond the delivery deadline", async () => {
    const f = await loadFixture(fixture);
    const deadline = (await f.escrow.getAgreement(1)).deliveryDeadline;
    await time.increaseTo(deadline - 100n);
    const a = await submit(f, false);
    expect(a.state).to.equal(7);
    expect(a.resultHash).to.equal(ethers.id("fail"));
    await time.increaseTo(deadline);
    await expect(f.escrow.refundTimeout(1)).to.be.reverted;
    await expect(f.escrow.connect(f.client).challenge(1)).to.be.reverted;
    await f.escrow.connect(f.developer).challenge(1);
    expect((await f.escrow.getAgreement(1)).challenger).to.equal(f.developer.address);
    await expect(f.escrow.submitResult((await signed(f)).result, (await signed(f)).signature)).to.be.reverted;
    await time.increaseTo((await f.escrow.getAgreement(1)).disputeDeadline);
    await f.escrow.refundTimeout(1);
    await expectNeutral(f);
  });
  it("refunds unappealed failure only after both deadlines", async () => {
    const f = await loadFixture(fixture);
    const deadline = (await f.escrow.getAgreement(1)).deliveryDeadline;
    await time.increaseTo(deadline - 100n);
    const a = await submit(f, false);
    await time.increaseTo(a.challengeDeadline - 2n);
    await expect(f.escrow.refundTimeout(1)).to.be.reverted;
    await time.setNextBlockTimestamp(a.challengeDeadline);
    await f.escrow.refundTimeout(1);
    await expectNeutral(f);
  });
  it("supports rework but invalidates old results and freezes an appealed failure", async () => {
    const f = await loadFixture(fixture);
    const oldPass = await signed(f);
    const oldFail = await signed(f, false);
    await f.escrow.submitResult(oldFail.result, oldFail.signature);
    await expect(f.escrow.submitResult(oldFail.result, oldFail.signature)).to.be.reverted;
    await expect(f.escrow.submitResult(oldPass.result, oldPass.signature)).to.be.reverted;
    await time.increaseTo((await f.escrow.getAgreement(1)).challengeDeadline);
    await submit(f);
    expect((await f.escrow.getAgreement(1)).state).to.equal(3);
    await f.escrow.connect(f.client).challenge(1);
    const s = await signed(f, false);
    await expect(f.escrow.submitResult(s.result, s.signature)).to.be.reverted;
  });
  for (const passed of [true, false]) {
    it(`preserves a failed verdict's appeal opportunity against early rework: passed=${passed}`, async () => {
      const f = await loadFixture(fixture);
      const failed = await submit(f, false);
      const retry = await signed(f, passed);
      await expect(f.escrow.submitResult(retry.result, retry.signature)).to.be.reverted;
      await time.setNextBlockTimestamp(failed.challengeDeadline - 1n);
      await expect(f.escrow.submitResult(retry.result, retry.signature)).to.be.reverted;
      const unchanged = await f.escrow.getAgreement(1);
      expect(unchanged.state).to.equal(7);
      expect(unchanged.resultHash).to.equal(failed.resultHash);
      expect(unchanged.challengeDeadline).to.equal(failed.challengeDeadline);
      expect(unchanged.authorityVersion).to.equal(failed.authorityVersion);
      await time.setNextBlockTimestamp(failed.challengeDeadline);
      await f.escrow.submitResult(retry.result, retry.signature);
      expect((await f.escrow.getAgreement(1)).state).to.equal(passed ? 3 : 7);
    });
  }
  it("does not reopen rework if the appeal window outlives the delivery deadline", async () => {
    const f = await loadFixture(fixture);
    const deadline = (await f.escrow.getAgreement(1)).deliveryDeadline;
    await time.increaseTo(deadline - 100n);
    const failed = await submit(f, false);
    const retry = await signed(f);
    await time.setNextBlockTimestamp(failed.challengeDeadline);
    await expect(f.escrow.submitResult(retry.result, retry.signature)).to.be.reverted;
    await f.escrow.refundTimeout(1);
    await expectNeutral(f);
  });
  for (const keyed of [true, false]) {
    for (const outcome of ["client", "developer", "timeout", "withhold"]) {
      if (!keyed && outcome === "withhold") continue;
      it(`conserves developer-paid appeal bond: keyed=${keyed}, ${outcome}`, async () => {
        const f = await loadFixture(fixture);
        let id = 1;
        if (!keyed) {
          id = Number(await successor(f, { sourceKeyHash: ethers.ZeroHash }));
          await f.escrow.connect(f.developer).acceptAgreement(id);
          await f.escrow.connect(f.client).fund(id);
          await f.escrow.connect(f.developer).depositDevBond(id);
        }
        const baselineClient = await f.token.balanceOf(f.client.address);
        const baselineDev = await f.token.balanceOf(f.developer.address);
        await submit(f, false, id);
        await f.escrow.connect(f.developer).challenge(id);
        if (outcome === "timeout") {
          await time.increaseTo((await f.escrow.getAgreement(id)).disputeDeadline);
          await f.escrow.refundTimeout(id);
        } else {
          await f.escrow.connect(f.arbiter).resolve(id, outcome !== "client");
          if (keyed && outcome !== "client") {
            if (outcome === "withhold") {
              await time.increaseTo((await f.escrow.getAgreement(id)).handoverDeadline);
              await f.escrow.refundTimeout(id);
            } else await f.escrow.revealSourceKey(id, f.key);
          }
          if (outcome === "developer") {
            await time.increaseTo((await f.escrow.getAgreement(id)).retentionDeadline);
            await f.escrow.releaseRetention(id);
          }
        }
        expect(await f.token.balanceOf(f.client.address)).to.equal(baselineClient +
          (outcome === "client" ? 1150n : outcome === "developer" ? 0n : 1000n));
        expect(await f.token.balanceOf(f.developer.address)).to.equal(baselineDev +
          (outcome === "client" ? -50n : outcome === "developer" ? 1100n : 100n));
        await expect(f.escrow.refundTimeout(id)).to.be.reverted;
        await expect(f.escrow.connect(f.arbiter).resolve(id, true)).to.be.reverted;
      });
    }
  }
});

describe("AuthorityEscrow bilateral requirements replacement", () => {
  it("expires pending replacement consent exactly when delivery refund becomes available", async () => {
    const f = await loadFixture(fixture);
    const id = await successor(f);
    await f.escrow.connect(f.client).approveReplacement(1,id,1000,2);
    await time.setNextBlockTimestamp((await f.escrow.getAgreement(1)).deliveryDeadline);
    await expect(f.escrow.connect(f.developer).approveReplacement(1,id,1000,2)).to.be.revertedWith("replacement expired");
    await f.escrow.refundTimeout(1);
    expect(await f.token.balanceOf(f.client.address)).to.equal(10000n);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(10000n);
    expect((await f.escrow.getAgreement(id)).predecessorId).to.equal(0);
  });
  it("permits joint replacement until one second before the delivery deadline", async () => {
    const f = await loadFixture(fixture);
    const id = await successor(f);
    await f.escrow.connect(f.client).approveReplacement(1,id,300,2);
    await time.setNextBlockTimestamp((await f.escrow.getAgreement(1)).deliveryDeadline-1n);
    await f.escrow.connect(f.developer).approveReplacement(1,id,300,2);
    expect((await f.escrow.getAgreement(1)).state).to.equal(9);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(10300n);
  });
  it("needs exact joint consent, settles only agreed deposited price and links the successor", async () => {
    const f = await loadFixture(fixture);
    const id = await successor(f);
    const old = await signed(f);
    await f.escrow.connect(f.client).approveAuthority(1, f.other.address, 2);
    await f.escrow.connect(f.client).approveReplacement(1, id, 300, 2);
    expect((await f.escrow.getAgreement(1)).state).to.equal(2);
    await f.escrow.connect(f.developer).approveReplacement(1, id, 301, 2);
    expect((await f.escrow.getAgreement(1)).state).to.equal(2);
    await f.escrow.connect(f.developer).approveReplacement(1, id, 300, 2);
    const a = await f.escrow.getAgreement(1);
    expect(a.state).to.equal(9);
    expect(a.successorId).to.equal(id);
    expect((await f.escrow.getAgreement(id)).predecessorId).to.equal(1);
    expect(a.authorityVersion).to.equal(2);
    expect(a.clientProposal).to.equal(ethers.ZeroHash);
    expect(await f.token.balanceOf(f.client.address)).to.equal(9700n);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(10300n);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0n);
    await expect(f.escrow.submitResult(old.result, old.signature)).to.be.reverted;
    await expect(f.escrow.connect(f.client).approveReplacement(1, id, 300, 2)).to.be.reverted;
    await expect(f.escrow.refundTimeout(1)).to.be.reverted;
    await f.escrow.connect(f.developer).acceptAgreement(id);
    await f.escrow.connect(f.client).fund(id);
    await f.escrow.connect(f.developer).depositDevBond(id);
    expect((await f.escrow.getAgreement(id)).state).to.equal(2);
  });
  it("invalidates stale consent when authority changes", async () => {
    const f = await loadFixture(fixture);
    const id = await successor(f);
    await f.escrow.connect(f.client).approveReplacement(1, id, 300, 2);
    await f.escrow.connect(f.developer).revokeAuthority(1);
    await expect(f.escrow.connect(f.developer).approveReplacement(1, id, 300, 2)).to.be.reverted;
    await f.escrow.connect(f.developer).approveReplacement(1, id, 300, 3);
    expect((await f.escrow.getAgreement(1)).state).to.equal(2);
    await f.escrow.connect(f.client).approveReplacement(1, id, 300, 3);
    expect((await f.escrow.getAgreement(1)).state).to.equal(9);
  });
  it("invalidates old successor consent if its runner is changed", async () => {
    const f = await loadFixture(fixture);
    const id = await successor(f);
    await f.escrow.connect(f.client).approveReplacement(1, id, 300, 2);
    await f.escrow.connect(f.client).approveAuthority(id, f.other.address, 2);
    await f.escrow.connect(f.developer).approveAuthority(id, f.other.address, 2);
    await f.escrow.connect(f.developer).approveReplacement(1, id, 300, 2);
    expect((await f.escrow.getAgreement(1)).state).to.equal(2);
  });
  it("rejects outsiders, stale versions, excessive payment, incompatible or active successors", async () => {
    const f = await loadFixture(fixture);
    const good = await successor(f);
    await expect(f.escrow.connect(f.other).approveReplacement(1, good, 300, 2)).to.be.reverted;
    await expect(f.escrow.connect(f.client).approveReplacement(1, good, 1001, 2)).to.be.reverted;
    await expect(f.escrow.connect(f.client).approveReplacement(1, good, 0, 1)).to.be.reverted;
    const badDev = await successor(f, { developer: f.other.address });
    await expect(f.escrow.connect(f.client).approveReplacement(1, badDev, 0, 2)).to.be.reverted;
    const token = await ethers.deployContract("MockERC20", ["Other", "OTH", 6]);
    const badToken = await successor(f, { token: await token.getAddress() });
    await expect(f.escrow.connect(f.client).approveReplacement(1, badToken, 0, 2)).to.be.reverted;
    await f.escrow.connect(f.other).createAgreement(f.terms);
    const badClient = (await f.escrow.nextAgreementId()) - 1n;
    await expect(f.escrow.connect(f.client).approveReplacement(1, badClient, 0, 2)).to.be.reverted;
    await f.escrow.connect(f.developer).acceptAgreement(good);
    await expect(f.escrow.connect(f.client).approveReplacement(1, good, 0, 2)).to.be.reverted;
    await expect(f.escrow.connect(f.client).approveReplacement(1, 1, 0, 2)).to.be.reverted;
  });
  for (const deposits of [0, 1, 2, 3]) {
    it(`conserves partial funding on agreed replacement: ${deposits}`, async () => {
      const f = await loadFixture(fixture);
      const old = await successor(f);
      await f.escrow.connect(f.developer).acceptAgreement(old);
      if (deposits & 1) await f.escrow.connect(f.client).fund(old);
      if (deposits & 2) await f.escrow.connect(f.developer).depositDevBond(old);
      const next = await successor(f);
      const amount = deposits & 1 ? 100 : 0;
      await f.escrow.connect(f.client).approveReplacement(old, next, amount, 2);
      await f.escrow.connect(f.developer).approveReplacement(old, next, amount, 2);
      expect(await f.token.balanceOf(f.client.address)).to.equal(9000n - BigInt(amount));
      expect(await f.token.balanceOf(f.developer.address)).to.equal(9900n + BigInt(amount));
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(1100n);
    });
  }
  for (const state of ["Submitted", "Failed", "Challenged", "Released", "Refunded", "AwaitingDelivery"]) {
    it(`rejects replacement after a result or terminal transition: ${state}`, async () => {
      const f = await loadFixture(fixture);
      const next = await successor(f);
      if (state === "Refunded") {
        await time.increaseTo((await f.escrow.getAgreement(1)).deliveryDeadline);
        await f.escrow.refundTimeout(1);
      } else {
        const a = await submit(f, state !== "Failed");
        if (state === "Challenged" || state === "AwaitingDelivery") {
          await f.escrow.connect(f.client).challenge(1);
          if (state === "AwaitingDelivery") await f.escrow.connect(f.arbiter).resolve(1, true);
        } else if (state === "Released") {
          await time.increaseTo(a.challengeDeadline);
          await f.escrow.revealSourceKey(1, f.key);
        }
      }
      await expect(f.escrow.connect(f.client).approveReplacement(1, next, 0, 2)).to.be.reverted;
    });
  }
});
