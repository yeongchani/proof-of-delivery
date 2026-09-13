import fs from "fs";
import path from "path";
import {
  AI_LIMITS,
  runDualReview,
  runRequirementDraft,
  type ProviderResponse,
} from "./ai-review";
import {
  createFixtureProvider,
  createLiveProviderFromEnv,
} from "./ai-provider";

const USAGE =
  "Usage: ai-cli.ts (--synthetic --fixture <responses.json> | --live) --input <input.json> --output <new-output.json> [--draft] [--timeout-ms <1..120000>] [--max-requests <1..8>] [--max-output-tokens <1..8192>]";
function readJson(file: string, maxBytes: number): unknown {
  const fd = fs.openSync(file, "r");
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > maxBytes)
      throw new Error("invalid_input_file");
    const data = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < data.length) {
      const n = fs.readSync(fd, data, length, data.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > maxBytes) throw new Error("input_too_large");
    return JSON.parse(data.subarray(0, length).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
/** Reads only explicitly named files. Does not import or execute candidate code. */
export async function runAiCli(args: string[]): Promise<number> {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flags.has(flag) || values.has(flag)) throw new Error(USAGE);
    if (["--synthetic", "--live", "--draft"].includes(flag)) flags.add(flag);
    else if (
      [
        "--fixture",
        "--input",
        "--output",
        "--timeout-ms",
        "--max-requests",
        "--max-output-tokens",
      ].includes(flag) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      values.set(flag, args[++i]);
    else throw new Error(USAGE);
  }
  if (
    flags.has("--live") === flags.has("--synthetic") ||
    !values.has("--input") ||
    !values.has("--output") ||
    flags.has("--synthetic") !== values.has("--fixture")
  )
    throw new Error(USAGE);
  const inputPath = path.resolve(values.get("--input")!);
  const outputPath = path.resolve(values.get("--output")!);
  if (inputPath === outputPath || fs.existsSync(outputPath))
    throw new Error("output_must_be_new_file");
  const input = readJson(inputPath, AI_LIMITS.inputBytes);
  let provider;
  if (flags.has("--synthetic")) {
    const fixture = readJson(
      values.get("--fixture")!,
      AI_LIMITS.responseBytes * 8
    ) as { mode?: unknown; responses?: unknown };
    if (
      fixture?.mode !== "synthetic" ||
      !Array.isArray(fixture.responses) ||
      fixture.responses.length < 1 ||
      fixture.responses.length > 8
    )
      throw new Error("invalid_synthetic_fixture");
    provider = createFixtureProvider(fixture.responses as ProviderResponse[]);
  } else provider = createLiveProviderFromEnv();
  const numeric = (flag: string) =>
    values.has(flag) ? Number(values.get(flag)) : undefined;
  const options = {
    provider,
    timeoutMs: numeric("--timeout-ms"),
    maxRequests: numeric("--max-requests"),
    maxOutputTokens: numeric("--max-output-tokens"),
  };
  const result = flags.has("--draft")
    ? await runRequirementDraft(
        input as Parameters<typeof runRequirementDraft>[0],
        options
      )
    : await runDualReview(
        input as Parameters<typeof runDualReview>[0],
        options
      );
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `${
      result.mode === "synthetic"
        ? "SYNTHETIC FIXTURE DEMO (not an accuracy benchmark)"
        : "LIVE PROVIDER REVIEW"
    }: ${
      "passed" in result ? (result.passed ? "passed" : "failed") : result.status
    }; calls=${result.calls}`
  );
  return result.error ? 2 : "passed" in result && !result.passed ? 1 : 0;
}
if (require.main === module) {
  runAiCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        `AI CLI failed. Check explicit input, provider configuration and output path. ${USAGE}`
      );
      process.exitCode = 2;
    });
}
