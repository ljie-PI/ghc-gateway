import type { BoundAccount } from "../accounts/account_directory.js";
import type { AccountId } from "../accounts/credential_store.js";
import { copilotHeaders } from "./identity.js";
import type { OrderedHeaderFields } from "../gateway/header_fields.js";
import type {
  ChatCompletionsUpstreamRequest,
  MessagesUpstreamRequest,
  NativeResponsesUpstreamRequest,
  UpstreamByteResponse,
  UpstreamByteStream,
} from "./upstream_types.js";

export interface CopilotTarget {
  readonly endpoint: string;
  readonly token: string;
}

export interface BoundCopilot {
  readonly accountId: AccountId;
  readonly target: Readonly<CopilotTarget>;
  completeChat(request: Readonly<ChatCompletionsUpstreamRequest>): Promise<UpstreamByteResponse>;
  openChatStream(request: Readonly<ChatCompletionsUpstreamRequest>): Promise<UpstreamByteStream>;
  completeResponses(request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteResponse>;
  openResponsesStream(request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteStream>;
  completeMessages(request: Readonly<MessagesUpstreamRequest>): Promise<UpstreamByteResponse>;
  openMessagesStream(request: Readonly<MessagesUpstreamRequest>): Promise<UpstreamByteStream>;
}

export interface CopilotBackend {
  bind(account: Readonly<BoundAccount>, signal: AbortSignal): Promise<BoundCopilot>;
  close(): Promise<void>;
  forceClose(): void;
}

export interface OutboundHeaderFields {
  readonly gateway: OrderedHeaderFields;
  readonly client: OrderedHeaderFields;
}

const BLOCKED_CLIENT_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "anthropic-api-key",
  "anthropic-beta",
  "anthropic-version",
  "api-key",
  "api-token",
  "api_key",
  "apikey",
  "access-token",
  "auth-token",
  "authorization",
  "authentication-info",
  "b3",
  "baggage",
  "cf-connecting-ip",
  "connection",
  "content-range",
  "content-digest",
  "content-encoding",
  "content-length",
  "content-md5",
  "content-sha256",
  "content-type",
  "copilot-user-intent",
  "copilot-integration-id",
  "copilot-vision-request",
  "cookie",
  "cookie2",
  "cf-access-client-id",
  "cf-access-client-secret",
  "client-secret",
  "correlationid",
  "correlation-id",
  "digest",
  "dnt",
  "editor-plugin-version",
  "editor-version",
  "expect",
  "access-control-request-headers",
  "access-control-request-method",
  "forwarded",
  "from",
  "github-token",
  "host",
  "http2-settings",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
  "keep-alive",
  "grpc-trace-bin",
  "newrelic",
  "oauth-token",
  "openai-api-key",
  "openai-intent",
  "openai-organization",
  "openai-project",
  "ocp-apim-subscription-key",
  "origin",
  "proxy-authenticate",
  "proxy-authentication-info",
  "proxy-authorization",
  "proxy-connection",
  "private-token",
  "referer",
  "repr-digest",
  "request-id",
  "requestid",
  "sec-gpc",
  "signature",
  "signature-input",
  "security-token",
  "set-cookie",
  "sentry-trace",
  "subscription-key",
  "te",
  "traceparent",
  "trace-id",
  "tracestate",
  "trailer",
  "transfer-encoding",
  "true-client-ip",
  "upgrade",
  "upgrade-insecure-requests",
  "user-agent",
  "via",
  "vision-request",
  "x-amzn-trace-id",
  "x-amz-content-sha256",
  "x-amz-decoded-content-length",
  "x-amz-security-token",
  "x-amz-trailer",
  "x-api-key",
  "x-api_key",
  "x-apikey",
  "x-access-token",
  "x-auth-token",
  "x-copilot-api-version",
  "x-copilot-client-version",
  "x-copilot-integration-id",
  "x-cloud-trace-context",
  "x-client-trace-id",
  "x-client-ip",
  "x-client-cert",
  "x-correlation-id",
  "x-correlationid",
  "x-github-api-version",
  "x-github-token",
  "x-initiator",
  "x-openai-api-key",
  "x-oauth-token",
  "x-real-ip",
  "x-remote-user",
  "x-rewrite-url",
  "x-request-id",
  "x-requestid",
  "x-span-id",
  "x-trace-id",
  "x-vscode-user-agent-library-version",
  "x-webhook-signature",
  "www-authenticate",
]);

export function outboundHeaderFields(
  token: string,
  extra?: Headers,
  clientHeaderFields: OrderedHeaderFields = [],
): OutboundHeaderFields {
  const normalizedGateway = new Headers({ ...copilotHeaders(), authorization: `Bearer ${token}` });
  extra?.forEach((value, name) => {
    if (!gatewayOwnedHeader(name)) normalizedGateway.set(name, value);
  });
  const gateway = [...normalizedGateway].map(([name, value]) => Object.freeze({ name, value }));

  const connectionHeaders = connectionTokenHeaders(clientHeaderFields);
  const client = clientHeaderFields.filter(({ name }) => {
    const lowerName = name.toLowerCase();
    return !blockedClientHeader(lowerName) && !connectionHeaders.has(lowerName);
  });
  return {
    gateway: Object.freeze(gateway),
    client: Object.freeze(client),
  };
}

export function outboundHeaders(token: string, extra?: Headers): Headers {
  const fields = outboundHeaderFields(token, extra);
  const headers = new Headers();
  for (const field of [...fields.gateway, ...fields.client]) {
    headers.append(field.name, field.value);
  }
  return headers;
}

function gatewayOwnedHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName === "authorization" || Object.hasOwn(copilotHeaders(), lowerName);
}

function blockedClientHeader(name: string): boolean {
  return name.startsWith(":")
    || BLOCKED_CLIENT_HEADERS.has(name)
    || sensitiveName(name)
    || name.startsWith("sec-")
    || name.startsWith("x-b3-")
    || name.startsWith("x-datadog-")
    || name.startsWith("x-envoy-")
    || name.startsWith("x-forwarded-")
    || name.startsWith("x-ghcg-")
    || name.startsWith("x-original-forwarded-")
    || name.startsWith("x-opentelemetry-")
    || name.startsWith("x-ot-")
    || name.startsWith("x-stainless-")
    || name.endsWith("-access-token")
    || name.endsWith("-api-key")
    || name.endsWith("-api-token")
    || name.endsWith("-auth-token")
    || name.endsWith("-authorization")
    || name.endsWith("-baggage")
    || name.endsWith("-client-secret")
    || name.endsWith("-correlationid")
    || name.endsWith("-github-token")
    || name.endsWith("-oauth-token")
    || name.endsWith("-private-token")
    || name.endsWith("-password")
    || name.endsWith("-secret")
    || name.endsWith("-session-id")
    || name.endsWith("_api_key")
    || name.endsWith("_api_token")
    || name.endsWith("_authorization")
    || name.endsWith("_password")
    || name.endsWith("_secret")
    || name.endsWith("_session_id")
    || name.endsWith("-request-id")
    || name.endsWith("-correlation-id")
    || name.endsWith("-requestid")
    || name.endsWith("-span-id")
    || name.endsWith("-subscription-key")
    || name.endsWith("-token")
    || name.endsWith("-trace-id")
    || name.endsWith("_token")
    || name.endsWith("traceparent")
    || name.endsWith("tracestate")
    || name === "conversation-id"
    || name === "fastly-client-ip"
    || name === "password"
    || name === "session"
    || name === "x-session"
    || name === "session-id"
    || name === "session_id"
    || name === "thread-id"
    || name === "token"
    || name === "x-session-id"
    || name === "uber-trace-id"
    || name === "x-ot-span-context";
}

function sensitiveName(name: string): boolean {
  if (name === "idempotency-key") return false;
  return credentialHeaderName(name) || integrityHeaderName(name) || identityHeaderName(name);
}

function credentialHeaderName(name: string): boolean {
  const tokens = headerNameTokens(name);
  return name === "dpop" || tokens.some((token) => [
    "apikey", "assertion", "auth", "authentication", "authorization", "cert", "certificate", "cookie", "csrf",
    "bearer", "credential", "credentials", "jwt", "key", "oauth", "passphrase", "passwd", "password", "pwd",
    "saml", "secret", "secrets", "token", "xsrf",
  ].includes(token)
    || /^(?:access|api|auth|bearer|client|credential|id|oauth|private|refresh|security|session)token$/u.test(token)
    || /^(?:bearer|jwt|oauth|refresh|session|id)token$/u.test(token)
    || /^(?:client|db)(?:passphrase|passwd|password|pwd|secret|token)$/u.test(token)
    || /^(?:private|security)(?:key|secret|token)$/u.test(token)
    || /^(?:access|api|auth|client|credential|id|oauth|private|refresh|security|session)?key$/u.test(token));
}

function integrityHeaderName(name: string): boolean {
  return headerNameTokens(name).some((token) => (
    ["checksum", "digest", "hash", "hmac", "md5", "signature"].includes(token)
    || /^crc\d*$/u.test(token)
    || /^sha\d+$/u.test(token)
  ));
}

function identityHeaderName(name: string): boolean {
  const tokens = headerNameTokens(name);
  return tokens.some((token) => [
    "account", "accountid", "clientid", "consumer", "conversation", "device", "email", "identity", "oidc", "principal",
    "session", "subject", "tenant", "tenantid", "thread", "user", "userid", "username",
  ].includes(token))
    || containsTokenPair(tokens, "client", "ip")
    || containsTokenPair(tokens, "client", "id")
    || containsTokenPair(tokens, "remote", "user")
    || containsTokenPair(tokens, "rewrite", "url")
    || tokens.includes("original")
    || (tokens.includes("ssl") && tokens.includes("client"));
}

function headerNameTokens(name: string): readonly string[] {
  return name.split(/[-_]/u).filter((token) => token.length > 0);
}

function containsTokenPair(tokens: readonly string[], left: string, right: string): boolean {
  return tokens.some((token, index) => token === left && tokens[index + 1] === right);
}

function connectionTokenHeaders(fields: OrderedHeaderFields): ReadonlySet<string> {
  const names = new Set<string>();
  for (const field of fields) {
    if (field.name.toLowerCase() !== "connection") {
      continue;
    }
    for (const token of field.value.split(",")) {
      const name = token.trim().toLowerCase();
      if (name !== "") {
        names.add(name);
      }
    }
  }
  return names;
}
