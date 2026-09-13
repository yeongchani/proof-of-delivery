# AI fixture and explicit live commands

Run from the repository root with Node 20+. Output paths must not already exist. No candidate code is executed; only the explicitly named JSON files are read.

```sh
npx tsx runner/src/ai-cli.ts --synthetic --fixture runner/fixtures/ai-responses.synthetic.json --input runner/fixtures/ai-input.synthetic.json --output runner/fixtures/ai-demo-result.json
npx tsx runner/src/ai-cli.ts --synthetic --draft --fixture runner/fixtures/ai-draft-responses.synthetic.json --input runner/fixtures/ai-draft-input.synthetic.json --output runner/fixtures/ai-draft-result.json
```

These finite scripted responses exercise the real algorithm. They are visibly synthetic, not accuracy benchmarks, measured model evaluations or execution evidence. Fixture token usage is unknown unless explicitly supplied; missing usage is not a measured zero. Every review records full paired rounds, exact cited text, input, model, hashes, mode, elapsed milliseconds and available usage. `usage.complete` and `measuredCalls` disclose incomplete accounting; synthetic token numbers remain synthetic.

Live mode requires `--live` and all three environment variables: `POD_AI_API_BASE_URL` (for example an explicit HTTPS URL ending in `/v1`), `POD_AI_MODEL`, and `POD_AI_API_KEY`. There are no implicit providers, model defaults or synthetic fallbacks. Do not place the key in command arguments or evidence files. No paid API was used to verify these fixtures.

```sh
npx tsx runner/src/ai-cli.ts --live --input path/to/anonymized-evidence.json --output path/to/new-review.json --max-requests 8 --max-output-tokens 4096 --timeout-ms 30000
```

`--draft` instead accepts `{ "requirements": [{ "id": "R-1", "text": "..." }] }` and returns cited criteria suggestions, always `requiresBilateralApproval: true` and `executable: false`. It does not approve criteria, generate test code, or convert subjective assertions into proof.

Review input has exactly `criteria: [{id, description}]` and `evidence: [{id, text}]`. Remove party identities and secrets from free text before supplying it; schema validation rejects party metadata but cannot guarantee semantic anonymization. No generic file scanning or automatic evidence collection occurs.

The two roles use the same model and identical input. If every initial criterion vote agrees, the review ends after two calls. Any disagreement triggers exactly three more paired rounds. Each criterion passes only with more than four of all eight votes; a tie fails. Any invalid call fails the entire review. Every criterion, including a failed one, must cite at least one nonempty exact substring from supplied evidence. Citation presence does not prove relevance, authenticity or actual execution. Trusted execution evidence and bilateral policy acceptance remain separate integration requirements.

Limits: at most 8 requests, 32 criteria, 64 evidence items, 65,536 UTF-8 input bytes; each description at most 2,048 characters and each evidence text at most 8,192. Response envelopes are capped at 131,072 bytes. Defaults are 30 seconds per call and 4,096 maximum completion tokens (hard maximum 8,192). Lower request budgets fail closed if disagreement needs more calls. Timeouts abort fetch; remote billing may still occur. No retries. This is a call/token budget, not a currency cap; prices are not assumed.

Before acceptance use `reviewPolicyHash(model, {mode, timeoutMs, maxRequests, maxOutputTokens})` from `ai-review.ts`. The same settings yield `runDualReview(...).policyHash`; mode defaults to synthetic. The hash commits to both prompts, model, mode, algorithm and bounds. Pass the same options to both functions. A policy hash identifies a policy, not model correctness or a hardware attestation.

HTTP uses native fetch with Chat Completions JSON mode, no tools, one choice, no redirects and no retries. Provider compatibility requires `response_format: {type: "json_object"}` and `max_completion_tokens`; incompatible APIs fail closed. Contract reference: [provider API documentation](https://developers.openai.com/api/reference/resources/chat). HTTPS is required except for loopback HTTP test endpoints. CLI exit codes: 0 successful pass/draft, 1 valid failed verdict, 2 malformed response, provider/configuration/budget/file error. Error messages never include provider response bodies or credentials.
