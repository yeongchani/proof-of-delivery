import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateReviewRecord } from "../src/ai-review";

describe("archived live records: offline consistency only, NOT provider authenticity or new inference",()=>{
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
