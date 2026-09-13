/**
 * Runner step 3: submit the signed result to MilestoneEscrow.submitResult on-chain.
 *
 * Env: RPC_URL, RUNNER_PRIVATE_KEY, ESCROW_ADDRESS. Missing env -> prints "skipped (no RPC)" and exits 0.
 */
import fs from "fs";
import path from "path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { ESCROW_ABI, MILESTONE_STATES } from "./abi";
import { validateSignedEnvelope } from "./envelope";
import { validateReviewedResult } from "./review";

const OUT_DIR = path.resolve(__dirname, "..", "out");

async function main(): Promise<void> {
  const { RPC_URL, RUNNER_PRIVATE_KEY, ESCROW_ADDRESS } = process.env;
  if (!RPC_URL || !RUNNER_PRIVATE_KEY || !ESCROW_ADDRESS) {
    console.log("[submit] skipped (no RPC)");
    return;
  }
  const signedFile = process.env.SIGNED_RESULT_FILE || path.join(OUT_DIR, "result.signed.json");
  if (!fs.existsSync(signedFile)) {
    throw new Error("signed result file not found");
  }

  const envelope = JSON.parse(fs.readFileSync(signedFile, "utf8"));
  const { result, signature } = envelope;
  // Validate the agreement lookup input before making any RPC requests.
  validateReviewedResult(result, process.env.REVIEWED_RESULT_HASH);

  const provider = new JsonRpcProvider(RPC_URL);
  const { chainId } = await provider.getNetwork();
  const wallet = new Wallet(RUNNER_PRIVATE_KEY, provider);
  const escrow = new Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);
  const agreement = await escrow.getAgreement(BigInt(result.agreementId));
  const m = validateSignedEnvelope(
    envelope, process.env.REVIEWED_RESULT_HASH, chainId, ESCROW_ADDRESS, agreement.runner
  );

  const milestone = await escrow.getMilestone(m.agreementId, m.milestoneIndex);
  const state = MILESTONE_STATES[Number(milestone.state)] ?? String(milestone.state);
  if (state !== "Funded") {
    console.log(
      `[submit] skipped (milestone ${m.agreementId}/${m.milestoneIndex} is ${state}, submitResult requires Funded)`
    );
    return;
  }

  console.log(
    `[submit] submitting agreement=${m.agreementId} milestone=${m.milestoneIndex} passed=${m.passed} as ${wallet.address}`
  );
  const tx = await escrow.submitResult(m.agreementId, m.milestoneIndex, m, signature);
  console.log(`[submit] tx ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[submit] mined in block ${receipt.blockNumber} (status=${receipt.status})`);

  for (const log of receipt.logs) {
    try {
      const parsed = escrow.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      if (parsed.name === "VerificationSubmitted") {
        const at = Number(parsed.args.releasableAt);
        console.log(`[submit] VerificationSubmitted — releasable at ${at} (${new Date(at * 1000).toISOString()})`);
      } else if (parsed.name === "VerificationFailed") {
        console.log("[submit] VerificationFailed — milestone stays Funded (rework needed)");
      }
    } catch {
      /* not our event */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
