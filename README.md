# GHC Gateway

GHC Gateway is a loopback-only GitHub Copilot gateway that exposes OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages APIs. It runs as one Node.js process and includes a local Admin UI for accounts, models, client configuration, usage, and operational events.

## Requirements

- Node.js 24.20.0 or newer
- A GitHub Copilot subscription
- Windows x64, Linux x64/arm64, or macOS x64/arm64

The gateway uses Node.js built-in SQLite. Installation does not require Python or a local C++ compiler.

## Install And Start

Install the `ghcg` executable, then run it in the foreground or as a detached daemon:

```bash
npm install --global @ljie-pi/ghc-gateway

ghcg serve
# Or:
ghcg start
ghcg status
ghcg restart
ghcg stop
```

The listener is always `127.0.0.1` and uses port `31400` by default. Select another startup port with `ghcg serve --port 31401` or `ghcg start --port 31401`.

With the gateway running:

- Admin UI: `http://127.0.0.1:31400/`
- OpenAI-compatible base URL: `http://127.0.0.1:31400/v1`

Inference routes do not require a separate gateway API key in this release.

## Accounts And Models

Start device authorization after the gateway is running, then list or select account-specific Copilot models:

```text
ghcg auth login
ghcg auth login --host github.example.com
ghcg auth logout [--account <account-id>]
ghcg auth status

ghcg accounts list
ghcg accounts use <account-id>
ghcg accounts remove <account-id>

ghcg models list [--account <account-id>]
ghcg models current
ghcg models set <model-id>
```

If a catalog refresh removes the preferred model, select another model explicitly. The gateway never silently chooses the first available model.

## HTTP APIs

| Method | Route | Interface |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `GET` | `/v1/models` | OpenAI models; Anthropic shape with `anthropic-version` |
| `GET` | `/healthz` | Process liveness |
| `GET` | `/readyz` | Runtime readiness |
| `GET` | `/` | Admin application |
| `GET`, `POST`, `PUT`, `DELETE` | `/admin/api/v1/*` | Admin API and SSE |

Key behavior:

- Selects one compatible native or converted upstream protocol per request.
- Converted requests to a Chat upstream send the output budget as the model's declared token field. When the model doesn't declare one, the gateway uses `max_tokens`, or `max_completion_tokens` for OpenAI o-series models, as cc-switch does. Chat-only models such as the Gemini Flash family are therefore available for agent mapping.
- Supports streaming, tool calls, reasoning output, and compatible Responses continuations.
- Responses `previous_response_id` continuation is best-effort:
  - Native Responses routes forward external IDs unchanged and drop gateway-issued IDs. Copilot currently rejects external IDs; clients such as Codex resend the full history instead.
  - Converted routes restore the previous response's tool calls from local history and never send the ID upstream.
  - When the history can't be restored, the request is still sent without it rather than failing. This happens when the ID is unknown, expired or from another account, has no checkpoint, or the turn is text-only.
  - A mismatched model, route or upstream origin for known history still returns 409.
- Converted Responses requests accept the `include` field that Codex always sends, without forwarding it. `reasoning.encrypted_content` is already met by the gateway's reasoning items, and other values are dropped. Native Responses requests forward `include` unchanged.
- Converted Messages-to-Responses output keeps signature-only thinking as an empty reasoning item before later text or tool items. Its hidden thinking text and provider signature are not shown; eligible tool continuations use bounded opaque state.
- Chat and Responses requests converted to a Messages upstream get Anthropic `cache_control` breakpoints, as in cc-switch, so repeated turns can hit prompt caching:
  - Positions: the last tool, the end of `system`, the newest cacheable message block and, in longer histories, the second-newest user message.
  - At most four breakpoints per request.
  - Native Messages requests, including their own markers, are forwarded unchanged.
- Converted routes return a 502 conversion error for citation-bearing output until they can map citations to the target protocol; native routes preserve the original response.
- Responses assistant history with citations or an explicit `phase` needs a native Responses upstream; converting it to Chat or Messages fails before inference rather than dropping those fields.
- Filters hop-by-hop headers, tracing headers, and private gateway headers.
- Limits inference requests to 128 headers and 16 KiB of aggregate header data.
- Keeps bounded continuation and reasoning state for up to `history.ttlDays`.

## Configuration

Global options are `--data-dir <path>` and `--json`. Startup settings use CLI values first, then environment variables, then defaults:

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| Port | `--port` | `GHC_GATEWAY_PORT` | `31400` |
| Data directory | `--data-dir` | `GHC_GATEWAY_DATA_DIR` | `~/.ghc-gateway` |
| Log level | `--log-level` | `GHC_GATEWAY_LOG_LEVEL` | `info` |
| Request diagnostics | `--diagnostics` | Not available | Disabled |

Use `ghcg config get [key]` and `ghcg config set <key> <value>` for persisted limits, timeouts, admission control, account capacity, and retention settings.

## Request Diagnostics

```text
ghcg serve --diagnostics
ghcg start --diagnostics
ghcg restart --diagnostics
ghcg --json status
```

Diagnostics:

- Write bounded JSONL structure summaries to `<data-dir>\logs\diagnostics.jsonl`.
- Cover validation, protocol selection, conversion, upstream activity, output, and termination.
- Reuse the HTTP response request ID for correlation.
- Exclude prompts, responses, tool content, credentials, opaque IDs, and raw upstream errors.
- Rotate at 10 MiB, retain up to five files, and prune diagnostic files older than seven days.
- Require `--diagnostics` on each start or restart that should enable recording.

## Automation

Every command accepts `--json` and emits one compact success or error object, for example:

```bash
ghcg --json status
ghcg --json accounts list
ghcg --json config get limits.requestBodyBytes
```

## Development

Run and validate a source checkout from the repository root:

```sh
# Build and run in the foreground:
npm ci
npm run build
npm start

# In another terminal, or after stopping the gateway, validate changes:
npm run typecheck
npm run lint
npm run smoke:sqlite
npm test
npm run fixtures:verify
npm run e2e
npm run pack
```

Use `node dist/src/cli/main.js` instead of `ghcg` when exercising the built CLI.

### Recording and replay tests

Official-client SDK tests require explicit opt-in. They run offline: official SDK → gateway → a
loopback Copilot replay server. Each test selects one scenario; the replay server returns the
recorded bytes only when the gateway's upstream request matches that step's request predicate,
otherwise it answers `409`.

```bash
GHC_GATEWAY_SDK_TESTS=1 npm run test:sdk
GHC_GATEWAY_SDK_TESTS=1 npx vitest run --config vitest.sdk.config.ts tests/sdk/matrix_replay.sdk.test.ts
```

`tests/sdk/corpus` holds live Copilot responses for `gemini-3.8-flash` (Chat), `gpt-6-astra`
(Responses) and `claude-opus-5.5` (Messages). Never edit corpus files by hand; re-record them. The
recorder sends the same official-SDK requests through the gateway to live Copilot using the
signed-in account (`--data-dir`, `--account`). It replaces the selected cases only after every
selected exchange validates. Without `--execute` it prints the plan and makes no request:

```bash
node scripts/tooling/bootstrap.mjs scripts/tooling/capture_upstream.ts
node scripts/tooling/bootstrap.mjs scripts/tooling/capture_upstream.ts --execute --model claude-opus-5.5 --scenario coherent-session
```

Both selectors default to `all`:

- `--model`: `gemini-3.8-flash`, `gpt-6-astra` or `claude-opus-5.5`.
- `--scenario`: `plain-text`, `image`, `weather-roundtrip`, `parallel-tools`, `mixed-image-tool`,
  `reasoning-effort` or `coherent-session`.

Output and errors are content-free: configuration, case IDs, check names, status codes, byte counts
and digests. A failed run publishes nothing and is not retried; re-run that model and scenario.

After recording:

1. Copy the reported `sessionAssistantTextSha256` values into `SESSION_ASSISTANT_TEXT_SHA256` in
   `tests/sdk/scenarios.ts`.
2. Update the corpus digests in `tests/unit/sdk_corpus_manifest.test.ts` from the received values that
   `npx vitest run tests/unit/sdk_corpus_manifest.test.ts` reports; re-run until it passes.
3. Run the SDK suite. `tests/sdk/corpus_recorder.sdk.test.ts` re-records the whole corpus offline
   and must reproduce every byte.

SDK request definitions live in `tests/sdk/scenario_requests.ts`, replay request predicates in
`tests/sdk/replay_scenarios.ts`, and recording cases and checks in `tests/sdk/corpus_recorder.ts`.
The recording and replay catalog is `tests/support/replay/catalog.ts`.

## License

[MIT](LICENSE)
