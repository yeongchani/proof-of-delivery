import fs from "fs";
import path from "path";
import { validateDependencyGraph } from "./dependency-guard";
import { canonicalHash } from "./hash";
import { assertNoSymlinkPath } from "./provenance";
import type { Acceptance } from "./types";

export interface ApprovedPolicyOptions {
  directory: string;
  acceptancePath?: string;
  configFile?: string;
  expectedAcceptanceHash: string;
  expectedSuiteHash: string;
}
function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
function configPath(directory: string, configFile: string): string {
  if (
    !/^[A-Za-z0-9_.\/-]+$/.test(configFile) ||
    configFile.split("/").some((x) => !x || x === "." || x === "..") ||
    path.isAbsolute(configFile)
  )
    throw new Error("invalid approved policy config path");
  const file = path.resolve(directory, configFile);
  if (!inside(directory, file)) throw new Error("policy config outside bundle");
  return file;
}
/** Hash every bundle file (including helpers/config/data), except its non-executable acceptance JSON to avoid a circular hash.
 * Third-party/runtime dependencies remain bound by the separately approved runner digest.
 */
export function approvedPolicySuiteHash(
  directory: string,
  configFile = "vitest.config.ts",
  acceptancePath?: string
): string {
  const root = path.resolve(directory),
    config = configPath(root, configFile);
  assertNoSymlinkPath(root);
  const acceptance = path.resolve(
    acceptancePath ?? path.join(root, "acceptance.json")
  );
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  function read(dir: string) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, entry),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink())
        throw new Error("policy symlinks are not supported");
      if (stat.isDirectory()) read(file);
      else {
        if (!stat.isFile()) throw new Error("policy requires regular files");
        if (file === acceptance) continue;
        bytes += stat.size;
        if (bytes > 4 * 1024 * 1024 || Object.keys(files).length >= 128)
          throw new Error("approved policy bundle exceeds bounds");
        files[path.relative(root, file).split(path.sep).join("/")] = fs
          .readFileSync(file)
          .toString("base64");
      }
    }
  }
  read(root);
  validateDependencyGraph(root, files, "policy");
  if (
    !fs.existsSync(config) ||
    !Object.prototype.hasOwnProperty.call(files, configFile)
  )
    throw new Error("missing approved policy config");
  return canonicalHash({ version: 1, configFile, files });
}
export function loadApprovedPolicy(
  options: ApprovedPolicyOptions,
  deliverableDir: string
): { acceptance: Acceptance; configPath: string; suiteHash: string } {
  const root = path.resolve(options.directory),
    candidate = path.resolve(deliverableDir);
  assertNoSymlinkPath(root);
  assertNoSymlinkPath(candidate);
  if (inside(candidate, root) || inside(root, candidate))
    throw new Error("approved policy must be separate from candidate");
  if (
    ![options.expectedAcceptanceHash, options.expectedSuiteHash].every((h) =>
      /^0x[0-9a-f]{64}$/.test(h)
    )
  )
    throw new Error("explicit approved policy hashes required");
  const acceptancePath = path.resolve(
    options.acceptancePath ?? path.join(root, "acceptance.json")
  );
  assertNoSymlinkPath(acceptancePath);
  if (
    inside(candidate, acceptancePath) ||
    path.extname(acceptancePath) !== ".json"
  )
    throw new Error("independent acceptance JSON required");
  const configFile = options.configFile ?? "vitest.config.ts";
  const suiteHash = approvedPolicySuiteHash(root, configFile, acceptancePath);
  const acceptance = JSON.parse(
    fs.readFileSync(acceptancePath, "utf8")
  ) as Acceptance;
  if (
    suiteHash !== options.expectedSuiteHash ||
    acceptance.testSuiteHash !== suiteHash ||
    canonicalHash(acceptance) !== options.expectedAcceptanceHash
  )
    throw new Error(
      "acceptance/test suite differs from independently approved policy"
    );
  return { acceptance, configPath: configPath(root, configFile), suiteHash };
}
