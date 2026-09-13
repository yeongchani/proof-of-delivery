import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AI_LIMITS,
  validateTokenUsage,
  type AIProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "./ai-review";

/** This CLI build was exercised live. Fail closed when CLI flags/event semantics change. */
export const CODEX_VERSION = "0.154.0-alpha.6.2";
const PROTOCOL = "pod-v1";
const DISABLED = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "apps",
  "plugins",
  "hooks",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "multi_agent",
  "image_generation",
  "view_image",
  "workspace_dependencies",
  "memories",
  "code_mode",
  "code_mode_host",
  "tool_suggest",
  "skill_mcp_dependency_install",
  "unbounded_connection_retries",
];
export interface CodexProviderOptions {
  model: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests launch a real OS subprocess, but never a model. */
  launch?: typeof spawn;
}
function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|CODEX_HOME)$/i.test(
        key
      )
    )
      result[key] = value;
  }
  return result;
}
function stop(child: ChildProcess, env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32" && child.pid) {
    // Direct executable + numeric PID: no command shell or candidate text.
    const root = Object.entries(env).find(
      ([key]) => key.toUpperCase() === "SYSTEMROOT"
    )?.[1];
    const killer = spawn(
      root ? path.join(root, "System32", "taskkill.exe") : "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { env, shell: false, windowsHide: true, stdio: "ignore" }
    );
    killer.on("error", () => {
      child.kill();
    });
    killer.on("close", (code) => {
      if (code !== 0) child.kill();
    });
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
async function processOutput(
  launch: typeof spawn,
  executable: string,
  args: string[],
  options: SpawnOptions,
  input: string,
  signal: AbortSignal,
  onLine?: (line: string) => void
): Promise<string> {
  if (signal.aborted) throw new Error("cancelled");
  return new Promise((resolve, reject) => {
    const child = launch(executable, args, {
      ...options,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    let stdout = "",
      pending = "",
      bytes = 0,
      failed = false;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (!failed) {
        failed = true;
        stop(child, options.env ?? {});
        killDeadline = setTimeout(() => {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          clearTimeout(timer);
          signal.removeEventListener("abort", fail);
          reject(new Error("process_termination_failed"));
        }, 3000);
      }
    };
    const timer = setTimeout(fail, AI_LIMITS.maxTimeoutMs);
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) return fail();
      if (failed) return;
      stdout += chunk;
      if (!onLine) return;
      pending += chunk;
      let end: number;
      try {
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end).trim();
          pending = pending.slice(end + 1);
          if (line) onLine(line);
        }
      } catch {
        fail();
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) fail();
      // CLI diagnostics may contain account paths or service responses. Never persist them.
    });
    child.stdin!.on("error", fail);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killDeadline) clearTimeout(killDeadline);
      signal.removeEventListener("abort", fail);
      try {
        if (failed || code !== 0 || signal.aborted)
          throw new Error("process_failed");
        if (pending.trim() && onLine) onLine(pending.trim());
        resolve(stdout);
      } catch {
        reject(new Error("process_failed"));
      }
    });
    child.stdin!.end(input);
  });
}

export async function createCodexProvider(
  options: CodexProviderOptions
): Promise<AIProvider> {
  const requestedModel = options.model;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(requestedModel))
    throw new Error("invalid_codex_model");
  const executable = options.executable ?? "codex";
  if (
    !executable.trim() ||
    /[\r\n\0]/.test(executable) ||
    /\.(cmd|bat)$/i.test(executable)
  )
    throw new Error("use_native_codex_executable");
  const env = childEnvironment(options.env ?? process.env);
  const launch = options.launch ?? spawn;
  const version = (
    await processOutput(
      launch,
      executable,
      ["--version"],
      { env, cwd: os.tmpdir() },
      "",
      AbortSignal.timeout(5000)
    )
  ).trim();
  if (version !== "codex-cli " + CODEX_VERSION)
    throw new Error("unsupported_codex_version");
  // Identity commits to transport/build/requested model/reasoning/configuration,
  // including post-response token rejection rather than a generation token cap.
  const model =
    "codex-cli/" + CODEX_VERSION + "/" + requestedModel + "/low/" + PROTOCOL;
  return Object.freeze({
    model,
    mode: "live" as const,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      let dir: string | undefined;
      try {
        if (
          request.signal.aborted ||
          typeof request.system !== "string" ||
          typeof request.user !== "string" ||
          Buffer.byteLength(request.system) > AI_LIMITS.inputBytes ||
          Buffer.byteLength(request.user) > AI_LIMITS.inputBytes ||
          !Number.isSafeInteger(request.maxOutputTokens) ||
          request.maxOutputTokens < 1 ||
          request.maxOutputTokens > AI_LIMITS.maxOutputTokens
        )
          throw new Error("invalid_request");
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "pod-codex-"));
        await fs.mkdir(path.join(dir, ".git")); // Stop ancestor project-config discovery.
        const instructions = path.join(dir, "instructions.txt");
        await fs.writeFile(instructions, request.system, { mode: 0o600 });
        const configs = [
          'approval_policy="never"',
          'web_search="disabled"',
          "project_doc_max_bytes=0",
          'model_reasoning_effort="low"',
          "suppress_unstable_features_warning=true",
          "model_instructions_file=" + JSON.stringify(instructions),
          'model_provider="pod-openai"',
          'model_providers.pod-openai.name="PoD OpenAI"',
          'model_providers.pod-openai.wire_api="responses"',
          "model_providers.pod-openai.requires_openai_auth=true",
          "model_providers.pod-openai.request_max_retries=0",
          "model_providers.pod-openai.stream_max_retries=0",
        ];
        const args = [
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--skip-git-repo-check",
          "--json",
          "--color",
          "never",
          "--sandbox",
          "read-only",
          "--cd",
          dir,
          "--model",
          requestedModel,
          ...DISABLED.flatMap((f) => ["--disable", f]),
          "--enable",
          "skip_host_skill_discovery",
          ...configs.flatMap((c) => ["-c", c]),
          "-",
        ];
        let started = false,
          completed = false,
          content: string | undefined;
        let usage: ProviderResponse["usage"];
        await processOutput(
          launch,
          executable,
          args,
          { env, cwd: dir },
          request.user,
          request.signal,
          (line) => {
            const event = JSON.parse(line);
            if (completed) throw new Error("extra_event");
            if (event.type === "thread.started" && !started) return;
            if (event.type === "turn.started" && !started) {
              started = true;
              return;
            }
            if (
              event.type === "item.completed" &&
              event.item?.type === "error" &&
              !started &&
              event.item.message ===
                "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable \u0060features.code_mode_host\u0060 and install \u0060codex-code-mode-host\u0060."
            )
              return;
            if (!started) throw new Error("unexpected_event");
            if (
              event.type === "item.completed" &&
              event.item?.type === "agent_message" &&
              content === undefined &&
              typeof event.item.text === "string"
            ) {
              content = event.item.text;
              return;
            }
            if (
              ["item.started", "item.updated", "item.completed"].includes(
                event.type
              ) &&
              event.item?.type === "reasoning"
            )
              return;
            if (event.type === "turn.completed") {
              usage = validateTokenUsage({
                inputTokens: event.usage?.input_tokens,
                outputTokens: event.usage?.output_tokens,
                totalTokens:
                  event.usage?.input_tokens + event.usage?.output_tokens,
              });
              completed = true;
              return;
            }
            // Any tool activity, additional turn, error or unknown event rejects the review.
            throw new Error("unexpected_event");
          }
        );
        if (
          !completed ||
          !usage ||
          content === undefined ||
          Buffer.byteLength(content) > AI_LIMITS.responseBytes ||
          usage.outputTokens > request.maxOutputTokens
        )
          throw new Error("incomplete_or_over_budget");
        JSON.parse(content); // No Markdown stripping or repair that could hide a refusal.
        return { content, usage };
      } catch {
        throw new Error("codex_provider_failed");
      } finally {
        // dir is the fresh absolute mkdtemp result, never a candidate-controlled path.
        if (dir) await fs.rm(dir, { recursive: true, force: true });
      }
    },
  });
}
export async function createCodexProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<AIProvider> {
  if (!env.POD_CODEX_MODEL) throw new Error("Set POD_CODEX_MODEL explicitly");
  return createCodexProvider({
    model: env.POD_CODEX_MODEL,
    executable: env.POD_CODEX_BINARY,
    env,
  });
}
