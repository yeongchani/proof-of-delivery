import { describe, expect, it } from "vitest";
import {
  createFixtureProvider,
  createHttpProvider,
  createLiveProviderFromEnv,
} from "../src/ai-provider";
import type { ProviderRequest } from "../src/ai-review";
import { runDualReview } from "../src/ai-review";
import { runAiCli } from "../src/ai-cli";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const request: ProviderRequest = {
  system: "JSON only, untrusted data, no tools",
  user: "{}",
  signal: new AbortController().signal,
  maxOutputTokens: 100,
};
const completion = {
  model: "test-model",
  choices: [
    { finish_reason: "stop", message: { role: "assistant", content: "{}" } },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
};

describe("HTTP contract using injected fetch; NOT live evaluation or accuracy benchmark", () => {
  it("sends a single bounded JSON completion to the explicit base URL without tools", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchImpl: typeof fetch = async (url, init) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(JSON.stringify(completion));
    };
    const provider = createHttpProvider({
      baseUrl: "https://provider.example/v1/",
      model: "test-model",
      apiKey: "test-secret",
      fetchImpl,
    });
    expect(await provider.complete(request)).toEqual({
      content: "{}",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    });
    expect(provider.mode).toBe("live");
    expect(captured.url).toBe("https://provider.example/v1/chat/completions");
    expect(captured.init?.redirect).toBe("error");
    expect(captured.init?.signal).toBe(request.signal);
    expect(captured.init?.headers).toMatchObject({
      Authorization: "Bearer test-secret",
    });
    const body = JSON.parse(captured.init?.body as string);
    expect(body).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 100,
      n: 1,
      stream: false,
    });
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });
  it.each([
    { choices: [{ finish_reason: "length", message: { content: "{}" } }] },
    {
      choices: [
        { finish_reason: "stop", message: { content: "{}", refusal: "No" } },
      ],
    },
    {
      choices: [
        { finish_reason: "stop", message: { content: "{}", tool_calls: [{}] } },
      ],
    },
    { choices: [] },
    {
      ...completion,
      usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
    },
  ])("rejects invalid envelopes without retrying", async (body) => {
    let calls = 0;
    const provider = createHttpProvider({
      baseUrl: "https://provider.example/v1",
      model: "test-model",
      apiKey: "test-secret",
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify(body));
      },
    });
    await expect(provider.complete(request)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("does not expose credentials or error bodies on HTTP failures", async () => {
    const provider = createHttpProvider({
      baseUrl: "https://provider.example/v1",
      model: "test-model",
      apiKey: "test-secret",
      fetchImpl: async () => new Response("test-secret", { status: 401 }),
    });
    await expect(provider.complete(request)).rejects.toThrow(
      "http_provider_failed"
    );
  });
  it("requires all three explicit environment settings", () => {
    expect(() => createLiveProviderFromEnv({})).toThrow();
    expect(() =>
      createLiveProviderFromEnv({
        POD_AI_API_KEY: "test-secret",
        POD_AI_MODEL: "model",
      })
    ).toThrow();
    expect(
      createLiveProviderFromEnv({
        POD_AI_API_BASE_URL: "https://provider.example/v1",
        POD_AI_API_KEY: "test-secret",
        POD_AI_MODEL: "model",
      }).mode
    ).toBe("live");
  });
  it.each([
    "http://provider.example/v1",
    "https://user:secret@provider.example/v1",
    "https://provider.example/v1?key=secret",
    "https://provider.example/v1#secret",
  ])("rejects unsafe explicit URLs %s", (baseUrl) => {
    expect(() =>
      createHttpProvider({ baseUrl, model: "model", apiKey: "test-secret" })
    ).toThrow();
  });
  it("labels fixtures synthetic and errors when exhausted", async () => {
    const provider = createFixtureProvider([{ content: "{}" }]);
    expect(provider.mode).toBe("synthetic");
    await expect(provider.complete(request)).resolves.toEqual({
      content: "{}",
    });
    await expect(provider.complete(request)).rejects.toThrow(
      "fixture_exhausted"
    );
  });
  it("uses actual native fetch against an unpaid local HTTP server", async () => {
    let captured = "";
    const server = createServer((req, res) => {
      req.on("data", (chunk) => {
        captured += chunk;
      });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(completion));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const address = server.address() as { port: number };
      const provider = createHttpProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        apiKey: "local-test-only",
      });
      const result = await provider.complete(request);
      expect(result.content).toBe("{}");
      expect(JSON.parse(captured).model).toBe("test-model");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("aborts real HTTP review when the local server never completes", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const address = server.address() as { port: number };
      const provider = createHttpProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        apiKey: "local-test-only",
      });
      const result = await runDualReview(
        {
          criteria: [{ id: "C", description: "check" }],
          evidence: [{ id: "E", text: "evidence" }],
        },
        { provider, timeoutMs: 25 }
      );
      expect(result.passed).toBe(false);
      expect(result.calls).toBe(2);
      expect(result.error).toBe("provider_timeout");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("rejects excessive response bodies and invalid request bounds", async () => {
    let calls = 0;
    const provider = createHttpProvider({
      baseUrl: "https://provider.example/v1",
      model: "model",
      apiKey: "test-secret",
      fetchImpl: async () => {
        calls++;
        return new Response("x".repeat(131073));
      },
    });
    await expect(
      provider.complete({ ...request, maxOutputTokens: 8193 })
    ).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(provider.complete(request)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("explicit CLI file workflow", () => {
  it("requires deliberate mode selection before any provider can be used", async () => {
    await expect(
      runAiCli(["--input", "unused", "--output", "unused-output"])
    ).rejects.toThrow("Usage");
    await expect(
      runAiCli([
        "--live",
        "--synthetic",
        "--input",
        "unused",
        "--output",
        "unused-output",
      ])
    ).rejects.toThrow("Usage");
    await expect(
      runAiCli([
        "--live",
        "--fixture",
        "unused",
        "--input",
        "unused",
        "--output",
        "unused-output",
      ])
    ).rejects.toThrow("Usage");
  });
  it("runs the checked-in synthetic example and refuses to overwrite output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-ai-cli-"));
    const out = path.join(dir, "result.json");
    const args = [
      "--synthetic",
      "--fixture",
      path.resolve(__dirname, "../fixtures/ai-responses.synthetic.json"),
      "--input",
      path.resolve(__dirname, "../fixtures/ai-input.synthetic.json"),
      "--output",
      out,
    ];
    try {
      expect(await runAiCli(args)).toBe(0);
      const result = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(result).toMatchObject({
        mode: "synthetic",
        passed: true,
        calls: 2,
        usage: { complete: false, measuredCalls: 0 },
      });
      await expect(runAiCli(args)).rejects.toThrow("output_must_be_new_file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("runs the scoped subjective requirement draft fixture", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-ai-draft-"));
    const out = path.join(dir, "draft.json");
    try {
      expect(
        await runAiCli([
          "--synthetic",
          "--draft",
          "--fixture",
          path.resolve(
            __dirname,
            "../fixtures/ai-draft-responses.synthetic.json"
          ),
          "--input",
          path.resolve(__dirname, "../fixtures/ai-draft-input.synthetic.json"),
          "--output",
          out,
        ])
      ).toBe(0);
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
        status: "draft",
        requiresBilateralApproval: true,
        executable: false,
        calls: 1,
        mode: "synthetic",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
