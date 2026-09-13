import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseRunOptions } from "../src/execute-cli";
const dirs: string[] = [];
function options(value: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-execute-options-"));
  dirs.push(dir);
  const file = path.join(dir, "options.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return { dir, file };
}
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
);
describe("runner CLI options", () => {
  it("accepts no options for legacy sample compatibility", () =>
    expect(parseRunOptions([])).toEqual({}));
  it("resolves independent policy and output paths relative to the options JSON", () => {
    const f = options({
      deliverableDir: "candidate",
      outDir: "out",
      agreementId: 7,
      milestoneIndex: 2,
      quiet: true,
      approvedPolicy: {
        directory: "policy",
        expectedAcceptanceHash: "0x" + "1".repeat(64),
        expectedSuiteHash: "0x" + "2".repeat(64),
      },
    });
    expect(parseRunOptions(["--options", f.file])).toEqual({
      deliverableDir: path.join(f.dir, "candidate"),
      outDir: path.join(f.dir, "out"),
      agreementId: 7,
      milestoneIndex: 2,
      quiet: true,
      approvedPolicy: {
        directory: path.join(f.dir, "policy"),
        expectedAcceptanceHash: "0x" + "1".repeat(64),
        expectedSuiteHash: "0x" + "2".repeat(64),
      },
    });
  });
  it.each([
    { command: "evil" },
    { agreementId: 0 },
    { milestoneIndex: -1 },
    { quiet: "yes" },
    { outDir: 42 },
    { runnerImageDigest: "bad" },
    {
      approvedPolicy: {
        directory: "policy",
        expectedAcceptanceHash: "bad",
        expectedSuiteHash: "bad",
      },
    },
  ])("rejects invalid options %j", (value) => {
    expect(() => parseRunOptions(["--options", options(value).file])).toThrow();
  });
  it("rejects options sourced from inside the candidate", () => {
    const f = options({ deliverableDir: "." });
    expect(() => parseRunOptions(["--options", f.file])).toThrow(
      /independent/i
    );
  });
  it("rejects extra commandline arguments", () => {
    expect(() =>
      parseRunOptions(["--options", "x", "--exec", "evil"])
    ).toThrow();
  });
});
