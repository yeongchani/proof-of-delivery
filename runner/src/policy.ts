import fs from "fs";
import path from "path";
import { canonicalHash } from "./hash";

export const REPO_ROOT = path.resolve(__dirname, "../..");
const suiteFiles = ["runner/acceptance/api.test.ts", "runner/acceptance/vitest.config.ts"];
function fingerprint(files: string[]): string {
  return canonicalHash(
    Object.fromEntries(
      files.sort().map((file) => [file, fs.readFileSync(path.join(REPO_ROOT, file), "utf8").replace(/\r\n/g, "\n")])
    )
  );
}
export function testSuiteHash(): string {
  return fingerprint(suiteFiles);
}
/** Fingerprint of reviewed source/dependencies, NOT hardware/runtime attestation. */
export function runnerFingerprint(): string {
  const sources = fs
    .readdirSync(path.join(REPO_ROOT, "runner/src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `runner/src/${f}`);
  return fingerprint([...suiteFiles, ...sources, "package-lock.json"]);
}
if (require.main === module) {
  console.log(`testSuiteHash=${testSuiteHash()}`);
  console.log(`runnerImageDigest=${runnerFingerprint()}`);
}
