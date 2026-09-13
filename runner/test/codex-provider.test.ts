import { describe, it, expect } from "vitest";
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCodexProvider } from "../src/codex-provider";
import { runAiCli } from "../src/ai-cli";

function fixture(mode = "ok") {
  const script = path.resolve(__dirname, "fixtures/fake-codex.cjs");
  const invocations: { args: readonly string[]; options: SpawnOptions }[] = [];
  const launch: typeof spawn = ((
    binary: string,
    args: string[],
    options: SpawnOptions
  ) => {
    invocations.push({ args: [...args], options });
    return spawn(process.execPath, [script, mode, ...args], options);
  }) as typeof spawn;
  return { launch, invocations };
}
const req = () => ({
  system: "Return JSON only.",
  user: '{"text":"$(echo stolen); & <tag> 한글"}',
  maxOutputTokens: 100,
  signal: new AbortController().signal,
});
describe("Codex subprocess adapter (fake CLI, no account or network needed)", () => {
  it.each([
    ["--codex", "--live"],
    ["--codex", "--synthetic"],
    ["--codex", "--fixture", "answers.json"],
  ].map(flags=>({flags})))("rejects ambiguous CLI modes before launching: %j", async ({flags}) => {
    await expect(
      runAiCli([
        ...flags,
        "--input",
        "unused.json",
        "--output",
        "unused-output.json",
      ])
    ).rejects.toThrow("Usage:");
  });
  it("rejects a missing binary without hanging or leaking local diagnostics", async () => {
    await expect(
      createCodexProvider({
        model: "gpt-test",
        executable: path.resolve(__dirname, "absent-codex-binary"),
      })
    ).rejects.toThrow("process_failed");
  });
  it("snapshots the model before the caller can mutate configuration", async () => {
    const fake = fixture();
    const options = { model: "original-model", launch: fake.launch };
    const pending = createCodexProvider(options);
    options.model = "changed-model";
    const provider = await pending;
    await provider.complete(req());
    expect(provider.model).toContain("/original-model/");
    const args = fake.invocations[1].args;
    expect(args[args.indexOf("--model") + 1]).toBe("original-model");
  });
  it("terminates descendants with inherited pipes and cleans the temporary directory", async () => {
    const fake = fixture("tree");
    const provider = await createCodexProvider({
      model: "gpt-test",
      launch: fake.launch,
    });
    const controller = new AbortController();
    const pending = provider.complete({ ...req(), signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("codex_provider_failed");
    let cwd: string | undefined;
    for (let i = 0; i < 200; i++) {
      cwd = fake.invocations[1]?.options.cwd as string | undefined;
      if (cwd && fs.existsSync(path.join(cwd, "worker.pid"))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cwd && fs.existsSync(path.join(cwd, "worker.pid"))).toBeTruthy();
    controller.abort();
    await rejected;
    expect(fs.existsSync(cwd!)).toBe(false);
  }, 5000);
  it("uses stdin and isolated cwd, removes secrets, binds CLI/model policy, and parses usage", async () => {
    const fake = fixture();
    const provider = await createCodexProvider({
      model: "gpt-test",
      executable: "codex",
      launch: fake.launch,
      env: {
        ...process.env,
        PRIVATE_KEY: "secret-key",
        OPENAI_API_KEY: "secret-api",
        CODEX_THREAD_ID: "parent-thread",
      },
    });
    const result = await provider.complete(req());
    const body = JSON.parse(result.content);
    expect(body.input).toBe(req().user);
    expect(body.system).toBe(req().system);
    expect(body.env.PRIVATE_KEY).toBeUndefined();
    expect(body.env.OPENAI_API_KEY).toBeUndefined();
    expect(body.env.CODEX_THREAD_ID).toBeUndefined();
    expect(body.cwd).not.toBe(process.cwd());
    expect(fs.existsSync(body.cwd)).toBe(false);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
    expect(provider.model).toContain("codex-cli/0.154.0-alpha.6.2/gpt-test");
    expect(provider.mode).toBe("live");
    const invocation = fake.invocations[1];
    expect(invocation.options.shell).toBe(false);
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).not.toContain(req().user);
    expect(invocation.args).toContain(
      "model_providers.pod-openai.request_max_retries=0"
    );
  });
  it.each(["exit", "invalid", "incomplete", "large", "tokens", "tool"])(
    "fails closed for %s without leaking process output or retrying",
    async (mode) => {
      const fake = fixture(mode);
      const provider = await createCodexProvider({
        model: "gpt-test",
        launch: fake.launch,
      });
      await expect(provider.complete(req())).rejects.toThrow(
        "codex_provider_failed"
      );
      expect(fake.invocations).toHaveLength(2);
    }
  );
  it("aborts a running CLI and rejects without a success result", async () => {
    const fake = fixture("hang");
    const provider = await createCodexProvider({
      model: "gpt-test",
      launch: fake.launch,
    });
    const controller = new AbortController();
    const promise = provider.complete({ ...req(), signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(promise).rejects.toThrow("codex_provider_failed");
  });
  it("does not launch when already cancelled", async () => {
    const fake = fixture();
    const provider = await createCodexProvider({
      model: "gpt-test",
      launch: fake.launch,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete({ ...req(), signal: controller.signal })
    ).rejects.toThrow();
    expect(fake.invocations).toHaveLength(1);
  });
});
