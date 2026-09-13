import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { runAcceptance } from "../src/run-tests";

const root = path.resolve(__dirname, "../..");
const fixtures: string[] = [];
function candidate(app: string) {
  const dir = fs.mkdtempSync(path.join(root, ".pod-test-"));
  fixtures.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.copyFileSync(path.join(root, "example-deliverable/acceptance.json"), path.join(dir, "acceptance.json"));
  fs.writeFileSync(path.join(dir, "src/app.ts"), app);
  const report = {
    success: true,
    testResults: [
      {
        assertionResults: ["health", "create item", "rejects missing name", "get item", "404 unknown"].map((title) => ({
          title,
          fullName: `example API ${title}`,
          status: "passed",
        })),
      },
    ],
  };
  fs.writeFileSync(
    path.join(dir, "fake.cjs"),
    `require('fs').writeFileSync('package-command-ran','yes');require('fs').writeFileSync('test-results.json',${JSON.stringify(
      JSON.stringify(report)
    )});process.exit(1);`
  );
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node fake.cjs" } }));
  return dir;
}
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("trusted acceptance execution", () => {
  it("ignores the deliverable test command and fails an implementation that only returns errors", () => {
    const dir = candidate(
      'import express from "express"; export const app=express(); app.use((_req,res)=>res.status(500).end());'
    );
    const result = runAcceptance({ deliverableDir: dir, outDir: null, quiet: true });
    expect(result.passed).toBe(false);
    expect(result.sourceCommitted).toBe(false);
    expect(result.sourceHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(dir, "package-command-ran"))).toBe(false);
  }, 30000);
  it("does not pass when a suite fails to load", () => {
    const dir = candidate('throw new Error("broken module"); export const app = null;');
    expect(runAcceptance({ deliverableDir: dir, outDir: null, quiet: true }).passed).toBe(false);
  }, 30000);
  it("rejects a candidate that changes the agreed test-suite fingerprint", () => {
    const dir = candidate("export const app = null;");
    const file = path.join(dir, "acceptance.json");
    const acceptance = JSON.parse(fs.readFileSync(file, "utf8"));
    acceptance.testSuiteHash = "0x" + "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(acceptance));
    const outDir = path.join(dir, "out");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, "result.json"), "stale");
    fs.writeFileSync(path.join(outDir, "result.signed.json"), "stale");
    expect(() => runAcceptance({ deliverableDir: dir, outDir, quiet: true })).toThrow(/suite|acceptance/i);
    expect(fs.existsSync(path.join(outDir, "result.json"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "result.signed.json"))).toBe(false);
  }, 30000);
});
