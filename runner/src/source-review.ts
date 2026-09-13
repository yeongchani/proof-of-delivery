import path from "path";
import { validateDependencyGraph } from "./dependency-guard";
import { canonicalHash } from "./hash";
import { readSourceFiles } from "./provenance";
import type { Acceptance, SourceEvidence } from "./types";
import { AI_LIMITS } from "./ai-review";

export const SOURCE_EVIDENCE_LIMITS = Object.freeze({
  maxFiles: 32,
  maxBytes: 48000,
  maxFileBytes: 7000,
});
const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".md",
  ".txt",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
  ".sh",
]);
function safePath(file: unknown): asserts file is string {
  if (
    typeof file !== "string" ||
    file.length > 240 ||
    file.includes("\\") ||
    !file
      .split("/")
      .every((s) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s) && s !== "..") ||
    (file !== "acceptance.json" &&
      (!file.startsWith("src/") ||
        !extensions.has(path.posix.extname(file).toLowerCase())))
  )
    throw new Error("unsafe or unsupported source evidence path");
  if (
    file
      .split("/")
      .some((s) =>
        /^(?:secrets?|credentials?|private[_-]?keys?|node_modules)(?:[._-]|$)/i.test(
          s
        )
      )
  )
    throw new Error("sensitive source evidence path");
}
function safeContent(content: unknown): asserts content is string {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > SOURCE_EVIDENCE_LIMITS.maxFileBytes ||
    content.includes("\0") ||
    Buffer.from(content, "utf8").toString("utf8") !== content
  )
    throw new Error("invalid or oversized UTF-8 source evidence");
  // This is an explicit accidental-secret guard, not automatic anonymization or a secret scanner guarantee.
  if (
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\b(?:api[_-]?key|password|secret|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_+\/-]{16,}["']/i.test(
      content
    )
  )
    throw new Error(
      "potential secret in source evidence; provide a reviewed secret-free source"
    );
}
function snapshot(value: unknown): SourceEvidence {
  const v = value as SourceEvidence;
  if (
    !v ||
    typeof v !== "object" ||
    Object.keys(v).sort().join(",") !== "files,version" ||
    v.version !== 1 ||
    !Array.isArray(v.files) ||
    v.files.length < 2 ||
    v.files.length > SOURCE_EVIDENCE_LIMITS.maxFiles
  )
    throw new Error("complete source evidence required");
  let bytes = 0;
  const seen = new Set<string>();
  const files = v.files.map((f) => {
    if (
      !f ||
      typeof f !== "object" ||
      Object.keys(f).sort().join(",") !== "content,path"
    )
      throw new Error("invalid source evidence file");
    safePath(f.path);
    safeContent(f.content);
    if (
      JSON.stringify({
        kind: "untrusted-source",
        path: f.path,
        content: f.content,
      }).length > AI_LIMITS.evidenceChars
    )
      throw new Error("escaped source evidence exceeds AI bounds");
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new Error("duplicate source evidence path");
    seen.add(key);
    bytes += Buffer.byteLength(f.content);
    if (bytes > SOURCE_EVIDENCE_LIMITS.maxBytes)
      throw new Error("source evidence exceeds bounds");
    return { path: f.path, content: f.content };
  });
  if (
    !files.some((f) => f.path === "acceptance.json") ||
    !files.some((f) => f.path.startsWith("src/"))
  )
    throw new Error("complete source evidence required");
  return {
    version: 1,
    files: files.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    ),
  };
}
export function sourceEvidenceHash(value: unknown): string {
  const evidence = snapshot(value);
  return canonicalHash(
    Object.fromEntries(
      evidence.files.map((f) => [
        f.path,
        Buffer.from(f.content, "utf8").toString("base64"),
      ])
    )
  );
}
export function validateSourceEvidence(
  value: unknown,
  expectedSourceHash: string,
  acceptance?: Acceptance
): SourceEvidence {
  const evidence = snapshot(value);
  if (sourceEvidenceHash(evidence) !== expectedSourceHash)
    throw new Error("source evidence hash substitution");
  if (
    acceptance &&
    canonicalHash(
      JSON.parse(
        evidence.files.find((f) => f.path === "acceptance.json")!.content
      )
    ) !== canonicalHash(acceptance)
  )
    throw new Error("source acceptance substitution");
  return evidence;
}
/** Includes every provenance input. Unsupported/secret/binary/oversize files reject the complete collection. */
export function collectSourceEvidence(deliverableDir: string): SourceEvidence {
  const files = readSourceFiles(deliverableDir, SOURCE_EVIDENCE_LIMITS);
  const result = snapshot({
    version: 1,
    files: Object.entries(files).map(([file, base64]) => {
      const raw = Buffer.from(base64, "base64"),
        content = raw.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(raw))
        throw new Error("invalid UTF-8 source evidence");
      return { path: file, content };
    }),
  });
  validateDependencyGraph(deliverableDir, files, "candidate");
  return result;
}
