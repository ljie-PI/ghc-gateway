import { describe, expect, it } from "vitest";
import {
  captureNormalizedHeaderFields,
  captureRawHeaderFields,
  MAX_INBOUND_HEADER_BYTES,
  MAX_INBOUND_HEADER_FIELDS,
} from "../../src/gateway/header_fields.js";
import { outboundHeaderFields } from "../../src/copilot/backend.js";

describe("ordered client header fields", () => {
  it("preserves safe duplicates in order and centrally strips owned and dynamic hop-by-hop fields", () => {
    const captured = captureRawHeaderFields([
      "X-Vendor-Feature", "first",
      "connection", "x-remove, keep-alive",
      "x-remove", "private",
      "openai-beta", "second",
      "x-vendor-feature", "third",
      "authorization", "client-secret",
      "cookie", "private-cookie",
      "x-forwarded-for", "127.0.0.1",
      "traceparent", "private-trace",
      "x-ghcg-private", "private-gateway",
      "anthropic-beta", "client-beta",
    ]);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    const outbound = outboundHeaderFields("gateway-token", new Headers({
      "content-type": "application/json",
      "anthropic-beta": "gateway-beta",
    }), captured.fields);
    expect(outbound.client).toEqual([
      { name: "X-Vendor-Feature", value: "first" },
      { name: "openai-beta", value: "second" },
      { name: "x-vendor-feature", value: "third" },
    ]);
    expect(outbound.gateway).toEqual(expect.arrayContaining([
      { name: "authorization", value: "Bearer gateway-token" },
      { name: "content-type", value: "application/json" },
      { name: "anthropic-beta", value: "gateway-beta" },
    ]));
  });

  it("fails closed on malformed, excessive-count, and excessive-byte captures", () => {
    expect(captureRawHeaderFields(["valid", "ok", "orphan"]).ok).toBe(false);
    expect(captureRawHeaderFields(["bad name", "value"]).ok).toBe(false);
    expect(captureRawHeaderFields(["valid", "bad\rvalue"]).ok).toBe(false);
    expect(captureRawHeaderFields(Array.from(
      { length: (MAX_INBOUND_HEADER_FIELDS + 1) * 2 },
      (_, index) => index % 2 === 0 ? "x-limit" : "value",
    )).ok).toBe(false);
    expect(captureRawHeaderFields(["x-limit", "x".repeat(MAX_INBOUND_HEADER_BYTES)]).ok).toBe(false);
  });

  it("blocks gateway-owned, credential, body-integrity, privacy, and tracing aliases", () => {
    const blocked = [
      "accept",
      "accept-encoding",
      "access-token",
      "anthropic-api-key",
      "anthropic-version",
      "api-key",
      "api-token",
      "authentication-info",
      "auth-token",
      "client-secret",
      "content-digest",
      "content-encoding",
      "content-length",
      "content-range",
      "content-sha256",
      "content-type",
      "copilot-integration-id",
      "copilot-vision-request",
      "digest",
      "editor-plugin-version",
      "editor-version",
      "expect",
      "from",
      "access-control-request-headers",
      "access-control-request-method",
      "host",
      "x-http-method",
      "x-http-method-override",
      "x-method-override",
      "openai-intent",
      "openai-organization",
      "openai-project",
      "oauth-token",
      "password",
      "proxy-authentication-info",
      "origin",
      "proxy-authorization",
      "referer",
      "request-id",
      "sec-fetch-site",
      "signature-input",
      "security-token",
      "session-id",
      "session_id",
      "set-cookie",
      "tracestate",
      "transfer-encoding",
      "user-agent",
      "via",
      "x-amz-security-token",
      "x-amz-content-sha256",
      "x-amz-decoded-content-length",
      "x-api-secret",
      "x-body-hash",
      "x-body-sha256",
      "x-body-signature",
      "x-checksum-sha256",
      "x-client-cert",
      "x-client-ip",
      "x-client-id",
      "client-ip",
      "x-consumer-id",
      "x-consumer-username",
      "x-custom-password",
      "x-custom-session-id",
      "x-content-hash",
      "x-content-hmac",
      "x-content-md5",
      "x-original-forwarded-for",
      "x-original-url",
      "x-original-host",
      "x-original-method",
      "x-original-proto",
      "x-payload-digest",
      "x-payload-hash",
      "x-payload-sha256",
      "x-password",
      "x-session",
      "x-session-id",
      "x-remote-user",
      "x-rewrite-url",
      "x-vendor-credential",
      "x-vendor-key",
      "x-vendor-token",
      "x-vendor-apikey",
      "x-vendor-apitoken",
      "x-vendor-authkey",
      "x-vendor-accesstoken",
      "x-vendor-clientsecret",
      "x-vendor-bearer",
      "x-vendor-jwt",
      "jwt",
      "x-oauth",
      "x-cookie",
      "x-csrf",
      "x-xsrf",
      "x-saml",
      "x-clientid",
      "x-vendor-bearertoken",
      "x-vendor-oauthtoken",
      "x-vendor-refreshtoken",
      "x-vendor-sessiontoken",
      "x-vendor-idtoken",
      "x-vendor-dbpassword",
      "x-vendor-clientpassphrase",
      "x-vendor-passphrase",
      "x-vendor-passwd",
      "x-vendor-pwd",
      "x-vendor-signature",
      "x-vendor-hmac",
      "x-goog-iap-jwt-assertion",
      "x-goog-hash",
      "x-webhook-signature",
      "x-user-id",
      "x-user-email",
      "x-user-identity",
      "x-username",
      "x-userid",
      "x-account-id",
      "x-tenant-id",
      "x-subject",
      "x-authenticated-user",
      "x-device-id",
      "x-original-uri",
      "x-ssl-client-subject-dn",
      "x-ssl-client-verify",
      "dpop",
      "x-amzn-oidc-data",
      "x-amz-trailer",
      "ssl-client-cert",
      "upgrade-insecure-requests",
      "x-correlation-id",
      "x-custom-api-key",
      "x-custom-authorization",
      "x-custom-client-secret",
      "x-custom-trace-id",
      "x-initiator",
      "x-request-id",
      "x-stainless-runtime",
    ];
    const outbound = outboundHeaderFields("gateway-token", undefined, blocked.map((name) => ({
      name,
      value: "client-value",
    })));
    expect(outbound.client).toEqual([]);
    expect(outboundHeaderFields("gateway-token", undefined, [
      { name: "idempotency-key", value: "request-1" },
      { name: "x-authoring-mode", value: "safe" },
      { name: "x-uncertainty-mode", value: "safe" },
      { name: "x-shape-mode", value: "safe" },
      { name: "x-shadow-feature", value: "safe" },
      { name: "x-monkey-feature", value: "safe" },
      { name: "x-hotkey-mode", value: "safe" },
      { name: "x-turnkey-feature", value: "safe" },
      { name: "x-concert-event", value: "safe" },
      { name: "x-reassertion-mode", value: "safe" },
    ]).client).toEqual([
      { name: "idempotency-key", value: "request-1" },
      { name: "x-authoring-mode", value: "safe" },
      { name: "x-uncertainty-mode", value: "safe" },
      { name: "x-shape-mode", value: "safe" },
      { name: "x-shadow-feature", value: "safe" },
      { name: "x-monkey-feature", value: "safe" },
      { name: "x-hotkey-mode", value: "safe" },
      { name: "x-turnkey-feature", value: "safe" },
      { name: "x-concert-event", value: "safe" },
      { name: "x-reassertion-mode", value: "safe" },
    ]);
  });

  it("provides a normalized Gateway.fetch fallback when raw fields are unavailable", () => {
    const headers = new Headers();
    headers.append("x-vendor-feature", "first");
    headers.append("x-vendor-feature", "second");
    const captured = captureNormalizedHeaderFields(headers);
    expect(captured).toEqual({
      ok: true,
      fields: [{ name: "x-vendor-feature", value: "first, second" }],
    });
  });

  it("rejects malformed Connection token lists during capture", () => {
    expect(captureRawHeaderFields(["connection", "\"x-hop\"", "x-hop", "private"]).ok).toBe(false);
    expect(captureRawHeaderFields(["connection", "x-hop;foo", "x-hop", "private"]).ok).toBe(false);
    expect(captureNormalizedHeaderFields(new Headers({ connection: "\"x-hop\"", "x-hop": "private" })).ok).toBe(false);
    expect(captureNormalizedHeaderFields(new Headers({ connection: "x-hop;foo", "x-hop": "private" })).ok).toBe(false);
  });
});
