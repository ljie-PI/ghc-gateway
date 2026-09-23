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
- Supports streaming, tool calls, reasoning output, and compatible Responses continuations.
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

Use `node dist/src/cli/main.js` instead of `ghcg` when exercising the built CLI. Official-client suites require explicit opt-in:

```bash
GHC_GATEWAY_SDK_TESTS=1 npm run test:sdk
```

## License

[MIT](LICENSE)
