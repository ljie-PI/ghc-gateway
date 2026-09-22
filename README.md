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

## Admin UI And Agents

Open the Admin UI at the listener root. It is an unauthenticated loopback management interface: any local process that can reach the listener can read or change Admin-managed state. Do not expose the listener outside the local machine.

The Agents view configures this machine's Claude Code and Codex clients to use the gateway. Each mapping selects an exact Copilot model ID; the first row is the startup model.

- Claude Code keeps its Sonnet, Opus, and Haiku roles and supports additional menu models through `modelPicker` with Claude Code 2.1.243 or newer.
- Codex writes the selected catalog to `models.json` and references it from `config.toml`. Restart Codex after applying changes.
- Generated Codex models share a compact behavior contract for brief phase-based commentary, task completion, conservative engineering judgment, workspace safety, and concise final responses. It does not expose reasoning or replace more specific client, user, or repository instructions.
- Responses models with verified reasoning-effort support advertise reasoning summaries unless the upstream explicitly disables them. Summary defaults to `none`; select concise or detailed in the client to request visible summary text.
- Apply updates Gateway-owned routing and model fields while preserving unrelated settings, hooks, MCP servers, Codex `auth.json`, and Claude credentials.

Every Apply, including a no-change Apply, and every confirmed Codex Take over snapshots the current Agent files before replacement. Codex snapshots `config.toml` and `models.json`; Claude Code snapshots `settings.json`. Backups use local-time names such as `config.toml.ghcg.20260921T163015`, with `.1`, `.2`, and so on for same-second collisions. Up to 365 Gateway-owned backups are retained per source file; legacy `.ghcg.bak` and unrelated files are left untouched.

There is no Restore action in Admin. To restore manually, stop the client and copy the selected backup over the corresponding `config.toml`, `models.json`, or `settings.json` file.

## HTTP APIs

All routes share the loopback listener:

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

The gateway selects one compatible native or converted upstream protocol for each request. It does not probe paid inference routes or retry a rejected request through a different protocol.

Converted Chat and Responses output keeps visible reasoning separate from answer text. Chat uses
the untyped `reasoning_content` compatibility extension; Responses uses reasoning items and summary
events. Messages output preserves native Anthropic signatures and redacted data exactly. When a
Responses reasoning item must cross a compatible tool continuation, Messages carries a versioned
gateway reference in `thinking.signature` or `redacted_thinking.data`; that reference is never
presented to Anthropic as native ciphertext. Reported reasoning-token details are normalized without
estimating them from text.

Opaque carriers use `ghcg-rsn-v1:<source_kind>:<wire_protocol>:<uuid>` in documented reasoning-state
slots. Responses-origin state uses Chat `assistant.reasoning_items[].encrypted_content` or Messages
`thinking.signature`/`redacted_thinking.data`; Chat- and Messages-origin state uses a Responses
reasoning item's `encrypted_content`. The restored state always returns to its original source
protocol. Carriers are scoped to the bound account, model, upstream origin, source protocol, wire
protocol, and conversion version. Each carrier is limited to 4 MiB, aggregate carrier and Responses replay
storage is limited to 32 MiB with oldest-first eviction, and the default retention is 7 days.
Converted Responses History v2 retains only ordered reasoning-and-call groups needed for tool results;
existing v1 call-only checkpoints remain readable.

## Configuration

Global options are `--data-dir <path>` and `--json`. Startup settings use CLI values first, then environment variables, then defaults:

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| Port | `--port` | `GHC_GATEWAY_PORT` | `31400` |
| Data directory | `--data-dir` | `GHC_GATEWAY_DATA_DIR` | `~/.ghc-gateway` |
| Log level | `--log-level` | `GHC_GATEWAY_LOG_LEVEL` | `info` |
| Request diagnostics | `--diagnostics` | Not available | Disabled |

Read or update persisted runtime configuration with `ghcg config get [key]` and `ghcg config set <key> <value>`.

| Runtime key | Default | Range |
| --- | ---: | ---: |
| `limits.requestBodyBytes` | 33554432 | 1048576..67108864 |
| `limits.sseEventBytes` | 4194304 | 65536..16777216 |
| `limits.nonstreamBodyBytes` | 33554432 | 1048576..134217728 |
| `limits.accumulatorBytes` | 33554432 | 1048576..134217728 |
| `admission.activeMax` | 4 | 1..16 |
| `admission.queueMax` | 16 | 0..64 |
| `timeouts.queueMs` | 30000 | 1000..300000 |
| `timeouts.connectMs` | 30000 | 1000..120000 |
| `timeouts.firstByteMs` | 120000 | 5000..600000 |
| `timeouts.streamIdleMs` | 120000 | 5000..600000 |
| `timeouts.totalMs` | 1800000 | 60000..7200000 |
| `accounts.maxAuthenticated` | 8 | 1..32 |
| `history.ttlDays` | 7 | 1..365 |
| `usage.retentionDays` | 90 | 1..365 |
| `events.retentionDays` | 7 | 1..30 |

A missing runtime row can be seeded once with an upper-snake-case `GHC_GATEWAY_` variable, for example `GHC_GATEWAY_LIMITS_REQUEST_BODY_BYTES`.

## Local Data And Privacy

The default data directory is `~/.ghc-gateway`:

- `state.db`: runtime settings, account metadata, bounded Responses History and opaque reasoning carriers, Usage Buckets, and sanitized Operational Events
- `credentials.json`: protected credentials
- `daemon.json`: protected process identity and local-control authentication
- `logs/*.jsonl`: bounded, sanitized daemon logs
- `logs\diagnostics*.jsonl`: opt-in, content-free request diagnostics
- `agents/{claude|codex}/state.db`: Agent management state

Use `--data-dir` or `GHC_GATEWAY_DATA_DIR` to select another data directory. This does not change client targets selected by `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.

Prompts, responses, tool arguments, authorization values, and complete upstream error bodies are not persisted in telemetry or exposed by Admin errors. Responses History stores only bounded bridge checkpoints needed for compatible continuations. Tool continuations can also retain bounded, source-bound opaque reasoning state for up to `history.ttlDays`; carriers are accepted only for the same account, model, upstream origin, protocol, and conversion version, and are removed with their account or Responses History.

On Windows, files inherit the selected directory's permissions. Existing and custom data roots and client configuration directories are caller-managed security boundaries.

## Request Diagnostics

Enable structured request diagnostics for one invocation:

```text
ghcg serve --diagnostics
# Or use the managed daemon:
ghcg start --diagnostics
# Explicitly enable diagnostics when restarting an existing daemon:
ghcg restart --diagnostics
ghcg --json status
```

Both foreground and managed modes write `<data-dir>\logs\diagnostics.jsonl`. The flag is independent of `--log-level`; `--log-level debug` or `trace` alone does not enable request diagnostics. Plain `ghcg restart` disables diagnostics for the next process. `start` does not reconfigure an already-running instance: inspect its actual status and use `restart --diagnostics` when needed.

Each inference request uses the same `requestId` as its HTTP response (`request-id` for Messages, `x-request-id` for OpenAI endpoints). JSONL records identify validation, model/protocol selection, conversion, upstream HTTP, output, commitment, and termination stages. They include fixed error categories and available conversion rule IDs, elapsed time, bounded structure summaries, byte counts, and finite SSE event counters. Responses diagnostics also record allowlisted reasoning effort/summary modes, reasoning event counts, and the final non-negative reasoning-token count when observed. The allowlisted `protocolStatus` distinguishes an incomplete protocol result from a successful HTTP/Usage outcome. All three protocols, native and converted operations, and streaming and buffered requests are covered.

These are **structure summaries, not captured requests or responses**. They contain allowlisted field types and counts, not prompts, replies, tool inputs/outputs, schema descriptions, credentials, opaque IDs, arbitrary keys, or raw upstream error bodies. Unknown fields/events are counted without retaining their names. A rejected upstream response provides status/category only. An HTTP 200 followed by a stream failure is recorded separately from an HTTP-level rejection.

For example, filter a diagnostic file in PowerShell:

```powershell
# Use the configured data directory if different.
$dataDir = Join-Path $HOME '.ghc-gateway'
Get-Content -LiteralPath (Join-Path $dataDir 'logs\diagnostics.jsonl') -Tail 1000 |
  ForEach-Object { ConvertFrom-Json $_ } |
  Where-Object { $_.requestId -eq 'req_example' } |
  Format-List
```

Diagnostics rotate at 10 MiB and retain at most five log files independently of daemon logs. Seven-day pruning runs when the diagnostic logger initializes or writes; disabling diagnostics does not immediately erase existing files or schedule background deletion. A request retains at most 32 records, a structure walk visits at most 256 nodes through depth four, and the pending queue is capped at 256 records and 1 MiB. Truncation and omitted/dropped records mean a trace may be incomplete; SSE deltas are counted, not logged individually.

If diagnostics are requested but the file cannot be initialized, startup fails. If recording later fails, inference continues unchanged and diagnostics stop writing. CLI status and `/admin/api/v1/status` expose diagnostic state and dropped/pending counts; a missing field from an older daemon means unknown, not disabled. A failed recorder requires an explicit diagnostic restart to recover. Diagnostic failures never substitute for the inference result.

## Upgrading Existing Installations

This release does not import retired schema content or manual model-capability settings. If an existing database fails strict migration checks, stop the gateway, keep the old data directory as a private backup, and start with `ghcg --data-dir <new-directory> serve`. Use the same `--data-dir <new-directory>` for `auth login` and every later management command, then reselect runtime preferences. Do not edit or copy migration records manually.

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

`npm test` already includes full verification of every fixture manifest and expected byte. Use
`npm run fixtures:verify` as an independent fixture-only check when the rest of the test suite is
not needed.

Use `node dist/src/cli/main.js` instead of `ghcg` when exercising the built CLI. Automated tests use scripted remotes and local fixed-response replay.
Official-client suites require explicit opt-in and remain offline:

```bash
GHC_GATEWAY_SDK_TESTS=1 npm run test:sdk
```

## License

[MIT](LICENSE)
