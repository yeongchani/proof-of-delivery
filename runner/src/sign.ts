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
import { validateReviewedResult } from "./review";

const OUT_DIR = path.resolve(__dirname, "..", "out");

async function main(): Promise<void> {
  const outFile = process.env.SIGNED_RESULT_FILE || path.join(OUT_DIR, "result.signed.json");
  fs.rmSync(outFile, { force: true });
  const { RUNNER_PRIVATE_KEY, CHAIN_ID, ESCROW_ADDRESS } = process.env;
  if (!RUNNER_PRIVATE_KEY || !CHAIN_ID || !ESCROW_ADDRESS) {
    console.log("[sign] skipped (RUNNER_PRIVATE_KEY / CHAIN_ID / ESCROW_ADDRESS not set)");
    return;
  }
  const resultFile = process.env.RESULT_FILE || path.join(OUT_DIR, "result.json");
  if (!fs.existsSync(resultFile)) {
    throw new Error("result file not found");
  }

  const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as RunnerResult;
  validateReviewedResult(result, process.env.REVIEWED_RESULT_HASH);
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
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(signed, null, 2) + "\n");

  console.log(`[sign] signer=${wallet.address} chainId=${CHAIN_ID} escrow=${ESCROW_ADDRESS}`);
  console.log(`[sign] resultHash=${message.resultHash} passed=${message.passed}`);
  console.log(`[sign] wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
