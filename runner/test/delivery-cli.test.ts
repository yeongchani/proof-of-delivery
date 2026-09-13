import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDeliveryCli } from "../src/delivery-cli";
import { collectSourceEvidence } from "../src/source-review";
import { openDelivery } from "../src/delivery";

describe("private delivery package preparation", () => {
  it("seals every reviewed input, keeps the key in a separate file, and refuses overwrite", () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"pod-delivery-cli-"));
    try {
      const candidate=path.resolve(__dirname,"../../example-deliverable");
      const out=path.join(root,"delivery");
      const result=runDeliveryCli(["seal","--source",candidate,"--output-dir",out]);
      const commitments=JSON.parse(fs.readFileSync(path.join(out,"commitments.json"),"utf8"));
      const envelope=JSON.parse(fs.readFileSync(path.join(out,"delivery.json"),"utf8"));
      const key=fs.readFileSync(path.join(out,"delivery.key"),"utf8").trim();
      expect(JSON.stringify(result)).not.toContain(key);
      expect(JSON.stringify(commitments)).not.toContain(key);
      expect(JSON.parse(openDelivery(envelope,key,commitments.sourceKeyHash,commitments.sourcePackageHash).toString("utf8"))).toEqual(collectSourceEvidence(candidate));
      expect(()=>runDeliveryCli(["seal","--source",candidate,"--output-dir",out])).toThrow();
      expect(fs.readFileSync(path.join(out,"delivery.key"),"utf8").trim()).toBe(key);
    } finally {
      expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
  it("rejects missing, duplicate, unknown arguments before creating output",()=>{
    for (const args of [[],["seal"],["open"],["seal","--source","x","--source","y"],["seal","--source","x","--output-dir","y","--force"]])
      expect(()=>runDeliveryCli(args)).toThrow();
  });
});
