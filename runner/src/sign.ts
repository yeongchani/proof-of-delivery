/**
 * Runner step 2: sign result.json with the runner key (EIP-712) -> result.signed.json.
 *
 * Env: RUNNER_PRIVATE_KEY, CHAIN_ID, ESCROW_ADDRESS. Missing env -> prints "skipped" and exits 0.
 */
import fs from "fs";
import path from "path";
import { Wallet } from "ethers";
import { domainFor, messageToJson, signResultMessage, toMessage } from "./eip712";
import type { RunnerResult } from "./types";

const OUT_DIR = path.resolve(__dirname, "..", "out");

async function main(): Promise<void> {
  const { RUNNER_PRIVATE_KEY, CHAIN_ID, ESCROW_ADDRESS } = process.env;
  if (!RUNNER_PRIVATE_KEY || !CHAIN_ID || !ESCROW_ADDRESS) {
    console.log("[sign] skipped (RUNNER_PRIVATE_KEY / CHAIN_ID / ESCROW_ADDRESS not set)");
    return;
  }
  const resultFile = path.join(OUT_DIR, "result.json");
  if (!fs.existsSync(resultFile)) {
    console.log("[sign] skipped (runner/out/result.json not found — run `npm run runner:test` first)");
    return;
  }

  const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as RunnerResult;
  const wallet = new Wallet(RUNNER_PRIVATE_KEY);
  const message = toMessage(result);
  const signature = await signResultMessage(wallet, CHAIN_ID, ESCROW_ADDRESS, message);

  const domain = domainFor(CHAIN_ID, ESCROW_ADDRESS);
  const signed = {
    result,
    domain: { ...domain, chainId: String(domain.chainId) },
    message: messageToJson(message),
    signature,
    signer: wallet.address,
  };
  const outFile = path.join(OUT_DIR, "result.signed.json");
  fs.writeFileSync(outFile, JSON.stringify(signed, null, 2) + "\n");

  console.log(`[sign] signer=${wallet.address} chainId=${CHAIN_ID} escrow=${ESCROW_ADDRESS}`);
  console.log(`[sign] resultHash=${message.resultHash} passed=${message.passed}`);
  console.log(`[sign] wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
