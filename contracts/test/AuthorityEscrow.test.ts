import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

const DAY = 86400;
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
async function fixture() {
  const [arbiter, client, developer, runner, other] = await ethers.getSigners();
  const token: any = await ethers.deployContract("MockERC20", [
    "USD",
    "USD",
    6,
  ]);
  const escrow: any = await ethers.deployContract("AuthorityEscrow", [
    arbiter.address,
  ]);
  const terms = {
    developer: developer.address,
    runner: runner.address,
    token: await token.getAddress(),
    acceptanceHash: ethers.id("accept"),
    runnerDigest: ethers.id("runner"),
    policyHash: ethers.id("policy"),
    amount: 1000n,
    devBond: 100n,
    challengeBond: 50n,
    challengeWindow: DAY,
    deliveryDuration: 7 * DAY,
    disputeDuration: 3 * DAY,
    retentionBps: 1000,
    retentionPeriod: 30 * DAY,
    sourceKeyHash: ethers.ZeroHash,
  };
  for (const who of [client, developer]) {
    await token.mint(who.address, 10000);
    await token.connect(who).approve(await escrow.getAddress(), 10000);
  }
  await escrow.connect(client).createAgreement(terms);
  return { arbiter, client, developer, runner, other, token, escrow, terms };
}
async function funded() {
  const f = await fixture();
  await f.escrow.connect(f.developer).acceptAgreement(1);
  await f.escrow.connect(f.client).fund(1);
  await f.escrow.connect(f.developer).depositDevBond(1);
  return f;
}
async function signed(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: any = {},
  signer = f.runner,
  domainOverrides: any = {}
) {
  const result = {
    agreementId: 1,
    authorityVersion: 1,
    acceptanceHash: f.terms.acceptanceHash,
    runnerDigest: f.terms.runnerDigest,
    policyHash: f.terms.policyHash,
    resultHash: ethers.id("result"),
    sourceHash: ethers.id("source"),
    passed: true,
    expiry: (await time.latest()) + DAY,
    ...overrides,
  };
  const signature = await signer.signTypedData(
    {
      name: "AuthorityEscrow",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await f.escrow.getAddress(),
      ...domainOverrides,
    },
    TYPES,
    result
  );
  return { result, signature };
}
async function submit(f: Awaited<ReturnType<typeof fixture>>) {
  const s = await signed(f);
  await f.escrow.connect(f.other).submitResult(s.result, s.signature);
  return f.escrow.getAgreement(1);
}

describe("AuthorityEscrow", () => {
  it("requires developer acceptance before deposits and both deposits before verification", async () => {
    const f = await loadFixture(fixture);
    await expect(f.escrow.connect(f.client).fund(1)).to.be.reverted;
    await expect(f.escrow.connect(f.developer).depositDevBond(1)).to.be
      .reverted;
    await expect(f.escrow.connect(f.client).acceptAgreement(1)).to.be.reverted;
    await f.escrow.connect(f.developer).acceptAgreement(1);
    await expect(f.escrow.connect(f.developer).acceptAgreement(1)).to.be
      .reverted;
    await f.escrow.connect(f.client).fund(1);
    const s = await signed(f);
    await expect(f.escrow.submitResult(s.result, s.signature)).to.be.reverted;
    await f.escrow.connect(f.developer).depositDevBond(1);
    await f.escrow.submitResult(s.result, s.signature);
    await expect(f.escrow.connect(f.client).fund(1)).to.be.reverted;
  });
  it("releases only fixed developer, holds retention, conserves tokens and prevents duplicate payouts", async () => {
    const f = await loadFixture(funded);
    const a = await submit(f);
    await expect(f.escrow.release(1)).to.be.reverted;
    await time.increaseTo(a.challengeDeadline);
    await f.escrow.connect(f.other).release(1);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(10900);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(100);
    await expect(f.escrow.release(1)).to.be.reverted;
    await expect(f.escrow.releaseRetention(1)).to.be.reverted;
    const released = await f.escrow.getAgreement(1);
    await time.increaseTo(released.retentionDeadline);
    await f.escrow.connect(f.other).releaseRetention(1);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(11000);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0);
    await expect(f.escrow.releaseRetention(1)).to.be.reverted;
  });
  for (const field of [
    "policyHash",
    "acceptanceHash",
    "runnerDigest",
    "authorityVersion",
    "agreementId",
    "passed",
    "expiry",
  ]) {
    it(`rejects invalid ${field}`, async () => {
      const f = await loadFixture(funded);
      const value =
        field.endsWith("Hash") || field === "runnerDigest"
          ? ethers.id("wrong")
          : field === "passed"
          ? false
          : field === "expiry"
          ? 1
          : 2;
      const s = await signed(f, { [field]: value });
      await expect(f.escrow.submitResult(s.result, s.signature)).to.be.reverted;
    });
  }
  it("rejects wrong signer, changed payload and wrong EIP712 domain", async () => {
    const f = await loadFixture(funded);
    for (const [signer, domain] of [
      [f.other, {}],
      [f.runner, { chainId: 1 }],
      [f.runner, { verifyingContract: f.other.address }],
      [f.runner, { version: "2" }],
    ] as any) {
      const s = await signed(f, {}, signer, domain);
      await expect(f.escrow.submitResult(s.result, s.signature)).to.be.reverted;
    }
    const s = await signed(f);
    await expect(
      f.escrow.submitResult(
        { ...s.result, sourceHash: ethers.id("changed") },
        s.signature
      )
    ).to.be.reverted;
  });
  it("requires matching bilateral rotation, revocation pauses, and old signatures never revive", async () => {
    const f = await loadFixture(funded);
    const old = await signed(f);
    await expect(f.escrow.connect(f.other).revokeAuthority(1)).to.be.reverted;
    await f.escrow.connect(f.client).approveAuthority(1, f.other.address, 2);
    expect((await f.escrow.getAgreement(1)).authorityVersion).to.equal(1);
    await f.escrow
      .connect(f.developer)
      .approveAuthority(1, f.runner.address, 2);
    expect((await f.escrow.getAgreement(1)).authorityVersion).to.equal(1);
    await f.escrow.connect(f.developer).approveAuthority(1, f.other.address, 2);
    expect((await f.escrow.getAgreement(1)).authorityVersion).to.equal(2);
    await expect(f.escrow.submitResult(old.result, old.signature)).to.be
      .reverted;
    await f.escrow.connect(f.developer).revokeAuthority(1);
    const paused = await signed(f, { authorityVersion: 3 }, f.other);
    await expect(f.escrow.submitResult(paused.result, paused.signature)).to.be
      .reverted;
    await f.escrow.connect(f.client).approveAuthority(1, f.runner.address, 4);
    await f.escrow
      .connect(f.developer)
      .approveAuthority(1, f.runner.address, 4);
    await expect(f.escrow.submitResult(old.result, old.signature)).to.be
      .reverted;
    const current = await signed(f, { authorityVersion: 4 });
    await f.escrow.submitResult(current.result, current.signature);
    await expect(f.escrow.connect(f.client).revokeAuthority(1)).to.be.reverted;
    await expect(
      f.escrow.connect(f.developer).approveAuthority(1, f.other.address, 5)
    ).to.be.reverted;
    await expect(f.escrow.submitResult(current.result, current.signature)).to.be
      .reverted;
  });
  for (const deposits of [0, 1, 2, 3]) {
    it(`neutral delivery timeout refunds deposit combination ${deposits}`, async () => {
      const f = await loadFixture(fixture);
      await f.escrow.connect(f.developer).acceptAgreement(1);
      if (deposits & 1) await f.escrow.connect(f.client).fund(1);
      if (deposits & 2) await f.escrow.connect(f.developer).depositDevBond(1);
      await expect(f.escrow.refundTimeout(1)).to.be.reverted;
      await time.increaseTo((await f.escrow.getAgreement(1)).deliveryDeadline);
      await f.escrow.connect(f.other).refundTimeout(1);
      expect(await f.token.balanceOf(f.client.address)).to.equal(10000);
      expect(await f.token.balanceOf(f.developer.address)).to.equal(10000);
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0);
      await expect(f.escrow.refundTimeout(1)).to.be.reverted;
      await expect(f.escrow.connect(f.client).fund(1)).to.be.reverted;
    });
  }
  for (const outcome of ["client", "developer", "timeout"]) {
    it(`settles challenged result: ${outcome}, exactly once`, async () => {
      const f = await loadFixture(funded);
      await submit(f);
      await expect(f.escrow.connect(f.developer).challenge(1)).to.be.reverted;
      await f.escrow.connect(f.client).challenge(1);
      await expect(f.escrow.connect(f.client).challenge(1)).to.be.reverted;
      await expect(f.escrow.connect(f.other).resolve(1, true)).to.be.reverted;
      await expect(f.escrow.release(1)).to.be.reverted;
      if (outcome === "timeout") {
        await expect(f.escrow.refundTimeout(1)).to.be.reverted;
        await time.increaseTo((await f.escrow.getAgreement(1)).disputeDeadline);
        await expect(f.escrow.connect(f.arbiter).resolve(1, true)).to.be
          .reverted;
        await f.escrow.refundTimeout(1);
      } else {
        await f.escrow.connect(f.arbiter).resolve(1, outcome === "developer");
        if (outcome === "developer") {
          await time.increaseTo(
            (
              await f.escrow.getAgreement(1)
            ).retentionDeadline
          );
          await f.escrow.releaseRetention(1);
        }
      }
      expect(await f.token.balanceOf(f.client.address)).to.equal(
        outcome === "client" ? 10100 : outcome === "developer" ? 8950 : 10000
      );
      expect(await f.token.balanceOf(f.developer.address)).to.equal(
        outcome === "client" ? 9900 : outcome === "developer" ? 11050 : 10000
      );
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0);
      await expect(f.escrow.resolve(1, false)).to.be.reverted;
      await expect(f.escrow.refundTimeout(1)).to.be.reverted;
    });
  }
  it("requires public source preimage before submission so withholding cannot trap accepted funds", async () => {
    const f = await loadFixture(fixture);
    const key = ethers.toUtf8Bytes("public source key");
    await f.escrow
      .connect(f.client)
      .createAgreement({ ...f.terms, sourceKeyHash: ethers.keccak256(key) });
    await f.escrow.connect(f.developer).acceptAgreement(2);
    await f.escrow.connect(f.client).fund(2);
    await f.escrow.connect(f.developer).depositDevBond(2);
    const s = await signed(f, { agreementId: 2 });
    await expect(f.escrow.submitResult(s.result, s.signature)).to.be.reverted;
    await expect(f.escrow.revealSourceKey(2, ethers.toUtf8Bytes("wrong"))).to.be
      .reverted;
    await f.escrow.connect(f.other).revealSourceKey(2, key);
    await f.escrow.submitResult(s.result, s.signature);
    await time.increaseTo((await f.escrow.getAgreement(2)).challengeDeadline);
    await f.escrow.release(2);
  });
  it("enforces period and retention bounds", async () => {
    const f = await loadFixture(fixture);
    for (const bad of [
      { challengeWindow: DAY - 1 },
      { challengeWindow: 31 * DAY },
      { retentionBps: 2001 },
      { retentionPeriod: DAY - 1 },
      { retentionPeriod: 91 * DAY },
      { deliveryDuration: 0 },
      { disputeDuration: 0 },
      { amount: 0 },
      { developer: ethers.ZeroAddress },
      { runner: ethers.ZeroAddress },
      { token: f.other.address },
    ]) {
      await expect(
        f.escrow.connect(f.client).createAgreement({ ...f.terms, ...bad })
      ).to.be.reverted;
    }
    await f.escrow
      .connect(f.client)
      .createAgreement({
        ...f.terms,
        challengeWindow: 30 * DAY,
        retentionBps: 2000,
        retentionPeriod: 90 * DAY,
      });
  });
  it("enforces exact delivery and challenge boundaries", async () => {
    const f = await loadFixture(funded);
    const s = await signed(f, { expiry: (await time.latest()) + 20 * DAY });
    await time.setNextBlockTimestamp(
      (
        await f.escrow.getAgreement(1)
      ).deliveryDeadline
    );
    await expect(f.escrow.submitResult(s.result, s.signature)).to.be.reverted;
    await expect(f.escrow.connect(f.client).fund(1)).to.be.reverted;
    const g = await loadFixture(funded);
    const a = await submit(g);
    await time.setNextBlockTimestamp(a.challengeDeadline);
    await expect(g.escrow.connect(g.client).challenge(1)).to.be.reverted;
    await g.escrow.release(1);
  });
});

describe("AuthorityEscrow evidence and conservation regressions", () => {
  it("rejects empty acceptance, runner digest and policy commitments", async () => {
    const f = await loadFixture(fixture);
    for (const field of ["acceptanceHash", "runnerDigest", "policyHash"]) {
      await expect(
        f.escrow
          .connect(f.client)
          .createAgreement({ ...f.terms, [field]: ethers.ZeroHash })
      ).to.be.reverted;
    }
  });
  it("rejects empty result and source evidence hashes", async () => {
    const f = await loadFixture(funded);
    for (const field of ["resultHash", "sourceHash"]) {
      const s = await signed(f, { [field]: ethers.ZeroHash });
      await expect(f.escrow.submitResult(s.result, s.signature)).to.be.reverted;
    }
  });
  it("isolates identical agreements against signature replay and pooled-balance leakage", async () => {
    const f = await loadFixture(funded);
    await f.escrow.connect(f.client).createAgreement(f.terms);
    await f.escrow.connect(f.developer).acceptAgreement(2);
    await f.escrow.connect(f.client).fund(2);
    await f.escrow.connect(f.developer).depositDevBond(2);
    const s = await signed(f);
    await expect(
      f.escrow.submitResult({ ...s.result, agreementId: 2 }, s.signature)
    ).to.be.reverted;
    const a = await submit(f);
    await time.increaseTo(a.challengeDeadline);
    await f.escrow.release(1);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(1200);
    await time.increaseTo((await f.escrow.getAgreement(2)).deliveryDeadline);
    await f.escrow.refundTimeout(2);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(100);
    await time.increaseTo((await f.escrow.getAgreement(1)).retentionDeadline);
    await f.escrow.releaseRetention(1);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0);
    expect(await f.token.balanceOf(f.client.address)).to.equal(9000);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(11000);
  });
  it("supports zero bonds and zero retention without residual balances", async () => {
    const f = await loadFixture(fixture);
    await f.escrow
      .connect(f.client)
      .createAgreement({
        ...f.terms,
        devBond: 0,
        challengeBond: 0,
        retentionBps: 0,
      });
    await f.escrow.connect(f.developer).acceptAgreement(2);
    await f.escrow.connect(f.developer).depositDevBond(2);
    await f.escrow.connect(f.client).fund(2);
    const s = await signed(f, { agreementId: 2 });
    await f.escrow.submitResult(s.result, s.signature);
    await f.escrow.connect(f.client).challenge(2);
    await f.escrow.connect(f.arbiter).resolve(2, true);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0);
    expect(await f.token.balanceOf(f.developer.address)).to.equal(11000);
    await expect(f.escrow.releaseRetention(2)).to.be.reverted;
  });
});

describe("AuthorityEscrow neutral authority", () => {
  for (const collision of ["zero", "client", "developer", "escrow"]) {
    it(`rejects ${collision} runner on creation and rotation`, async () => {
      const f = await loadFixture(funded);
      const runner =
        collision === "zero"
          ? ethers.ZeroAddress
          : collision === "escrow"
          ? await f.escrow.getAddress()
          : f[collision as "client" | "developer"].address;
      await expect(
        f.escrow.connect(f.client).createAgreement({ ...f.terms, runner })
      ).to.be.reverted;
      await expect(f.escrow.connect(f.client).approveAuthority(1, runner, 2)).to
        .be.reverted;
      await expect(f.escrow.connect(f.developer).approveAuthority(1, runner, 2))
        .to.be.reverted;
      expect((await f.escrow.getAgreement(1)).authorityVersion).to.equal(1);
    });
  }
});

// Compile the adversarial token in memory: no additional production/test contract files.
async function transferFixture() {
  const f = await fixture();
  const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract TransferProbe {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  uint256 public mode;
  function setMode(uint256 m) external { mode = m; }
  function mint(address to, uint256 n) external { balanceOf[to] += n; }
  function approve(address to, uint256 n) external returns (bool) { allowance[msg.sender][to] = n; return true; }
  function transferFrom(address from, address to, uint256 n) external returns (bool) {
    allowance[from][msg.sender] -= n; return move(from, to, n);
  }
  function transfer(address to, uint256 n) external returns (bool) { return move(msg.sender, to, n); }
  function move(address from, address to, uint256 n) private returns (bool) {
    if (mode == 3) return false;
    if (mode == 4) return true;
    balanceOf[from] -= n + (mode == 2 ? 1 : 0);
    balanceOf[to] += n - (mode == 1 ? 1 : 0);
    return true;
  }
}`;
  const solc = require("solc");
  const compiled = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "TransferProbe.sol": { content: source } },
        settings: {
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      })
    )
  );
  const artifact = compiled.contracts["TransferProbe.sol"].TransferProbe;
  const token: any = await new ethers.ContractFactory(
    artifact.abi,
    artifact.evm.bytecode.object,
    f.client
  ).deploy();
  for (const who of [f.client, f.developer]) {
    await token.mint(who.address, 10000);
    await token.connect(who).approve(await f.escrow.getAddress(), 10000);
  }
  await f.escrow
    .connect(f.client)
    .createAgreement({ ...f.terms, token: await token.getAddress() });
  await f.escrow.connect(f.developer).acceptAgreement(2);
  return { ...f, token };
}
describe("AuthorityEscrow exact transfer checks", () => {
  for (const mode of [1, 2, 3, 4]) {
    it(`rejects incoming token mode ${mode} without recording deposits`, async () => {
      const f = await loadFixture(transferFixture);
      await f.token.setMode(mode);
      await expect(f.escrow.connect(f.client).fund(2)).to.be.reverted;
      await expect(f.escrow.connect(f.developer).depositDevBond(2)).to.be
        .reverted;
      const a = await f.escrow.getAgreement(2);
      expect(a.priceDeposited).to.equal(false);
      expect(a.bondDeposited).to.equal(false);
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0);
      expect(await f.token.balanceOf(f.client.address)).to.equal(10000);
      expect(await f.token.balanceOf(f.developer.address)).to.equal(10000);
    });
    it(`reverts outgoing token mode ${mode} atomically and allows exact-transfer retry`, async () => {
      const f = await loadFixture(transferFixture);
      await f.escrow.connect(f.client).fund(2);
      await f.escrow.connect(f.developer).depositDevBond(2);
      const s = await signed(f, { agreementId: 2 });
      await f.escrow.submitResult(s.result, s.signature);
      await time.increaseTo((await f.escrow.getAgreement(2)).challengeDeadline);
      await f.token.setMode(mode);
      await expect(f.escrow.release(2)).to.be.reverted;
      expect((await f.escrow.getAgreement(2)).state).to.equal(3);
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(
        1100
      );
      expect(await f.token.balanceOf(f.developer.address)).to.equal(9900);
      await f.token.setMode(0);
      await f.escrow.release(2);
      expect(await f.token.balanceOf(f.developer.address)).to.equal(10900);
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(
        100
      );
    });
  }
});
