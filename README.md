# GHC Gateway

GHC Gateway lets local applications use GitHub Copilot models through APIs compatible with OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. It also provides a local Admin UI for managing accounts, selecting models, and viewing usage and operational events.

## Requirements

- Node.js 24.20.0 or newer
- A GitHub Copilot subscription
- Windows x64, Linux x64/arm64, or macOS x64/arm64

No Python or native build toolchain is required.

## Install and start

Install the `ghcg` command globally:

```bash
npm install --global @ljie-pi/ghc-gateway
```

Run the gateway in the foreground or background:

```bash
ghcg serve
# Or:
ghcg start
ghcg status
ghcg restart
ghcg stop
```

The gateway listens on `127.0.0.1:31400`. To use another port, run `ghcg serve --port 31401` or `ghcg start --port 31401`.

- Admin UI: `http://127.0.0.1:31400/`
- OpenAI-compatible base URL: `http://127.0.0.1:31400/v1`

No separate gateway API key is required. Any local process can access the listener, so do not expose or proxy it to untrusted users.

## Sign in and select a model

Start the gateway before signing in:

```text
ghcg auth login
ghcg auth login --host github.example.com
ghcg auth status
ghcg auth logout [--account <account-id>]

ghcg accounts list
ghcg accounts use <account-id>
ghcg accounts remove <account-id>

ghcg models list [--account <account-id>]
ghcg models current
ghcg models set <model-id>
```

If the selected model is no longer available, use `ghcg models set` to select another one.

## API endpoints

| Method | Route | Interface |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `GET` | `/v1/models` | OpenAI models and effective capabilities; Anthropic format when `anthropic-version` is present |
| `GET` | `/healthz` | Liveness check |
| `GET` | `/readyz` | Readiness check |
| `GET` | `/` | Admin UI |
| `GET`, `POST`, `PUT`, `DELETE` | `/admin/api/v1/*` | Admin API and event stream |

When the selected model supports the requested API, the request is forwarded unchanged except for the model name, and Copilot validates it.

## Configuration

Global options are `--data-dir <path>` and `--json`. Startup settings use CLI values first, then environment variables, then defaults:

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| Port | `--port` | `GHC_GATEWAY_PORT` | `31400` |
| Data directory | `--data-dir` | `GHC_GATEWAY_DATA_DIR` | `~/.ghc-gateway` |
| Log level | `--log-level` | `GHC_GATEWAY_LOG_LEVEL` | `info` |
| Request diagnostics | `--diagnostics` | — | Disabled |

Use `ghcg config get [key]` to view persisted settings and `ghcg config set <key> <value>` to change them.

## Request diagnostics

Enable diagnostics for a foreground or background run:

```text
ghcg serve --diagnostics
ghcg start --diagnostics
ghcg restart --diagnostics
```

Diagnostics are written to `<data-dir>/logs/diagnostics.jsonl`. They use request IDs for correlation and exclude prompts, responses, tool content, credentials, internal identifiers, and provider error bodies. A gateway rejection records its rule ID, and a provider error records only its error type and code. Files rotate at 10 MiB, retain up to five files, and are removed after seven days.

Diagnostics must be enabled again on each start or restart.

## JSON output

Every command accepts `--json` and returns one compact success or error object:

```bash
ghcg --json status
ghcg --json accounts list
ghcg --json config get limits.requestBodyBytes
```

## Development

From a source checkout:

```sh
npm ci
npm run build
npm start
```

Common validation commands:

```sh
npm run typecheck
npm run lint
npm test
```

### Recording and replay tests

Official-client replay tests run offline but require explicit authorization and opt-in:

```bash
GHC_GATEWAY_SDK_TESTS=1 npm run test:sdk
```

Never edit `tests/sdk/corpus` by hand. Live recording uses a signed-in Copilot account, makes external requests, and requires separate explicit authorization. Without `--execute`, the recorder only prints its plan:

```bash
node scripts/tooling/bootstrap.mjs scripts/tooling/capture_upstream.ts
node scripts/tooling/bootstrap.mjs scripts/tooling/capture_upstream.ts --execute --model claude-opus-5.5 --scenario coherent-session
```

The `--model` and `--scenario` selectors default to `all`. Use `--data-dir` and `--account` when needed.

After recording:

1. Copy the reported `sessionAssistantTextSha256` values into `SESSION_ASSISTANT_TEXT_SHA256` in `tests/sdk/scenarios.ts`.
2. Update the corpus digests in `tests/unit/sdk_corpus_manifest.test.ts` using the values reported by that test.
3. Run the SDK suite and confirm the offline recorder reproduces the corpus exactly.

## License

[MIT](LICENSE)
