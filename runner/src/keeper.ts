import fs from "fs";
import path from "path";
import { Contract, JsonRpcProvider, Wallet, isAddress } from "ethers";

interface TimedAgreement {
  state: bigint;
  deliveryDeadline: bigint;
  challengeDeadline: bigint;
  disputeDeadline: bigint;
  retentionDeadline: bigint;
  retained: bigint;
}
export function dueAction(
  a: TimedAgreement,
  now: bigint
): "release" | "releaseRetention" | "refundTimeout" | null {
  if (a.state === 3n && now >= a.challengeDeadline) return "release";
  if (a.state === 5n && a.retained > 0n && now >= a.retentionDeadline)
    return "releaseRetention";
  if ((a.state === 1n || a.state === 2n) && now >= a.deliveryDeadline)
    return "refundTimeout";
  if (a.state === 4n && now >= a.disputeDeadline) return "refundTimeout";
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const ids = args.filter((x) => x !== "--send");
  if (
    !ids.length ||
    ids.length > 50 ||
    ids.some((id) => !/^[1-9][0-9]*$/.test(id))
  )
    throw new Error(
      "usage: keeper.ts <agreement IDs> [--send]; default dry run"
    );
  const { RPC_URL, AUTHORITY_ESCROW_ADDRESS, CHAIN_ID, KEEPER_PRIVATE_KEY } =
    process.env;
  if (!RPC_URL || !isAddress(AUTHORITY_ESCROW_ADDRESS ?? "") || !CHAIN_ID)
    throw new Error(
      "RPC_URL, AUTHORITY_ESCROW_ADDRESS and CHAIN_ID are required"
    );
  const provider = new JsonRpcProvider(RPC_URL);
  try {
    if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID))
      throw new Error("chain mismatch");
    if (send && !KEEPER_PRIVATE_KEY)
      throw new Error(
        "--send requires KEEPER_PRIVATE_KEY (gas only, no escrow ownership)"
      );
    const artifact = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../contracts/artifacts/contracts/AuthorityEscrow.sol/AuthorityEscrow.json"
        ),
        "utf8"
      )
    );
    const contract = new Contract(
      AUTHORITY_ESCROW_ADDRESS!,
      artifact.abi,
      send ? new Wallet(KEEPER_PRIVATE_KEY!, provider) : provider
    );
    for (const id of [...new Set(ids)]) {
      const block = await provider.getBlock("latest");
      if (!block) throw new Error("missing chain time");
      const action = dueAction(
        await contract.getAgreement(id),
        BigInt(block.timestamp)
      );
      if (!action) {
        console.log(`${id}: no action due`);
        continue;
      }
      // Simulate current on-chain conditions before sending. A competing keeper can still win the race; no retry.
      await contract[action].staticCall(id);
      if (!send) {
        console.log(`${id}: ${action} due (dry run)`);
        continue;
      }
      const tx = await contract[action](id);
      await tx.wait();
      console.log(`${id}: ${action} ${tx.hash}`);
    }
  } finally {
    provider.destroy();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Keeper failed; check configuration, compiled artifact and current agreement state. No automatic retry."
    );
    process.exitCode = 1;
  });
