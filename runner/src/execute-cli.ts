import fs from "fs";
import path from "path";
import type { RunOptions } from "./run-tests";
import type { ApprovedPolicyOptions } from "./approved-policy";
import { assertNoSymlinkPath } from "./provenance";

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new Error("unknown or invalid runner options field");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 2048 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error("invalid runner options path");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value))
    throw new Error("explicit lowercase 32-byte approval hash required");
  return value;
}
function within(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
/** JSON data only. Relative paths resolve against this independently supplied options file. */
export function parseRunOptions(args: string[]): RunOptions {
  if (!args.length) return {};
  if (args.length !== 2 || args[0] !== "--options")
    throw new Error("usage: run-tests.ts [--options <approved-options.json>]");
  const file = path.resolve(text(args[1]));
  assertNoSymlinkPath(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 65536 || path.extname(file) !== ".json")
    throw new Error("runner options must be a bounded JSON file");
  const raw = object(JSON.parse(fs.readFileSync(file, "utf8")), [
    "deliverableDir",
    "outDir",
    "agreementId",
    "milestoneIndex",
    "runnerImageDigest",
    "quiet",
    "approvedPolicy",
  ]);
  const base = path.dirname(file),
    result: RunOptions = {};
  for (const key of ["deliverableDir", "outDir"] as const) {
    if (raw[key] === undefined) continue;
    if (key === "outDir" && raw[key] === null) result.outDir = null;
    else result[key] = path.resolve(base, text(raw[key]));
  }
  const candidate =
    result.deliverableDir ??
    path.resolve(__dirname, "../../example-deliverable");
  if (within(candidate, file))
    throw new Error("runner approval options must be independent of candidate");
  for (const key of ["agreementId", "milestoneIndex"] as const) {
    if (raw[key] === undefined) continue;
    if (
      !Number.isSafeInteger(raw[key]) ||
      (raw[key] as number) < (key === "agreementId" ? 1 : 0)
    )
      throw new Error("invalid runner agreement/milestone number");
    result[key] = raw[key] as number;
  }
  if (raw.quiet !== undefined) {
    if (typeof raw.quiet !== "boolean")
      throw new Error("quiet must be boolean");
    result.quiet = raw.quiet;
  }
  if (raw.runnerImageDigest !== undefined)
    result.runnerImageDigest = hash(raw.runnerImageDigest);
  if (raw.approvedPolicy !== undefined) {
    const value = object(raw.approvedPolicy, [
      "directory",
      "acceptancePath",
      "configFile",
      "expectedAcceptanceHash",
      "expectedSuiteHash",
    ]);
    const policy: ApprovedPolicyOptions = {
      directory: path.resolve(base, text(value.directory)),
      expectedAcceptanceHash: hash(value.expectedAcceptanceHash),
      expectedSuiteHash: hash(value.expectedSuiteHash),
    };
    if (value.acceptancePath !== undefined)
      policy.acceptancePath = path.resolve(base, text(value.acceptancePath));
    if (value.configFile !== undefined) {
      const config = text(value.configFile);
      if (
        !/^[A-Za-z0-9_.\/-]+$/.test(config) ||
        path.isAbsolute(config) ||
        config.split("/").some((s) => !s || s === "." || s === "..")
      )
        throw new Error("invalid approved policy config file");
      policy.configFile = config;
    }
    result.approvedPolicy = policy;
  }
  return result;
}
