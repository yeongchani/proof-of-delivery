/** AuthorityEscrow deployment; scripts/deploy.ts remains the legacy MilestoneEscrow flow.
 * Required: DEPLOYER_PRIVATE_KEY, CHAIN_ID, ARBITER_ADDRESS, AUTHORITY_DEPLOYMENT_FILE.
 * Optional: TOKEN_ADDRESS or USE_MOCK_TOKEN=1 (no minting), DEPLOY_AUTHORITY_SEND=1.
 * Defaults to a deployment estimate. Never falls back to Hardhat's unlocked accounts.
 */
import fs from "node:fs";
import path from "node:path";
import { ContractFactory, NonceManager, Wallet } from "ethers";
import type {} from "@nomicfoundation/hardhat-ethers";
import { authorityAddress, authorityUint } from "../../runner/src/authority-envelope";

export function authorityDeploymentConfig(env: NodeJS.ProcessEnv) {
  for (const name of ["DEPLOYER_PRIVATE_KEY", "CHAIN_ID", "ARBITER_ADDRESS", "AUTHORITY_DEPLOYMENT_FILE"])
    if (!env[name]?.trim()) throw new Error(`${name} is required`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.DEPLOYER_PRIVATE_KEY!)) throw new Error("invalid deployer key");
  if (env.USE_MOCK_TOKEN !== undefined && !["0", "1"].includes(env.USE_MOCK_TOKEN)) throw new Error("USE_MOCK_TOKEN must be 0 or 1");
  if (env.DEPLOY_AUTHORITY_SEND !== undefined && !["0", "1"].includes(env.DEPLOY_AUTHORITY_SEND)) throw new Error("DEPLOY_AUTHORITY_SEND must be 0 or 1");
  if (env.USE_MOCK_TOKEN === "1" && env.TOKEN_ADDRESS) throw new Error("choose an existing token or explicit mock deployment");
  const deployer = new Wallet(env.DEPLOYER_PRIVATE_KEY!);
  const arbiter = authorityAddress(env.ARBITER_ADDRESS);
  if (arbiter === deployer.address) throw new Error("configure a neutral arbiter distinct from the deployer");
  return {
    chainId: authorityUint(env.CHAIN_ID, "chain id", true), arbiter,
    output: path.resolve(env.AUTHORITY_DEPLOYMENT_FILE!), send: env.DEPLOY_AUTHORITY_SEND === "1",
    useMockToken: env.USE_MOCK_TOKEN === "1", token: env.TOKEN_ADDRESS ? authorityAddress(env.TOKEN_ADDRESS) : undefined,
  };
}

export async function deployAuthority(env: NodeJS.ProcessEnv = process.env) {
  const config = authorityDeploymentConfig(env);
  if (fs.existsSync(config.output)) throw new Error("deployment output must be a new file");
  const { ethers, artifacts, network } = await import("hardhat");
  const actual = await ethers.provider.getNetwork();
  if (actual.chainId !== BigInt(config.chainId)) throw new Error("deployment RPC chain id mismatch");
  const wallet = new Wallet(env.DEPLOYER_PRIVATE_KEY!, ethers.provider);
  const signer = new NonceManager(wallet);
  if (config.token && await ethers.provider.getCode(config.token) === "0x") throw new Error("configured token has no contract code");
  const artifact = await artifacts.readArtifact("AuthorityEscrow");
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const deployTx = await factory.getDeployTransaction(config.arbiter);
  const gas = await ethers.provider.estimateGas({...deployTx,from:wallet.address});
  const metadata = {
    contractName:"AuthorityEscrow", domain:{name:"AuthorityEscrow",version:"1"},
    network:network.name, chainId:config.chainId, deployer:wallet.address, arbiter:config.arbiter,
    abi:artifact.abi, token:config.token ?? null, mockToken:config.useMockToken,
  };
  if (!config.send) return {mode:"dry-run",...metadata,estimatedGas:gas.toString(),output:config.output};
  // Reserve the output before spending gas. The journal is updated after each transaction,
  // so a subsequent failure does not hide a successfully deployed mock or escrow.
  fs.mkdirSync(path.dirname(config.output), {recursive:true});
  const journal: Record<string, unknown> = {mode:"deploying",...metadata};
  fs.writeFileSync(config.output, JSON.stringify(journal,null,2) + "\n", {flag:"wx",mode:0o600});
  const persist = () => fs.writeFileSync(config.output, JSON.stringify(journal,null,2) + "\n");
  try {
    if (config.useMockToken) {
      const mockArtifact = await artifacts.readArtifact("MockERC20");
      const token = await new ContractFactory(mockArtifact.abi,mockArtifact.bytecode,signer).deploy("Mock Token","MOCK",6);
      journal.tokenTx = token.deploymentTransaction()?.hash;
      persist();
      await token.waitForDeployment();
      journal.token = await token.getAddress();
      journal.tokenContractName = "MockERC20";
      journal.tokenAbi = mockArtifact.abi;
      persist();
    }
    const escrow = await factory.deploy(config.arbiter);
    journal.escrowTx = escrow.deploymentTransaction()?.hash;
    persist();
    await escrow.waitForDeployment();
    const receipt = await escrow.deploymentTransaction()!.wait();
    if (!receipt || receipt.status !== 1) throw new Error("deployment failed");
    journal.escrow = await escrow.getAddress();
    journal.block = receipt.blockNumber;
    journal.mode = "deployed";
    journal.deployedAt = new Date().toISOString();
    persist();
    return {...journal,output:config.output};
  } catch {
    journal.mode = "incomplete";
    persist();
    throw new Error("authority deployment incomplete; inspect deployment journal before retrying");
  }
}

if (require.main === module) {
  deployAuthority().then(result => console.log(JSON.stringify(result,null,2))).catch(() => {
    console.error("Authority deployment failed. Check explicit configuration, funds, chain and deployment journal.");
    process.exitCode = 1;
  });
}
