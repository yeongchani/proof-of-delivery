/** Local RPC integration test of the public CLI. Every wallet below is a PUBLIC Hardhat test wallet. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { ContractFactory, HDNodeWallet, JsonRpcProvider } from "ethers";
import { runAcceptance } from "../../runner/src/run-tests";
import { runnerFingerprint } from "../../runner/src/policy";
import { runDualReview } from "../../runner/src/ai-review";
import { createFixtureProvider } from "../../runner/src/ai-provider";
import { reviewInputFor, buildAuthorityEvidence } from "../../runner/src/authority-evidence";
import { collectSourceEvidence } from "../../runner/src/source-review";
import { canonicalHash } from "../../runner/src/hash";
import { sealDelivery, openDelivery } from "../../runner/src/delivery";

const ROOT = path.resolve(__dirname, "../..");
const DAY = 86400;
const encode = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);

async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-authority-cli-"));
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const nodeEnv: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"])
    if (process.env[key]) nodeEnv[key] = process.env[key];
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/hardhat/internal/cli/cli.js"), "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(ROOT, "contracts"), env: nodeEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  let childError: Error | undefined;
  child.on("error", error => { childError = error; });
  child.stdout.on("data", bytes => { if (bytes.toString().includes("Started HTTP and WebSocket JSON-RPC server")) ready = true; });
  child.stderr.resume(); // Hardhat's unsupported local Node warning is not a test result.
  const provider = new JsonRpcProvider(rpc, undefined, {cacheTimeout: -1});
  const steps: Record<string, unknown>[] = [];
  try {
    for (let i = 0; i < 120 && !ready; i++) {
      if (childError || child.exitCode !== null) throw childError ?? new Error("local RPC exited before listening");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(ready, "local RPC readiness timeout");
    assert.equal((await provider.getNetwork()).chainId, 31337n);
    const wallets = Array.from({length:5}, (_, i) => HDNodeWallet.fromPhrase(
      "test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`
    ));
    const [arbiter, client, developer, runner, caller] = wallets;
    const signer = await provider.getSigner(0);
    const artifact = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, `contracts/artifacts/contracts/${name}.sol/${name}.json`), "utf8"));
    const t = artifact("MockERC20"), a = artifact("AuthorityEscrow");
    const token: any = await new ContractFactory(t.abi, t.bytecode, signer).deploy("CLI test token", "TST", 6);
    await token.waitForDeployment();
    const escrow: any = await new ContractFactory(a.abi, a.bytecode, signer).deploy(arbiter.address);
    await escrow.waitForDeployment();
    const address = await escrow.getAddress();
    await (await token.mint(client.address, 1000)).wait();
    await (await token.mint(developer.address, 100)).wait();
    const acceptance = JSON.parse(fs.readFileSync(path.join(ROOT, "example-deliverable/acceptance.json"), "utf8"));
    const execution = runAcceptance({agreementId:1, outDir:null, quiet:true});
    assert(execution.passed, "acceptance execution failed");
    const input = reviewInputFor(execution, acceptance);
    const reply = {content:JSON.stringify({criteria:input.criteria.map(c => ({id:c.id,passed:true,citations:[{evidenceId:c.id,quote:input.evidence.find(e=>e.id===c.id)!.text}]}))})};
    const ai = await runDualReview(input, {provider:createFixtureProvider([reply,reply], "synthetic-cli-smoke-v1")});
    const evidence = buildAuthorityEvidence(execution, ai, acceptance, ai.policyHash, 31337n);
    assert(evidence.passed);
    const delivery = sealDelivery(Buffer.from(JSON.stringify(collectSourceEvidence(path.join(ROOT, "example-deliverable")))));
    const manifest = {version:1, acceptance, aiPolicyHash:ai.policyHash, sourcePackageHash:delivery.packageHash, sourceKeyHash:delivery.keyHash, runnerDigest:runnerFingerprint()};
    let serial = 0;
    const write = (name: string, value: unknown) => {
      const file = path.join(dir, `${++serial}-${name}.json`);
      fs.writeFileSync(file, encode(value), {flag:"wx"});
      return file;
    };
    const base = ["--chain-id", "31337", "--escrow", address];
    const cli = (args: string[], wallet?: HDNodeWallet, signing = false) => {
      const env: NodeJS.ProcessEnv = {...nodeEnv, RPC_URL:rpc};
      if (wallet) env[signing ? "AUTHORITY_PRIVATE_KEY" : "TRANSACTION_PRIVATE_KEY"] = wallet.privateKey;
      const result = spawnSync(process.execPath, [path.join(ROOT,"node_modules/tsx/dist/cli.mjs"), path.join(ROOT,"runner/src/authority-cli.ts"), ...args], {
        cwd:ROOT, env, encoding:"utf8", timeout:20000, windowsHide:true,
      });
      assert.equal(result.status, 0, `CLI ${args[0]} failed: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      steps.push({command:args[0],method:output.method,mode:output.mode,transactionHash:output.transactionHash});
      return output;
    };
    const call = (method: string, args: unknown[], wallet: HDNodeWallet, send=true) => cli([
      "call",...base,"--method",method,"--args",write(method,args),"--from",wallet.address,...(send?["--send"]:[])
    ], send ? wallet : undefined);
    const terms = {developer:developer.address,runner:runner.address,token:await token.getAddress(),acceptanceHash:canonicalHash(manifest),runnerDigest:manifest.runnerDigest,policyHash:ai.policyHash,
      amount:300,devBond:30,challengeBond:10,challengeWindow:DAY,deliveryDuration:14*DAY,disputeDuration:7*DAY,retentionBps:1000,retentionPeriod:30*DAY,sourceKeyHash:delivery.keyHash};
    const dryCreate = call("createAgreement",[terms],client,false);
    assert.equal(dryCreate.mode,"dry-run");
    assert.equal(await escrow.nextAgreementId(),1n,"dry run must not mutate chain");
    assert.deepEqual(call("createAgreement",[terms],client).createdAgreementIds,["1"]);
    call("acceptAgreement",[1],developer);
    for (const wallet of [client,developer]) cli(["approve-token",...base,"--token",await token.getAddress(),"--amount","1000","--send"],wallet);
    call("fund",[1],client); call("depositDevBond",[1],developer);
    const executionFile=write("execution",execution), reviewFile=write("review",ai), acceptanceFile=write("acceptance",acceptance), manifestFile=write("manifest",manifest);
    const evidenceFile=path.join(dir,"evidence.json");
    const built=cli(["evidence",...base,"--execution",executionFile,"--review",reviewFile,"--acceptance",acceptanceFile,
      "--expected-policy-hash",ai.policyHash,"--output",evidenceFile]);
    assert.equal(built.resultHash,evidence.resultHash);
    assert.equal(JSON.parse(fs.readFileSync(evidenceFile,"utf8")).version,2);
    const keyFile=path.join(dir,"delivery.key"); fs.writeFileSync(keyFile,delivery.key,{flag:"wx"});
    const envelopeFile=path.join(dir,"signed.json");
    const expiry=String((await provider.getBlock("latest"))!.timestamp+DAY);
    cli(["sign",...base,"--execution",executionFile,"--review",reviewFile,"--acceptance",acceptanceFile,"--manifest",manifestFile,"--agreement-id","1","--authority-version","1","--expiry",expiry,
      "--expected-review-hash",evidence.resultHash,"--expected-policy-hash",ai.policyHash,"--output",envelopeFile,"--delivery",write("delivery",delivery.envelope),"--delivery-key-file",keyFile],runner,true);
    assert(!fs.readFileSync(envelopeFile,"utf8").includes(delivery.key),"signed evidence must not disclose the private handover key");
    const submit=["submit",...base,"--input",envelopeFile,"--acceptance",acceptanceFile,"--expected-review-hash",evidence.resultHash,"--expected-policy-hash",ai.policyHash];
    assert.equal(cli(submit).mode,"dry-run");
    assert.equal((await escrow.getAgreement(1)).state,2n);
    cli([...submit,"--send"],caller);
    assert.equal((await escrow.getAgreement(1)).state,3n);
    const deadline=Number((await escrow.getAgreement(1)).challengeDeadline);
    await provider.send("evm_setNextBlockTimestamp",[deadline]); await provider.send("evm_mine",[]);
    call("revealSourceKey",[1,delivery.key],developer);
    assert.equal((await escrow.getAgreement(1)).state,5n);
    assert.equal(await token.balanceOf(developer.address),370n);
    assert.equal(await token.balanceOf(address),30n);
    assert.deepEqual(JSON.parse(openDelivery(delivery.envelope,delivery.key,delivery.keyHash,delivery.packageHash).toString("utf8")),execution.sourceEvidence);
    await provider.send("evm_setNextBlockTimestamp",[Number((await escrow.getAgreement(1)).retentionDeadline)]); await provider.send("evm_mine",[]);
    call("releaseRetention",[1],caller);
    assert.equal(await token.balanceOf(developer.address),400n);
    assert.equal(await token.balanceOf(client.address),700n);
    assert.equal(await token.balanceOf(address),0n);
    const report={version:1,network:"hardhat-local-rpc",aiMode:"synthetic",publicTestWallets:true,steps,sourceHash:execution.sourceHash,evidenceHash:evidence.resultHash,runnerDigest:manifest.runnerDigest,
      finalBalances:{client:"700",developer:"400",escrow:"0"}};
    const output=path.join(ROOT,"runner/out/authority-cli-smoke.json");
    fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,encode(report)+"\n");
    console.log(`Authority CLI roundtrip passed: ${steps.length} commands, dry runs preserved state, source handover and payout verified.`);
  } finally {
    provider.destroy();
    if (child.pid && child.exitCode===null) {
      if (process.platform==="win32") spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      else child.kill("SIGTERM");
      await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else {child.once("exit",()=>resolve());setTimeout(()=>{child.kill("SIGKILL");resolve();},3000).unref();}});
    }
    // Only the freshly-created, resolved temp directory is removed.
    assert(path.dirname(dir)===path.resolve(os.tmpdir()) && path.basename(dir).startsWith("pod-authority-cli-"));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
