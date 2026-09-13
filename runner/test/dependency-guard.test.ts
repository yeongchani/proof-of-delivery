import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { collectSourceEvidence } from "../src/source-review";
import { sourceProvenance } from "../src/provenance";
import { approvedPolicySuiteHash } from "../src/approved-policy";
import { guardedExecutionConfig } from "../src/dependency-guard";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.resolve(__dirname, "../../.pod-dependency-test-"));
  roots.push(root);
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(path.join(candidate, "src"), {recursive:true});
  fs.writeFileSync(path.join(candidate, "acceptance.json"), "{}");
  return {root, candidate};
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root,{recursive:true,force:true})));
describe("closed candidate and policy dependencies", () => {
  it("rejects CommonJS directory package redirects outside the delivered source", () => {
    const {candidate}=fixture();
    fs.mkdirSync(path.join(candidate,"src/helper"));
    fs.writeFileSync(path.join(candidate,"src/app.ts"),"export const value=require('./helper');");
    fs.writeFileSync(path.join(candidate,"src/helper/index.json"),"{}");
    fs.writeFileSync(path.join(candidate,"src/helper/package.json"),'{"main":"../../implementation.cjs"}');
    fs.writeFileSync(path.join(candidate,"implementation.cjs"),"module.exports=42;");
    expect(()=>collectSourceEvidence(candidate)).toThrow(/config|resolution|dependency/i);
  });
  it("rejects an escaped implementation even though changing it leaves sourceHash unchanged", () => {
    const {candidate} = fixture();
    fs.writeFileSync(path.join(candidate,"src/app.ts"), "export {value} from '../implementation';");
    fs.writeFileSync(path.join(candidate,"implementation.ts"), "export const value=1;");
    const before=sourceProvenance(candidate).sourceHash;
    fs.writeFileSync(path.join(candidate,"implementation.ts"), "export const value=2;");
    expect(sourceProvenance(candidate).sourceHash).toBe(before);
    expect(()=>collectSourceEvidence(candidate)).toThrow(/dependency|import|outside/i);
  });
  it("rejects a policy package resolved from an external ancestor node_modules", () => {
    const {root}=fixture(), policy=path.join(root,"policy"), helper=path.join(root,"node_modules/review-helper");
    fs.mkdirSync(policy);fs.mkdirSync(helper,{recursive:true});
    fs.writeFileSync(path.join(helper,"index.js"),"module.exports={};");
    fs.writeFileSync(path.join(policy,"vitest.config.ts"),"import helper from 'review-helper'; export default helper;");
    expect(()=>approvedPolicySuiteHash(policy)).toThrow(/dependency|approved|runner/i);
  });
  it.each([
    "const name='./helper'; import(name);",
    "const name='./helper'; require(name);",
    "const load=require; load('../other');",
    "module.require('../other');",
    "import {createRequire} from 'node:module';",
    "import fs from 'fs';",
    "eval('require(\"../other\")');",
    "new Function('return 1');",
    "import value from '#private';",
  ])("rejects unsupported runtime loading: %s", source => {
    const {candidate}=fixture();fs.writeFileSync(path.join(candidate,"src/app.ts"),source);
    expect(()=>collectSourceEvidence(candidate)).toThrow();
  });
  it("rejects a symlinked candidate dependency directory", () => {
    const {root,candidate}=fixture();
    fs.mkdirSync(path.join(root,"node_modules"));
    fs.symlinkSync(path.resolve(__dirname,"../../node_modules/express"),path.join(root,"node_modules/express"),"junction");
    fs.writeFileSync(path.join(candidate,"src/app.ts"),"import express from 'express'; export const app=express();");
    expect(()=>collectSourceEvidence(candidate)).toThrow(/symlink|outside|approved/i);
  });
  it("rejects config aliases and plugins that could redirect checked imports", () => {
    const {root,candidate}=fixture(),policy=path.join(root,"policy");
    const config={resolve:{alias:{express:path.join(root,"outside.ts")}},test:{root:policy,include:["*.test.ts"]}};
    expect(()=>guardedExecutionConfig(config,candidate,policy,["src/app.ts"],[])).toThrow(/alias/i);
    expect(()=>guardedExecutionConfig({test:config.test,plugins:[{}]},candidate,policy,[],[])).toThrow(/config/i);
  });
  it("allows internal literal imports, locked express and erased type-only imports", () => {
    const {candidate}=fixture();
    fs.writeFileSync(path.join(candidate,"src/app.ts"),"import type {Missing} from '../types-not-delivered'; import express from 'express'; export {value} from './helper'; const lazy=()=>import('./helper');");
    fs.writeFileSync(path.join(candidate,"src/helper.ts"),"export const value=42;");
    expect(collectSourceEvidence(candidate).files).toHaveLength(3);
  });
  it.each([
    ["package.json", '{"imports":{"#private":"./outside.js"}}'],
    ["tsconfig.json", '{"compilerOptions":{"paths":{"express":["./outside"]}}}'],
    ["package.json", '{"name":"express","exports":"./outside.js"}'],
    ["package.json", '{"type":"module"}'],
    ["tsconfig.json", '{"extends":"../external.json"}'],
    ["tsconfig.json", '{"compilerOptions":{"baseUrl":"../"}}'],
    ["tsconfig.json", '{"compilerOptions":{"plugins":[{"name":"loader"}]}}'],
    ["tsconfig.json", '{"compilerOptions":{"importHelpers":true}}'],
    ["tsconfig.json", '{"compilerOptions":{"jsxImportSource":"other"}}'],
  ])("rejects unbound resolution settings in %s", (file,content)=>{
    const {candidate}=fixture();fs.writeFileSync(path.join(candidate,"src/app.ts"),"export const value=1;");
    fs.writeFileSync(path.join(candidate,file),content);
    expect(()=>collectSourceEvidence(candidate)).toThrow(/config|resolution|package/i);
  });
});
