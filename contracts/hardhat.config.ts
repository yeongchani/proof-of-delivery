import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

// Use the exact npm-locked compiler; compiling must not depend on the Solidity download host.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }: { solcVersion: string }) => {
  const longVersion: string = require("solc").version();
  if (solcVersion !== "0.8.24" || !longVersion.startsWith(`${solcVersion}+`)) {
    throw new Error(`Installed solc ${longVersion} does not match requested ${solcVersion}`);
  }
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: solcVersion, longVersion };
});

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: {},
    arbitrumSepolia: {
      url: process.env.ARB_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: deployerKey ? [deployerKey] : [],
    },
  },
  etherscan: {
    apiKey: { arbitrumSepolia: process.env.ARBISCAN_API_KEY ?? "" },
  },
  mocha: { timeout: 60_000 },
};

export default config;
