import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { sourceProvenance } from "../src/provenance";

describe("source provenance", () => {
  it("distinguishes a committed source from modified and untracked inputs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-provenance-"));
    try {
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src/app.ts"), "export const version = 1;\n");
      fs.writeFileSync(path.join(dir, "acceptance.json"), "{}\n");
      const git = (args: string[]) => {
        const p = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        expect(p.status, p.stderr).toBe(0);
        return p.stdout;
      };
      git(["init"]);
      git(["add", "."]);
      git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
      const clean = sourceProvenance(dir);
      expect(clean.sourceCommitted).toBe(true);
      fs.writeFileSync(path.join(dir, "src/app.ts"), "export const version = 2;\n");
      const dirty = sourceProvenance(dir);
      expect(dirty.sourceCommitted).toBe(false);
      expect(dirty.sourceHash).not.toBe(clean.sourceHash);
      expect(dirty.commitHash).toBe(clean.commitHash);
      git(["checkout", "--", "src/app.ts"]);
      fs.writeFileSync(path.join(dir, "src/extra.ts"), "export const extra = true;\n");
      expect(sourceProvenance(dir).sourceCommitted).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
