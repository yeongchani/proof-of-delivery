import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateReviewRecord } from "../src/ai-review";
import { verifyHistoricalAuthorityEvidenceV1 } from "../src/authority-evidence";

describe("archived live records: offline consistency only, NOT provider authenticity or new inference",()=>{
  it("rebuilds the historical v1 settlement without claiming it ran the current code",()=>{
    const record=JSON.parse(fs.readFileSync(path.resolve(__dirname,"../fixtures/codex-live/authority-demo.json"),"utf8"));
    const rebuilt=verifyHistoricalAuthorityEvidenceV1(record.evidence.execution,record.evidence.ai,record.manifest.acceptance,record.manifest.aiPolicyHash,31337n);
    expect(record.aiMode).toBe("live");
    expect(rebuilt.passed).toBe(true);
    expect(rebuilt.resultHash).toBe(record.signedResult.message.resultHash);
    // Source fingerprint of the archived f2cf5c9 run, deliberately not the current runner.
    expect(record.manifest.runnerDigest).toBe("0xe59e100b65937c0a667faeb1ca9708318b2db84486a605c81a489a01cae5455f");
  });
  const cases: [string,boolean][] = [
    ["before-observations/normal.json",false],
    ["before-observations/missing.json",false],
    ["before-observations/injection.json",false],
    ["with-observations/normal.json",true],
    ["with-observations/missing.json",false],
    ["with-observations/injection.json",false],
    ["contradictory.json",false],
  ];
  it.each(cases)("revalidates hashes, quotes, votes and token accounting: %s",(file,passed)=>{
    const record=JSON.parse(fs.readFileSync(path.resolve(__dirname,"../fixtures/codex-live",file),"utf8"));
    expect(()=>validateReviewRecord(record,record.policyHash)).not.toThrow();
    expect(record.mode).toBe("live");expect(record.passed).toBe(passed);
    expect(record.usage.complete).toBe(true);
  });
});
