import {
  AI_LIMITS,
  validateTokenUsage,
  type AIProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "./ai-review";

export interface HttpProviderOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("missing_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AI_LIMITS.responseBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
/** OpenAI-compatible Chat Completions, JSON mode plus strict local validation.
 * Contract: https://developers.openai.com/api/reference/resources/chat
 * No retry, SDK, tools, candidate process or implicit endpoint/model defaults.
 */
export function createHttpProvider(options: HttpProviderOptions): AIProvider {
  const { model, apiKey } = options;
  if (
    typeof model !== "string" ||
    !model.trim() ||
    model.length > 200 ||
    typeof apiKey !== "string" ||
    !apiKey.trim() ||
    /[\r\n]/.test(apiKey)
  )
    throw new Error("invalid_provider_configuration");
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new Error("invalid_provider_configuration");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("invalid_provider_configuration");
  const endpoint = `${base.href.replace(/\/+$/, "")}/chat/completions`;
  const fetchImpl = options.fetchImpl ?? fetch;
  return Object.freeze({
    model,
    mode: "live" as const,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      try {
        if (
          typeof request.system !== "string" ||
          typeof request.user !== "string" ||
          Buffer.byteLength(request.system) > AI_LIMITS.inputBytes ||
          Buffer.byteLength(request.user) > AI_LIMITS.inputBytes ||
          !Number.isSafeInteger(request.maxOutputTokens) ||
          request.maxOutputTokens < 1 ||
          request.maxOutputTokens > AI_LIMITS.maxOutputTokens
        )
          throw new Error("invalid_request");
        const response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          signal: request.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            response_format: { type: "json_object" },
            max_completion_tokens: request.maxOutputTokens,
            n: 1,
            stream: false,
          }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error("http_error");
        }
        const body = JSON.parse(await boundedBody(response));
        if (!body || !Array.isArray(body.choices) || body.choices.length !== 1)
          throw new Error("invalid_choices");
        const choice = body.choices[0];
        const message = choice?.message;
        if (
          choice?.finish_reason !== "stop" ||
          !message ||
          message.refusal ||
          message.tool_calls ||
          message.function_call ||
          typeof message.content !== "string" ||
          message.content.includes(apiKey)
        )
          throw new Error("invalid_completion");
        const result: ProviderResponse = { content: message.content };
        if (body.usage !== undefined && body.usage !== null)
          result.usage = validateTokenUsage({
            inputTokens: body.usage.prompt_tokens,
            outputTokens: body.usage.completion_tokens,
            totalTokens: body.usage.total_tokens,
          });
        return result;
      } catch {
        // Never include server bodies, Authorization values, URLs or fetch error messages.
        throw new Error("http_provider_failed");
      }
    },
  });
}

/** Construction alone makes no request. The CLI additionally requires --live. */
export function createLiveProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AIProvider {
  const baseUrl = env.POD_AI_API_BASE_URL;
  const model = env.POD_AI_MODEL;
  const apiKey = env.POD_AI_API_KEY;
  if (!baseUrl || !model || !apiKey)
    throw new Error(
      "Set POD_AI_API_BASE_URL, POD_AI_MODEL and POD_AI_API_KEY explicitly"
    );
  return createHttpProvider({ baseUrl, model, apiKey });
}

/** Finite scripted answers exercise the real algorithm; they are not model evaluation. */
export function createFixtureProvider(
  responses: readonly ProviderResponse[],
  model = "synthetic-fixture-v1"
): AIProvider {
  const snapshot: ProviderResponse[] = JSON.parse(JSON.stringify(responses));
  let index = 0;
  return Object.freeze({
    model,
    mode: "synthetic" as const,
    async complete(request: ProviderRequest) {
      if (request.signal.aborted) throw new Error("fixture_aborted");
      if (index >= snapshot.length) throw new Error("fixture_exhausted");
      return snapshot[index++];
    },
  });
}
