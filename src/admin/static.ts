import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AdminStaticModule } from "../gateway/create_gateway.js";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
} as const;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createAdminStaticModule(assetRoot: string): AdminStaticModule {
  const root = path.resolve(assetRoot);

  return {
    async handle(request, signal) {
      signal.throwIfAborted();
      const pathname = new URL(request.url).pathname;
      if (request.method !== "GET") {
        return notFound();
      }
      if (pathname.startsWith("/assets/")) {
        const relativePath = decodeAssetPath(pathname);
        if (relativePath === undefined) {
          return notFound();
        }
        const asset = await readAsset(root, relativePath, signal);
        if (asset !== undefined) {
          return assetResponse(asset, relativePath);
        }
        return notFound();
      }
      if (pathname !== "/") {
        return notFound();
      }

      const index = await readAsset(root, "index.html", signal);
      if (index === undefined) {
        return notFound();
      }
      return new Response(new Uint8Array(index), { headers: HTML_HEADERS });
    },
  };
}

function decodeAssetPath(pathname: string): string | undefined {
  const encoded = pathname.slice(1);
  if (/%(?:00|2f|5c|25)/i.test(encoded)) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  const segments = decoded.split("/");
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("%")
    || segments.some((part) => part === "" || part === "." || part === "..")) {
    return undefined;
  }
  return segments.join("/");
}

async function readAsset(root: string, relativePath: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
  signal.throwIfAborted();
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, candidate)) {
    return undefined;
  }
  try {
    const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    signal.throwIfAborted();
    if (!isWithin(resolvedRoot, resolvedCandidate)) {
      return undefined;
    }
    const body = await readFile(resolvedCandidate, { signal });
    signal.throwIfAborted();
    return body;
  } catch (error: unknown) {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return undefined;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assetResponse(body: Uint8Array, relativePath: string): Response {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const headers = new Headers();
  headers.set("Content-Type", MIME_TYPES[extension] ?? "application/octet-stream");
  if (extension === ".html") {
    headers.set("Cache-Control", "no-store");
  } else if (isHashedAsset(relativePath)) {
    headers.set("Cache-Control", IMMUTABLE_CACHE);
  }
  return new Response(new Uint8Array(body), { headers });
}

function isHashedAsset(relativePath: string): boolean {
  return relativePath.startsWith("assets/") && /[.-][a-zA-Z0-9_-]{8,}\.[^.]+$/.test(relativePath);
}

function notFound(): Response {
  return new Response("404 Not Found", { status: 404 });
}
