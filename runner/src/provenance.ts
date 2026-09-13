import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { canonicalHash } from "./hash";

/** Reject symlinks/junctions in the selected directory and all its ancestors. */
export function assertNoSymlinkPath(file: string): void {
  let current = path.resolve(file);
  for (;;) {
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error("candidate/policy symlinks are not supported");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Shared exact-byte enumeration. Keep the path->base64 algorithm compatible with archived hashes. */
export function readSourceFiles(
  dir: string,
  limits?: { maxBytes: number; maxFiles: number; maxFileBytes: number }
): Record<string, string> {
  assertNoSymlinkPath(dir);
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  function read(relative: string) {
    const file = path.join(dir, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink())
      throw new Error("candidate symlinks are not supported");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        read(`${relative}/${name}`);
    } else {
      if (!stat.isFile()) throw new Error("source must be a regular file");
      if (
        limits &&
        (stat.size > limits.maxFileBytes ||
          bytes + stat.size > limits.maxBytes ||
          Object.keys(files).length >= limits.maxFiles)
      )
        throw new Error(
          "source evidence exceeds bounds; no files may be omitted or truncated"
        );
      const content = fs.readFileSync(file);
      bytes += content.length;
      if (
        limits &&
        (content.length > limits.maxFileBytes || bytes > limits.maxBytes)
      )
        throw new Error("source evidence exceeds bounds");
      files[relative] = content.toString("base64");
    }
  }
  read("src");
  read("acceptance.json");
  return files;
}

/** Hash the actual candidate inputs. This describes files; it does not attest execution. */
export function sourceProvenance(dir: string): {
  sourceHash: string;
  sourceCommitted: boolean;
  commitHash: string;
} {
  const files = readSourceFiles(dir);
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]);
  const commit = head.stdout?.trim() ?? "";
  const status = git([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "src",
    "acceptance.json",
  ]);
  const tracked = git(["ls-files", "-z", "--", "src", "acceptance.json"]);
  const trackedPaths = new Set(
    (tracked.stdout ?? "").split("\0").filter(Boolean)
  );
  const sourceCommitted =
    head.status === 0 &&
    /^[0-9a-f]{40}$/.test(commit) &&
    status.status === 0 &&
    !status.stdout.trim() &&
    tracked.status === 0 &&
    Object.keys(files).every((f) => trackedPaths.has(f)) &&
    trackedPaths.size === Object.keys(files).length;
  return {
    sourceHash: canonicalHash(files),
    sourceCommitted,
    commitHash: /^[0-9a-f]{40}$/.test(commit) ? commit : "0".repeat(40),
  };
}

if (require.main === module) {
  const dir = path.resolve(
    process.argv[2] || path.join(__dirname, "../../example-deliverable")
  );
  console.log(JSON.stringify(sourceProvenance(dir), null, 2));
}
