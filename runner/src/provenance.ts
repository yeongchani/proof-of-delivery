import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { canonicalHash } from "./hash";

/** Hash the actual candidate inputs. This describes files; it does not attest execution. */
export function sourceProvenance(dir: string): { sourceHash: string; sourceCommitted: boolean; commitHash: string } {
  const files: Record<string, string> = Object.create(null);
  function read(relative: string) {
    const file = path.join(dir, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("candidate symlinks are not supported");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) read(`${relative}/${name}`);
    } else {
      files[relative] = fs.readFileSync(file).toString("base64");
    }
  }
  read("src");
  read("acceptance.json");
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]);
  const commit = head.stdout?.trim() ?? "";
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", "src", "acceptance.json"]);
  const tracked = git(["ls-files", "-z", "--", "src", "acceptance.json"]);
  const trackedPaths = new Set((tracked.stdout ?? "").split("\0").filter(Boolean));
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
  const dir = path.resolve(process.argv[2] || path.join(__dirname, "../../example-deliverable"));
  console.log(JSON.stringify(sourceProvenance(dir), null, 2));
}
