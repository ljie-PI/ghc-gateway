# GHC Gateway

GHC Gateway is a loopback-only GitHub Copilot gateway with OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages APIs. It runs as one Node.js process and includes a local Admin UI for account, model, runtime configuration, history, usage, and operational-event management.

## Requirements

- Node.js 24.20.0 or newer
- A GitHub Copilot subscription
- Windows x64, Linux x64/arm64, or macOS x64/arm64

Storage uses Node.js built-in SQLite. Neither package installation nor source installation requires Python or a local C++ compiler. SQLite's version follows the installed Node.js release; no extra runtime flags are required. Earlier Node.js 24 releases are not supported because Windows file-identity differences can prevent secure daemon startup.

## Installation

```bash
npm install --global @ljie-pi/ghc-gateway
```

The package installs one executable: `ghcg`.

To build and run a source checkout instead, see [Development](#development).

## Start The Gateway

Run in the foreground:

```bash
ghcg serve
```

Or start one detached, self-managed daemon:

```bash
ghcg start
ghcg status
ghcg restart
ghcg stop
```

The listener is always `127.0.0.1`. The default port is `31400`. A different startup port can be selected only for `serve` or `start`:

```bash
ghcg serve --port 31401
ghcg start --port 31401
```

There is no watchdog, automatic restart, operating-system service installation, or second server process. Stop and restart verify the daemon PID, operating-system process start identity, instance nonce, and authenticated control endpoint before termination.

## Authentication And Accounts

Start GitHub.com device authorization:

```bash
ghcg auth login
```

Start authorization for GitHub Enterprise Server:

```bash
ghcg auth login --host github.example.com
```

Other account commands:

```text
ghcg auth login poll <flow-id>
ghcg auth logout [--account <account-id>]
ghcg auth status
ghcg accounts list
ghcg accounts use <account-id>
ghcg accounts remove <account-id>
```

Management commands are authenticated clients of the running gateway. They never open its SQLite database or credential file in a second process. If the gateway is not running, start it with `ghcg start` or `ghcg serve` first.

## Models

```text
ghcg models list [--account <account-id>]
ghcg models current
ghcg models set <model-id>
```

Preferred models are account-specific. If a catalog refresh removes a preferred model, it is marked invalid and must be explicitly reselected. The gateway never silently selects the first model.

The Models Admin view shows account-scoped native HTTP capabilities for Chat, Messages, and Responses, including discovery/configuration state, source, conflicts, and revisions. It can set or reset bounded per-model overrides. An exact model ID absent from discovery may be explicitly enabled as configured/unverified; this does not prove account entitlement, and built-in model names are never exposed automatically.

Unknown or malformed capability declarations remain unknown. The gateway does not guess Chat support, probe a paid inference route, or retry a rejected model through a different protocol.

For conversions that require an output-token value, an explicit valid request value wins. Otherwise the model's configured default is used, followed by `min(8192, known output ceiling)` or `4096` when the ceiling is unknown. Invalid explicit request values are not replaced by a default.

## Admin UI

```bash
ghcg admin open
```

This requests a one-use, 60-second bootstrap token through authenticated local control and opens it in the URL fragment. The browser exchanges it for an in-memory Admin Session; the token is removed from the URL and is not stored in browser storage.

Admin security defaults:

- HttpOnly, SameSite=Strict session cookie scoped to `/admin`
- 30-minute idle expiry and 12-hour absolute expiry
- exact loopback Origin and CSRF validation for mutations
- sessions invalidated when the gateway restarts
- bounded, replayable SSE monitoring with no WebSocket or remote Admin access

The six views are Overview, Accounts, Models, Configuration, Responses History, and Events.
The Accounts view checks an active device authorization automatically at GitHub's required interval. Keep that
view open until it reports completion; closing or leaving it stops browser polling, and no device code or token is
stored in browser storage.

## HTTP Interfaces

All routes use the same loopback listener. Inference routes do not require a separate gateway API key in this release.

| Method | Route | Interface |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses, native or Chat bridge |
| `POST` | `/v1/messages` | Anthropic Messages |
| `GET` | `/v1/models` | OpenAI models; Anthropic shape with `anthropic-version` |
| `GET` | `/healthz` | Process liveness |
| `GET` | `/readyz` | Runtime readiness |
| `GET` | `/admin/*` | Admin static application |

No unversioned, compact, trailing-slash, or legacy route aliases are registered.
The retired Ollama-compatible routes `/api/chat`, `/api/tags`, and `/api/version` are not registered.

### Protocol Routing And Conversion

Routing uses the bound account's immutable model-capability snapshot. A matching native HTTP
protocol is selected first and preserves protocol extensions. Otherwise the gateway evaluates
conversion compatibility without making an inference call, then uses these fixed priorities:

- Chat: Responses, then Messages
- Messages: Chat, then Responses
- Responses: Chat, then Messages

One request captures one plan and performs exactly one typed upstream operation. The gateway does
not probe interfaces, infer routing from model names, retry through another protocol, or recurse
through another local endpoint.

Converted requests use strict direction-specific validation. Unknown protocol keys, duplicate
keys, invalid types or ranges, `n` values other than `1`, unbound tool results, invalid complete
tool arguments, and constraints that the target cannot preserve are rejected before inference.
Message order, images, function names and arguments, call IDs, result binding, structured output,
forced tool choice, and `parallel_tool_calls: false` are preserved when the route is eligible.
File, audio, and server-hosted tools require an explicit adapter and are otherwise rejected.

Optional reasoning effort or budget can be coarsened, and nonportable reasoning presentation or
opaque state can be omitted on converted routes. These finite, content-free degradations do not
change success accounting, add warning text, or trigger a retry. Native routes do not apply
conversion-only degradation.

Responses continuations stay on their recorded account, model, origin, and upstream protocol.
For Responses-to-Messages conversion, `previous_response_id` is consumed locally and is never sent
to the Messages operation. The bounded Responses History can restore completed tool checkpoints;
it is not a full transcript or reasoning-state store.

## Configuration

Global options:

```text
--data-dir <path>
--json
```

Startup configuration applies only when the process starts. Priority is CLI, then environment, then default.

| Setting | CLI | Environment | Default |
| --- | --- | --- | --- |
| Port | `--port` | `GHC_GATEWAY_PORT` | `31400` |
| Data directory | `--data-dir` | `GHC_GATEWAY_DATA_DIR` | `~/.ghc-gateway` |
| Log level | `--log-level` | `GHC_GATEWAY_LOG_LEVEL` | `info` |

Runtime configuration is stored in SQLite. Environment values seed a missing database row once; later starts use the persisted values. Read or update it through:

```text
ghcg config get [key]
ghcg config set <key> <value>
```

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

The corresponding one-time seed variable uses the `GHC_GATEWAY_` prefix and upper snake case, for example `GHC_GATEWAY_LIMITS_REQUEST_BODY_BYTES`.

## Local Data And Privacy

The default data directory is `~/.ghc-gateway` and contains:

- `state.db` with runtime settings, account metadata, bounded Responses History, usage buckets, and sanitized operational events
- `credentials.json` with protected credentials
- `daemon.json` with protected process identity and local-control authentication
- `logs/*.jsonl` with bounded, sanitized daemon logs

Credentials and daemon identity use protected atomic files. Prompts, responses, tool arguments, authorization values, and complete upstream error bodies are not persisted in telemetry or exposed by Admin errors.

Responses History stores only minimal bridge tool checkpoints, at most 512 responses, with a seven-day default TTL. Separate content-free route receipts bind observed response IDs to the account, resolved model, trusted upstream origin, native or converted protocol owner, conversion version, and checkpoint state. Receipts are independently bounded at 2048 and do not consume the Admin tool-history count.

Known continuations keep their original compatible route under the currently bound account; the gateway never switches accounts to follow a response ID. Untracked native IDs are passed through only on a direct native Responses route so the upstream can authorize them. If bounded cleanup or account removal has discarded exact ownership evidence, untracked continuation fails closed until Responses History is explicitly cleared. Legacy unscoped history remains visible as unowned data after migration and cannot be used for new continuation; start a new conversation instead.

Usage is content-free and retained for 90 days by default. Operational Events retain at most 512 sanitized entries for seven days by default.

## Existing Installations

The switch to Node.js built-in SQLite preserves the current `state.db` and `credentials.json` files. It requires no database reset, export/import, or reauthentication. Older, incompatible gateway data layouts and process state are not imported. No compatibility executable, environment, data-path, or runtime fallback aliases are provided.

## Automation

Every command accepts `--json` and writes one compact success or error object. Human successes go to stdout and errors go to stderr.

```bash
ghcg --json status
ghcg --json accounts list
ghcg --json config get limits.requestBodyBytes
```

## Development

Use [Run from Source](#run-from-source) for a local instance, or [Validate Changes](#validate-changes) when preparing code changes.

### Run from Source

Run these commands from the repository root using a supported Node.js version. No global `ghcg` installation or `npm link` is needed.

Install dependencies once after cloning and again only when dependencies change:

```sh
npm ci
```

Build after source changes:

```sh
npm run build
```

Run the built gateway in the foreground:

```sh
npm start
```

This listens on `127.0.0.1:31400` by default and accepts only local connections. Keep the terminal open; press `Ctrl+C` to stop it. Pass startup options after `--`, for example `npm start -- --port 31401`.

In a second terminal, use the built CLI for authentication and the Admin UI:

```sh
node dist/src/cli/main.js auth login
node dist/src/cli/main.js admin open
```

Follow the URL and device code printed by `auth login` to authorize your GitHub account before opening the Admin UI. These management commands require the gateway to be running.

OpenAI-compatible clients can use `http://127.0.0.1:31400/v1` as their base URL. The current release does not require a separate gateway API key.

As an alternative, stop the foreground process first, then start one detached, self-managed daemon:

```sh
node dist/src/cli/main.js start
node dist/src/cli/main.js status
```

Stop the daemon when finished:

```sh
node dist/src/cli/main.js stop
```

Do not run the foreground process and detached daemon simultaneously for the same data directory and port. Later starts can reuse the existing dependencies and build until they change.

### Validate Changes

Install dependencies before checking types or linting, then build before running the runtime and packaging checks. This is a separate validation workflow, not an extra step required for every ordinary startup.

```sh
npm ci
npm run typecheck
npm run lint
npm run build
npm run smoke:sqlite
npm test
npm run fixtures:verify
npm run e2e
npm run bench -- full --repeat 3
npm run pack
```

Automated tests are offline and use scripted GitHub/Copilot remotes. Official-client suites are manual release evidence and require explicit opt-in:

```bash
GHC_GATEWAY_SDK_TESTS=1 npm run test:sdk
GHC_GATEWAY_LIVE_TESTS=1 npm run test:live:sdk
```

The live suite can contact real GitHub Copilot and must not be run as part of normal development or CI. Set `GHC_GATEWAY_LIVE_CHAT_MODEL`, `GHC_GATEWAY_LIVE_VISION_MODEL`, and `GHC_GATEWAY_LIVE_REASONING_MODEL` to verified shared Chat models for their respective scenarios. Set `GHC_GATEWAY_LIVE_RESPONSES_MODEL` to a verified native Responses model, or set `GHC_GATEWAY_LIVE_NATIVE_RESPONSES_NOT_AVAILABLE=1` only after verifying that the current account catalog has no native-capable model.

## License

[MIT](LICENSE)
