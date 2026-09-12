/**
 * Deploy MilestoneEscrow (+ MockERC20 when USE_MOCK_TOKEN=1) and write deployments/<network>.json.
 *
 *   npm run deploy:sepolia      (env: ARB_SEPOLIA_RPC, DEPLOYER_PRIVATE_KEY, USE_MOCK_TOKEN | USDC_ADDRESS, ARBISCAN_API_KEY?)
 */
import { ethers, network, run } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer account — set DEPLOYER_PRIVATE_KEY");
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`network=${network.name} chainId=${chainId} deployer=${deployer.address}`);

  let tokenAddress: string;
  let tokenTx: string | undefined;
  if (process.env.USE_MOCK_TOKEN === "1") {
    const token = await ethers.deployContract("MockERC20", ["Mock USDC", "USDC", 6]);
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    tokenTx = token.deploymentTransaction()?.hash;
    await (await token.mint(deployer.address, ethers.parseUnits("10000", 6))).wait();
    console.log(`MockERC20 deployed at ${tokenAddress} (minted 10,000 USDC to deployer)`);
  } else {
    tokenAddress = process.env.USDC_ADDRESS ?? "";
    if (!ethers.isAddress(tokenAddress)) throw new Error("set USDC_ADDRESS (or USE_MOCK_TOKEN=1)");
    console.log(`using existing token ${tokenAddress}`);
  }

  const escrow = await ethers.deployContract("MilestoneEscrow", [deployer.address]);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  const receipt = await escrow.deploymentTransaction()?.wait();
  console.log(`MilestoneEscrow deployed at ${escrowAddress} (block ${receipt?.blockNumber})`);

  const out = {
    network: network.name,
    chainId: Number(chainId),
    escrow: escrowAddress,
    token: tokenAddress,
    deployer: deployer.address,
    block: receipt?.blockNumber ?? null,
    escrowTx: escrow.deploymentTransaction()?.hash ?? null,
    tokenTx: tokenTx ?? null,
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}`);

  if (process.env.ARBISCAN_API_KEY && network.name !== "hardhat") {
    console.log("verifying on Arbiscan (waiting a few blocks)...");
    await new Promise((r) => setTimeout(r, 20_000));
    try {
      await run("verify:verify", { address: escrowAddress, constructorArguments: [deployer.address] });
      if (process.env.USE_MOCK_TOKEN === "1") {
        await run("verify:verify", { address: tokenAddress, constructorArguments: ["Mock USDC", "USDC", 6] });
      }
    } catch (err) {
      console.warn("verification failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
