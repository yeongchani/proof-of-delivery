/** AuthorityEscrow workflow. Legacy sign.ts/submit.ts target the separate legacy protocol.
 * sign: AUTHORITY_PRIVATE_KEY; submit/call: RPC_URL; --send: TRANSACTION_PRIVATE_KEY.
 * All file paths and chain/contract targets are explicit. Transactions default to eth_call.
 */
import fs from "node:fs";
import path from "node:path";
import { Contract, Interface, JsonRpcProvider, Wallet, id } from "ethers";
import { REPO_ROOT } from "./policy";
import { buildAuthorityEvidence } from "./authority-evidence";
import {
  authorityAddress, authorityUint, AUTHORITY_RESULT_TYPES, signAuthorityEnvelope,
  validateAuthorityEnvelope, validateAuthoritySubmission,
} from "./authority-envelope";

const USAGE = "authority-cli <evidence|sign|submit|call|approve-token> --chain-id <decimal> --escrow <address> [explicit command flags]; transactions require --send";
const common = ["--chain-id", "--escrow"];
const required: Record<string, string[]> = {
  evidence: [...common, "--execution", "--review", "--acceptance", "--expected-policy-hash", "--output"],
  sign: [...common, "--execution", "--review", "--acceptance", "--manifest", "--agreement-id", "--authority-version", "--expiry", "--expected-review-hash", "--expected-policy-hash", "--output"],
  submit: [...common, "--input", "--acceptance", "--expected-review-hash", "--expected-policy-hash"],
  call: [...common, "--method", "--args"],
  "approve-token": [...common, "--token", "--amount"],
};
export function parseAuthorityArgs(args: string[]) {
  const [command, ...rest] = args;
  if (!Object.prototype.hasOwnProperty.call(required, command ?? "")) throw new Error(USAGE);
  const optional = command === "evidence" ? [] : command === "sign" ? ["--delivery", "--delivery-key-file"] : ["--artifact", "--from"];
  const values: Record<string, string> = {};
  let send = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--send" && ["submit","call","approve-token"].includes(command) && !send) { send = true; continue; }
    if (![...required[command], ...optional].includes(flag) || Object.prototype.hasOwnProperty.call(values, flag) || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(USAGE);
    values[flag] = rest[++i];
  }
  if (required[command].some(flag => !values[flag])) throw new Error(USAGE);
  authorityUint(values["--chain-id"], "chain id", true);
  authorityAddress(values["--escrow"]);
  if (values["--from"]) authorityAddress(values["--from"]);
  if (Boolean(values["--delivery"]) !== Boolean(values["--delivery-key-file"])) throw new Error("delivery and delivery key file must be supplied together");
  // Submitting via generic calldata would bypass local evidence and authority checks.
  if (command === "call" && (!/^[A-Za-z][A-Za-z0-9]*$/.test(values["--method"]) || values["--method"] === "submitResult")) throw new Error("use submit for validated authority evidence");
  return { command, values, send };
}
function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  if (!env[name]?.trim()) throw new Error(`${name} is required`);
  return env[name]!;
}
/** Bound reads before JSON parsing, including files that grow after stat. */
export function readAuthorityJson(file: string): any {
  const fd = fs.openSync(file, "r");
  const limit = 16 * 1024 * 1024;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("authority input file exceeds limit");
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > limit) throw new Error("authority input file exceeds limit");
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally { fs.closeSync(fd); }
}
function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);
}
function readDeliveryKey(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("invalid delivery key file");
    const bytes = Buffer.alloc(129);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length-length, null);
      if (!n) break;
      length += n;
    }
    const key = bytes.subarray(0,length).toString("utf8").trim();
    if (length > 128 || !/^0x[0-9a-f]{64}$/.test(key)) throw new Error("invalid delivery key file");
    return key;
  } finally { fs.closeSync(fd); }
}
function transactionWallet(env: NodeJS.ProcessEnv, provider: JsonRpcProvider) {
  const key = requiredEnv(env, "TRANSACTION_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("invalid TRANSACTION_PRIVATE_KEY");
  return new Wallet(key, provider);
}
export function loadAuthorityAbi(file?: string) {
  const artifact = readAuthorityJson(file ?? path.join(REPO_ROOT, "contracts/artifacts/contracts/AuthorityEscrow.sol/AuthorityEscrow.json"));
  if (artifact.contractName !== "AuthorityEscrow" || !Array.isArray(artifact.abi)) throw new Error("compiled AuthorityEscrow ABI required");
  return artifact.abi;
}
function safeArgs(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error("--args must contain a JSON array");
  const visit = (v: unknown): void => {
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error("use decimal strings for contract integers");
    if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
}

/** Returns JSON-safe data via CLI serialization. No RPC or model defaults, and no secret logging. */
export async function runAuthorityCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const { command, values: v, send } = parseAuthorityArgs(args);
  const chainId = authorityUint(v["--chain-id"], "chain id", true);
  const escrowAddress = authorityAddress(v["--escrow"]);
  if (command === "evidence") {
    if (fs.existsSync(v["--output"])) throw new Error("authority output must be a new file");
    const evidence = buildAuthorityEvidence(readAuthorityJson(v["--execution"]),readAuthorityJson(v["--review"]),readAuthorityJson(v["--acceptance"]),v["--expected-policy-hash"],BigInt(chainId));
    if (Number(evidence.version) !== 2) throw new Error("source-bound authority evidence version 2 required");
    fs.writeFileSync(v["--output"],json(evidence)+"\n",{flag:"wx",mode:0o600});
    return {mode:"evidence",output:path.resolve(v["--output"]),chainId,escrow:escrowAddress,resultHash:evidence.resultHash,passed:evidence.passed};
  }
  if (command === "sign") {
    const key = requiredEnv(env, "AUTHORITY_PRIVATE_KEY");
    if (fs.existsSync(v["--output"])) throw new Error("authority output must be a new file");
    const envelope = await signAuthorityEnvelope({
      execution:readAuthorityJson(v["--execution"]), ai:readAuthorityJson(v["--review"]),
      acceptance:readAuthorityJson(v["--acceptance"]), manifest:readAuthorityJson(v["--manifest"]),
      chainId, escrowAddress, agreementId:v["--agreement-id"], authorityVersion:v["--authority-version"], expiry:v["--expiry"],
      expectedReviewHash:v["--expected-review-hash"], expectedPolicyHash:v["--expected-policy-hash"],
      delivery:v["--delivery"] ? {envelope:readAuthorityJson(v["--delivery"]),key:readDeliveryKey(v["--delivery-key-file"])} : undefined,
    }, key);
    fs.writeFileSync(v["--output"], json(envelope) + "\n", {flag:"wx",mode:0o600});
    return {mode:"signed",output:path.resolve(v["--output"]),signer:envelope.signer,domain:envelope.domain,message:envelope.message};
  }
  const rpc = requiredEnv(env, "RPC_URL");
  // Validate sender configuration before initiating RPC, even when the input files are bad.
  if (send) requiredEnv(env, "TRANSACTION_PRIVATE_KEY");
  const provider = new JsonRpcProvider(rpc);
  try {
    const actual = await provider.getNetwork();
    if (actual.chainId !== BigInt(chainId)) throw new Error("RPC chain id mismatch");
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("missing chain head");
    const blockTag = block.number;
    if (await provider.getCode(escrowAddress, blockTag) === "0x") throw new Error("escrow has no contract code");
    const abi = loadAuthorityAbi(v["--artifact"]);
    const escrow = new Contract(escrowAddress, abi, provider);
    const domain = await escrow.eip712Domain({blockTag});
    if (domain.name !== "AuthorityEscrow" || domain.version !== "1" || BigInt(domain.chainId) !== BigInt(chainId) || authorityAddress(domain.verifyingContract) !== escrowAddress) throw new Error("contract EIP-712 domain mismatch");
    const wallet = send ? transactionWallet(env, provider) : undefined;
    if (wallet && v["--from"] && wallet.address !== authorityAddress(v["--from"])) throw new Error("--from differs from transaction signer");
    let from = wallet?.address ?? (v["--from"] ? authorityAddress(v["--from"]) : undefined);
    let target = escrow;
    let method: string;
    let methodArgs: any[];
    if (command === "submit") {
      const envelope = validateAuthorityEnvelope(readAuthorityJson(v["--input"]), {
        acceptance:readAuthorityJson(v["--acceptance"]), chainId, escrowAddress,
        expectedReviewHash:v["--expected-review-hash"], expectedPolicyHash:v["--expected-policy-hash"], now:BigInt(block.timestamp),
      });
      const expectedTypeHash = id("Result(" + AUTHORITY_RESULT_TYPES.Result.map(f => `${f.type} ${f.name}`).join(",") + ")");
      if (await escrow.RESULT_TYPEHASH({blockTag}) !== expectedTypeHash) throw new Error("contract Result schema mismatch");
      const agreement = await escrow.getAgreement(envelope.message.agreementId, {blockTag});
      validateAuthoritySubmission(envelope.message, envelope.signer, agreement, BigInt(block.timestamp));
      if (String(agreement.terms.sourceKeyHash).toLowerCase() !== envelope.manifest.sourceKeyHash.toLowerCase()) throw new Error("agreement source key commitment mismatch");
      from ??= envelope.signer; // submitResult is permissionless; this only sets the simulation sender.
      method = "submitResult";
      methodArgs = [envelope.message, envelope.signature];
    } else if (command === "approve-token") {
      const token = authorityAddress(v["--token"]);
      if (await provider.getCode(token, blockTag) === "0x") throw new Error("token has no contract code");
      target = new Contract(token, ["function approve(address spender,uint256 amount) returns (bool)"], provider);
      method = "approve";
      methodArgs = [escrowAddress, authorityUint(v["--amount"], "approval amount")];
    } else {
      method = v["--method"];
      methodArgs = readAuthorityJson(v["--args"]);
      safeArgs(methodArgs);
    }
    const fragment = target.interface.getFunction(method);
    if (!fragment) throw new Error("method absent from compiled ABI");
    const readOnly = fragment.stateMutability === "view" || fragment.stateMutability === "pure";
    if (readOnly && send) throw new Error("read-only method cannot use --send");
    if (!readOnly && !from) throw new Error("--from required for transaction simulation");
    const simulated = await target.getFunction(method).staticCall(...methodArgs, {blockTag,...(from ? {from} : {})});
    if (command === "approve-token" && simulated !== true) throw new Error("token approval returned false");
    const to = await target.getAddress();
    if (!send) return {mode:readOnly ? "read" : "dry-run",chainId,to,from,method,blockNumber:block.number,result:simulated};
    // Pending-state simulation catches state changes since the binding snapshot; the contract
    // independently enforces bindings/expiry atomically when the transaction is mined.
    await target.connect(wallet!).getFunction(method).staticCall(...methodArgs, {blockTag:"pending"});
    const tx = await target.connect(wallet!).getFunction(method)(...methodArgs);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("authority transaction failed");
    const createdAgreementIds: string[] = [];
    const iface = new Interface(abi);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
      try { const event = iface.parseLog(log); if (event?.name === "AgreementCreated") createdAgreementIds.push(event.args.id.toString()); } catch { /* unrelated log */ }
    }
    return {mode:"sent",chainId,to,from,method,transactionHash:tx.hash,blockNumber:receipt.blockNumber,status:receipt.status,createdAgreementIds};
  } finally { provider.destroy(); }
}

if (require.main === module) {
  runAuthorityCli(process.argv.slice(2)).then(result => console.log(json(result))).catch(() => {
    // Provider/wallet errors can contain RPC credentials, raw transactions or private input.
    console.error("Authority CLI failed. Check explicit files, environment, bindings and current contract state. " + USAGE);
    process.exitCode = 1;
  });
}
