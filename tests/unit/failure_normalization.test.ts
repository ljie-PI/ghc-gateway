import { describe, expect, it } from "vitest";
import { AccountDirectoryError } from "../../src/accounts/account_directory.js";
import { ChatSseError } from "../../src/copilot/chat_sse.js";
import {
  normalizeAccountBindingFailure,
  normalizeCatalogFailure,
  normalizeChatStreamFailure,
  normalizeCopilotBindingFailure,
  normalizeTransportFailure,
} from "../../src/copilot/failures.js";
import { CapiFetchError } from "../../src/copilot/models_source.js";
import { TokenRefreshError } from "../../src/copilot/token_refresh.js";
import {
  InvalidUpstreamResponseError,
  UpstreamTimeoutError,
} from "../../src/copilot/transport.js";
import {
  failureFromSignal,
  failureFromUnknown,
  GatewayFailureError,
} from "../../src/gateway/failures.js";

describe("typed semantic failure normalization", () => {
  it("preserves source and phase for account, credential, catalog, transport, and parser seams", () => {
    expect(normalizeAccountBindingFailure(
      new AccountDirectoryError("no_default", "missing"),
    ).failure).toMatchObject({
      kind: "authentication",
      source: "account",
      phase: "bind",
    });
    expect(normalizeCopilotBindingFailure(
      new TokenRefreshError("timeout", "private"),
      new AbortController().signal,
    ).failure).toMatchObject({
      kind: "upstream_timeout",
      source: "credential",
      phase: "refresh",
    });
    expect(normalizeCatalogFailure(
      new CapiFetchError(502, undefined, "invalid_upstream_response"),
      new AbortController().signal,
    ).failure).toMatchObject({
      kind: "invalid_upstream_response",
      source: "catalog",
      phase: "discover",
    });
    expect(normalizeTransportFailure(
      new InvalidUpstreamResponseError(),
      new AbortController().signal,
      { source: "transport", phase: "headers" },
    ).failure).toMatchObject({
      kind: "invalid_upstream_response",
      source: "transport",
      phase: "headers",
    });
    expect(normalizeChatStreamFailure(
      new ChatSseError("truncated", "private"),
      new AbortController().signal,
    ).failure).toMatchObject({
      kind: "upstream_stream_truncated",
      source: "parser",
      phase: "parse",
    });
    expect(normalizeCatalogFailure(
      new Error("programmer bug"),
      new AbortController().signal,
    ).failure.kind).toBe("internal");
    expect(normalizeCopilotBindingFailure(
      new Error("programmer bug"),
      new AbortController().signal,
    ).failure.kind).toBe("internal");
  });

  it("preserves an internal deadline reason without globally treating AbortError as timeout", () => {
    const deadline = new AbortController();
    deadline.abort(new GatewayFailureError({
      kind: "upstream_timeout",
      source: "gateway",
      phase: "deadline",
    }));
    expect(failureFromSignal(deadline.signal, {
      source: "transport",
      phase: "connect",
    })).toMatchObject({
      kind: "upstream_timeout",
      source: "gateway",
      phase: "deadline",
    });

    const client = new AbortController();
    client.abort();
    expect(failureFromSignal(client.signal, {
      source: "transport",
      phase: "connect",
    })).toMatchObject({
      kind: "aborted",
      source: "transport",
      phase: "connect",
    });
    expect(failureFromUnknown(new DOMException("aborted", "AbortError"))).toMatchObject({
      kind: "internal",
    });
    expect(normalizeTransportFailure(
      new DOMException("upstream aborted", "AbortError"),
      new AbortController().signal,
      { source: "transport", phase: "headers" },
    ).failure.kind).toBe("internal");
  });

  it("keeps transport timeout distinct from network fallback", () => {
    expect(normalizeTransportFailure(
      new UpstreamTimeoutError(),
      new AbortController().signal,
      { source: "transport", phase: "headers" },
    ).failure.kind).toBe("upstream_timeout");
    expect(normalizeTransportFailure(
      new TypeError("private URL"),
      new AbortController().signal,
      { source: "transport", phase: "headers" },
    ).failure.kind).toBe("upstream_network");
    expect(normalizeTransportFailure(
      new Error("programmer bug"),
      new AbortController().signal,
      { source: "transport", phase: "headers" },
    ).failure).toMatchObject({
      kind: "internal",
      source: "gateway",
      phase: "internal",
    });
  });
});
