import { describe, expect, it } from "vitest";
import { Wallet, verifyTypedData } from "ethers";
import { authorityDomain, AUTHORITY_RESULT_TYPES, authorityUint, validateAuthoritySubmission, prepareAuthorityResult, signAuthorityEnvelope, validateAuthorityEnvelope, type AuthoritySigningInput } from "../src/authority-envelope";
import { buildAuthorityEvidence, reviewInputFor } from "../src/authority-evidence";
import { runDualReview } from "../src/ai-review";
import { createFixtureProvider } from "../src/ai-provider";
import { sourceEvidenceHash } from "../src/source-review";
import { canonicalHash } from "../src/hash";
import { runnerFingerprint } from "../src/policy";
import { sealDelivery } from "../src/delivery";
import type { RunnerResult, SourceEvidence } from "../src/types";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAuthorityCli } from "../src/authority-cli";

const hash = "0x" + "1".repeat(64);
const address = "0x1111111111111111111111111111111111111111";
describe("AuthorityEscrow domain and live submission bindings", () => {
  it("uses the actual authority domain and all nine contract fields", async () => {
    const signer = Wallet.createRandom();
    const message = { agreementId:"42", authorityVersion:"3", acceptanceHash:hash, runnerDigest:hash, policyHash:hash, resultHash:hash, sourceHash:hash, passed:false, expiry:"2000" };
    const domain = authorityDomain("31337", address);
    const signature = await signer.signTypedData(domain, AUTHORITY_RESULT_TYPES, message);
    expect(verifyTypedData({name:"AuthorityEscrow",version:"1",chainId:31337,verifyingContract:address}, AUTHORITY_RESULT_TYPES, message, signature)).toBe(signer.address);
    expect(verifyTypedData({...domain,name:"PoDAuthorityEscrow"}, AUTHORITY_RESULT_TYPES, message, signature)).not.toBe(signer.address);
    expect(verifyTypedData(domain, AUTHORITY_RESULT_TYPES, {...message,authorityVersion:"4"}, signature)).not.toBe(signer.address);
  });
  it.each(["-1", "1e3", "0x10", "01", " 1", 9007199254740992, null, true])("rejects ambiguous uint input %j", (value) => {
    expect(() => authorityUint(value, "id")).toThrow();
  });
  it("preserves integers larger than JavaScript's safe integer range", () => {
    expect(authorityUint("9007199254740993", "id")).toBe("9007199254740993");
  });
  const message = { agreementId:"42", authorityVersion:"3", acceptanceHash:hash, runnerDigest:hash, policyHash:hash, resultHash:hash, sourceHash:hash, passed:false, expiry:"2000" };
  const agreement = () => ({terms:{acceptanceHash:hash,runnerDigest:hash,policyHash:hash,sourceKeyHash:hash},runner:address,state:2n,authorityVersion:3n,revoked:false,deliveryDeadline:3000n});
  it("permits an authorized failed verdict to reach the new Failed state", () => {
    expect(() => validateAuthoritySubmission(message, address, agreement(), 1999n)).not.toThrow();
  });
  it.each([
    {state:7n}, {state:8n}, {revoked:true}, {authorityVersion:4n}, {deliveryDeadline:1999n},
    {runner:"0x2222222222222222222222222222222222222222"},
    {terms:{acceptanceHash:"0x"+"2".repeat(64),runnerDigest:hash,policyHash:hash}},
  ])("rejects stale authority, terms, state, or deadline: %#", (change) => {
    expect(() => validateAuthoritySubmission(message,address,{...agreement(),...change},1999n)).toThrow();
  });
  it("checks expiry inclusively like the contract", () => {
    expect(() => validateAuthoritySubmission(message,address,agreement(),2000n)).not.toThrow();
    expect(() => validateAuthoritySubmission(message,address,agreement(),2001n)).toThrow();
  });
  it("permits Failed rework only after objections close and before delivery expires", () => {
    const failed = {...agreement(),state:7n,challengeDeadline:1500n};
    expect(() => validateAuthoritySubmission(message,address,failed,1499n)).toThrow();
    expect(() => validateAuthoritySubmission(message,address,failed,1500n)).not.toThrow();
    expect(() => validateAuthoritySubmission({...message,expiry:"4000"},address,failed,3000n)).toThrow();
  });
});

/** Real source hashing and dual-review validation; no model or RPC. */
export async function signingFixture(): Promise<AuthoritySigningInput> {
  const acceptance = {version:"1",agreement:"unit",milestone:0,criteria:[{id:"C1",tier:1,test:"health",desc:"health works"}],trigger:"all_tier1_pass"};
  const sourceEvidence: SourceEvidence = {version:1,files:[{path:"acceptance.json",content:JSON.stringify(acceptance)},{path:"src/app.ts",content:"export const health = () => ({ok:true});\n"}]};
  const execution: RunnerResult = {
    agreementId:42,milestoneIndex:0,acceptanceHash:canonicalHash(acceptance),runnerImageDigest:runnerFingerprint(),
    commitHash:"a".repeat(40),sourceHash:sourceEvidenceHash(sourceEvidence),sourceCommitted:true,sourceEvidence,
    passed:true,criteria:[{id:"C1",passed:true,evidence:'{"status":200,"body":{"ok":true}}'}],
    timestamp:1234,logUrl:"unit",execution:{exitCode:0,reportSuccess:true},
  };
  const reviewInput = reviewInputFor(execution,acceptance);
  const response = {content:JSON.stringify({criteria:[{id:"C1",passed:true,citations:[{evidenceId:"C1",quote:reviewInput.evidence[0].text}]}]})};
  const ai = await runDualReview(reviewInput,{provider:createFixtureProvider([response,response])});
  const evidence = buildAuthorityEvidence(execution,ai,acceptance,ai.policyHash,31337n);
  const manifest = {version:1 as const,acceptance,aiPolicyHash:ai.policyHash,sourcePackageHash:hash,sourceKeyHash:"0x"+"0".repeat(64),runnerDigest:execution.runnerImageDigest};
  return {acceptance,execution,ai,manifest,chainId:"31337",escrowAddress:address,agreementId:"42",authorityVersion:"3",expiry:String(Math.floor(Date.now()/1000)+3600),expectedReviewHash:evidence.resultHash,expectedPolicyHash:ai.policyHash};
}

describe("source-bound signing and imported envelopes", () => {
  it("binds acceptance inside execution and the full manifest on chain", async () => {
    const input = await signingFixture();
    const signer = Wallet.createRandom();
    const envelope = await signAuthorityEnvelope(input,signer.privateKey);
    expect(envelope.message.acceptanceHash).toBe(canonicalHash(input.manifest));
    expect(envelope.evidence.execution.acceptanceHash).toBe(canonicalHash(input.acceptance));
    expect(envelope.message.acceptanceHash).not.toBe(envelope.evidence.execution.acceptanceHash);
    expect(envelope.evidence.version).toBe(2);
    expect(validateAuthorityEnvelope(envelope,input).signer).toBe(signer.address);
  });
  it.each(["review","policy","runner","agreement","acceptance","source"])("rejects substituted %s before signing", async (field) => {
    const input = await signingFixture();
    if (field === "review") input.expectedReviewHash = hash;
    if (field === "policy") input.expectedPolicyHash = hash;
    if (field === "runner") input.execution.runnerImageDigest = hash;
    if (field === "agreement") input.agreementId = "43";
    if (field === "acceptance") input.manifest.acceptance = {...input.acceptance,agreement:"other"};
    if (field === "source") input.execution.sourceEvidence!.files[1].content = "other source";
    expect(() => prepareAuthorityResult(input)).toThrow();
  });
  it.each(["domain","message","evidence","signature","manifest"])("rejects tampered imported %s", async (field) => {
    const input = await signingFixture();
    const envelope = await signAuthorityEnvelope(input,Wallet.createRandom().privateKey);
    if (field === "domain") envelope.domain.name = "MilestoneEscrow";
    if (field === "message") envelope.message.passed = false;
    if (field === "evidence") envelope.evidence.execution.criteria[0].evidence = "altered";
    if (field === "signature") envelope.signature = "0x";
    if (field === "manifest") envelope.manifest.sourcePackageHash = "0x"+"2".repeat(64);
    expect(() => validateAuthorityEnvelope(envelope,input)).toThrow();
  });
  it("requires verified encrypted source before signing and never publishes the key", async () => {
    const input = await signingFixture();
    const delivery = sealDelivery(Buffer.from(JSON.stringify(input.execution.sourceEvidence)));
    input.manifest.sourceKeyHash = delivery.keyHash;
    input.manifest.sourcePackageHash = delivery.packageHash;
    const wallet = Wallet.createRandom();
    await expect(signAuthorityEnvelope(input,wallet.privateKey)).rejects.toThrow("delivery");
    input.delivery = {envelope:delivery.envelope,key:delivery.key};
    const signed = await signAuthorityEnvelope(input,wallet.privateKey);
    expect(JSON.stringify(signed)).not.toContain(delivery.key);
    expect(JSON.stringify(signed)).not.toContain(wallet.privateKey);
    expect(validateAuthorityEnvelope(signed,input).message.sourceHash).toBe(input.execution.sourceHash);
  });
  it("rejects a decryptable package containing different source", async () => {
    const input = await signingFixture();
    const different = structuredClone(input.execution.sourceEvidence!);
    different.files[1].content = "export const substituted = true;";
    const delivery = sealDelivery(Buffer.from(JSON.stringify(different)));
    input.manifest.sourceKeyHash = delivery.keyHash;
    input.manifest.sourcePackageHash = delivery.packageHash;
    input.delivery = {envelope:delivery.envelope,key:delivery.key};
    await expect(signAuthorityEnvelope(input,Wallet.createRandom().privateKey)).rejects.toThrow("source");
  });
  it("signs explicit files with a plaintext key, never overwrites, and leaves no output on rejection", async () => {
    const input = await signingFixture();
    const sealed = sealDelivery(Buffer.from(JSON.stringify(input.execution.sourceEvidence)));
    input.manifest.sourceKeyHash = sealed.keyHash;
    input.manifest.sourcePackageHash = sealed.packageHash;
    const wallet = Wallet.createRandom();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-authority-sign-unit-"));
    try {
      const file = (name: string, value: unknown) => {
        const p = path.join(dir,name);
        fs.writeFileSync(p,JSON.stringify(value),{flag:"wx"});
        return p;
      };
      const key = path.join(dir,"delivery.key");
      fs.writeFileSync(key,sealed.key+"\n",{flag:"wx"});
      const output = path.join(dir,"signed.json");
      const args = ["sign","--chain-id","31337","--escrow",address,"--execution",file("execution.json",input.execution),"--review",file("review.json",input.ai),
        "--acceptance",file("acceptance.json",input.acceptance),"--manifest",file("manifest.json",input.manifest),"--agreement-id","42","--authority-version","3",
        "--expiry",String(input.expiry),"--expected-review-hash",input.expectedReviewHash,"--expected-policy-hash",input.expectedPolicyHash,"--output",output,
        "--delivery",file("delivery.json",sealed.envelope),"--delivery-key-file",key];
      await expect(runAuthorityCli(args,{})).rejects.toThrow("AUTHORITY_PRIVATE_KEY");
      const wrong = [...args]; wrong[wrong.indexOf("--expected-review-hash")+1] = hash;
      await expect(runAuthorityCli(wrong,{AUTHORITY_PRIVATE_KEY:wallet.privateKey})).rejects.toThrow();
      expect(fs.existsSync(output)).toBe(false);
      const result = await runAuthorityCli(args,{AUTHORITY_PRIVATE_KEY:wallet.privateKey});
      expect(result.mode).toBe("signed");
      const bytes = fs.readFileSync(output,"utf8");
      expect(bytes).not.toContain(sealed.key);
      expect(bytes).not.toContain(wallet.privateKey);
      expect(validateAuthorityEnvelope(JSON.parse(bytes),input).signer).toBe(wallet.address);
      await expect(runAuthorityCli(args,{AUTHORITY_PRIVATE_KEY:wallet.privateKey})).rejects.toThrow("new file");
      expect(fs.readFileSync(output,"utf8")).toBe(bytes);
    } finally {
      if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("pod-authority-sign-unit-")) throw new Error("unexpected test temp path");
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });
  it("builds independently reviewable evidence files without a wallet or RPC", async () => {
    const input = await signingFixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-authority-evidence-unit-"));
    try {
      const file = (name: string, value: unknown) => { const p=path.join(dir,name); fs.writeFileSync(p,JSON.stringify(value),{flag:"wx"}); return p; };
      const output = path.join(dir,"evidence.json");
      const args = ["evidence","--chain-id","31337","--escrow",address,"--execution",file("execution.json",input.execution),"--review",file("review.json",input.ai),
        "--acceptance",file("acceptance.json",input.acceptance),"--expected-policy-hash",input.expectedPolicyHash,"--output",output];
      const wrong = [...args]; wrong[wrong.indexOf("--expected-policy-hash")+1] = hash;
      await expect(runAuthorityCli(wrong,{})).rejects.toThrow();
      expect(fs.existsSync(output)).toBe(false);
      const result = await runAuthorityCli(args,{});
      expect(result.mode).toBe("evidence");
      expect(result.resultHash).toBe(input.expectedReviewHash);
      expect(JSON.parse(fs.readFileSync(output,"utf8"))).toMatchObject({version:2,resultHash:input.expectedReviewHash});
      await expect(runAuthorityCli(args,{})).rejects.toThrow("new file");
    } finally {
      if (path.dirname(dir)!==path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("pod-authority-evidence-unit-")) throw new Error("unexpected test temp path");
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });
});
