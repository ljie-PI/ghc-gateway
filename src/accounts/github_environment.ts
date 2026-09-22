import { domainToASCII } from "node:url";

export const GITHUB_COM_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GHES_CLIENT_ID = "Ov23li8tweQw6odWQebz";

export type GitHubEnvironment =
  | {
      readonly kind: "github.com";
      readonly host: "github.com";
      readonly webBaseUrl: "https://github.com";
      readonly apiBaseUrl: "https://api.github.com";
      readonly clientId: typeof GITHUB_COM_CLIENT_ID;
      readonly deviceCodeUrl: "https://github.com/login/device/code";
      readonly accessTokenUrl: "https://github.com/login/oauth/access_token";
    }
  | {
      readonly kind: "ghes";
      readonly host: string;
      readonly webBaseUrl: `https://${string}`;
      readonly apiBaseUrl: `https://${string}/api/v3`;
      readonly clientId: typeof GHES_CLIENT_ID;
      readonly deviceCodeUrl: string;
      readonly accessTokenUrl: string;
    };

export class GitHubEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubEnvironmentError";
  }
}

export function normalizeGitHubHost(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new GitHubEnvironmentError("GitHub host must be a domain or domain:port");
  }
  if (/[\s/?#@\\]/.test(trimmed) || trimmed.includes("://")) {
    throw new GitHubEnvironmentError("GitHub host must not include path, query, fragment, or credentials");
  }

  const [hostnamePart, portPart, extra] = splitHostPort(trimmed);
  if (extra !== undefined || hostnamePart === undefined) {
    throw new GitHubEnvironmentError("GitHub host must be a domain or domain:port");
  }

  const ascii = domainToASCII(hostnamePart.replace(/\.$/u, "")).toLowerCase();
  if (ascii.length === 0) {
    throw new GitHubEnvironmentError("GitHub host is not a valid domain");
  }

  if (portPart === undefined) {
    return ascii;
  }
  if (!/^[0-9]+$/u.test(portPart)) {
    throw new GitHubEnvironmentError("GitHub host port must be decimal");
  }
  const port = Number.parseInt(portPart, 10);
  if (port < 1 || port > 65_535) {
    throw new GitHubEnvironmentError("GitHub host port must be in 1..65535");
  }
  if (port === 443) {
    return ascii;
  }
  return `${ascii}:${port}`;
}

export function resolveGitHubEnvironment(input: string): GitHubEnvironment {
  const host = normalizeGitHubHost(input);
  if (host === "github.com") {
    return {
      kind: "github.com",
      host: "github.com",
      webBaseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      clientId: GITHUB_COM_CLIENT_ID,
      deviceCodeUrl: "https://github.com/login/device/code",
      accessTokenUrl: "https://github.com/login/oauth/access_token",
    };
  }

  const web = new URL(`https://${host}`);
  const api = new URL("/api/v3", web);
  const device = new URL("/login/device/code", web);
  const token = new URL("/login/oauth/access_token", web);
  return {
    kind: "ghes",
    host,
    webBaseUrl: web.origin as `https://${string}`,
    apiBaseUrl: `${api.origin}${api.pathname}` as `https://${string}/api/v3`,
    clientId: GHES_CLIENT_ID,
    deviceCodeUrl: device.toString(),
    accessTokenUrl: token.toString(),
  };
}

export function canonicalUserId(raw: string | number): string {
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (!/^[0-9]+$/u.test(text)) {
    throw new GitHubEnvironmentError("GitHub user id must be a positive integer");
  }
  const canonical = text.replace(/^0+/u, "");
  if (canonical.length === 0) {
    throw new GitHubEnvironmentError("GitHub user id must be a positive integer");
  }
  return canonical;
}

export function formatAccountId(normalizedHost: string, userId: string | number): string {
  return `${normalizedHost}/${canonicalUserId(userId)}`;
}

function splitHostPort(input: string): [string | undefined, string | undefined, string | undefined] {
  if (input.startsWith("[")) {
    return [undefined, undefined, "ipv6"];
  }
  const parts = input.split(":");
  if (parts.length === 1) {
    return [parts[0], undefined, undefined];
  }
  if (parts.length === 2) {
    return [parts[0], parts[1], undefined];
  }
  return [undefined, undefined, "extra"];
}
