import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminStaticModule } from "../../src/admin/static.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

async function assetRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-admin-static-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>Admin</title>");
  return root;
}

describe("AdminStaticModule", () => {
  it("serves the Admin index for the root and valid SPA paths", async () => {
    const root = await assetRoot();
    const staticModule = createAdminStaticModule(root);

    for (const pathname of ["/admin", "/admin/", "/admin/accounts", "/admin/responses/history"]) {
      const response = await staticModule.handle(
        new Request(`http://127.0.0.1:31400${pathname}`),
        new AbortController().signal,
      );
      expect(response.status, pathname).toBe(200);
      expect(response.headers.get("content-type"), pathname).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control"), pathname).toBe("no-store");
      expect(await response.text(), pathname).toBe("<!doctype html><title>Admin</title>");
    }
  });

  it("serves exact assets with MIME types and immutable caching only for hashed assets", async () => {
    const root = await assetRoot();
    await writeFile(path.join(root, "assets", "app-D4f19aBc.js"), "export const ready = true;");
    await writeFile(path.join(root, "assets", "theme.css"), "body { color: black; }");
    await writeFile(path.join(root, "icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    const staticModule = createAdminStaticModule(root);

    const script = await staticModule.handle(
      new Request("http://127.0.0.1:31400/admin/assets/app-D4f19aBc.js"),
      new AbortController().signal,
    );
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe("export const ready = true;");

    const style = await staticModule.handle(
      new Request("http://127.0.0.1:31400/admin/assets/theme.css"),
      new AbortController().signal,
    );
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(style.headers.has("cache-control")).toBe(false);

    const icon = await staticModule.handle(
      new Request("http://127.0.0.1:31400/admin/icon.svg"),
      new AbortController().signal,
    );
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("returns 404 for missing assets instead of falling back to the SPA", async () => {
    const staticModule = createAdminStaticModule(await assetRoot());

    for (const pathname of [
      "/admin/assets",
      "/admin/assets/",
      "/admin/assets/missing.js",
      "/admin/favicon.ico",
    ]) {
      const response = await staticModule.handle(
        new Request(`http://127.0.0.1:31400${pathname}`),
        new AbortController().signal,
      );
      expect(response.status, pathname).toBe(404);
      expect(response.headers.get("content-type"), pathname).not.toBe("text/html; charset=utf-8");
    }
  });

  it("does not serve Admin API, control, protocol, probe, or non-GET requests", async () => {
    const staticModule = createAdminStaticModule(await assetRoot());
    const requests = [
      new Request("http://127.0.0.1:31400/admin/api/v1"),
      new Request("http://127.0.0.1:31400/admin/api/v1/status"),
      new Request("http://127.0.0.1:31400/__ghcg/control/v1/status"),
      new Request("http://127.0.0.1:31400/v1/models"),
      new Request("http://127.0.0.1:31400/v1/chat/completions"),
      new Request("http://127.0.0.1:31400/healthz"),
      new Request("http://127.0.0.1:31400/readyz"),
      new Request("http://127.0.0.1:31400/admin", { method: "HEAD" }),
      new Request("http://127.0.0.1:31400/admin/dashboard", { method: "POST" }),
    ];

    for (const request of requests) {
      const response = await staticModule.handle(request, new AbortController().signal);
      expect(response.status, `${request.method} ${new URL(request.url).pathname}`).toBe(404);
    }
  });

  it("rejects traversal, encoded separators, NUL, malformed escapes, and root escapes", async () => {
    const root = await assetRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "ghc-gateway-admin-static-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "not an Admin asset");
    await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const staticModule = createAdminStaticModule(root);
    const paths = [
      "/admin/..%2foutside.txt",
      "/admin/%2fetc/passwd",
      "/admin/assets%5capp.js",
      "/admin/assets/%00app.js",
      "/admin/assets/%252fapp.js",
      "/admin/assets/%",
      "/admin/%2e%2e/outside.txt",
      "/admin/%61pi/v1/status",
      "/admin/escape/secret.txt",
    ];

    for (const pathname of paths) {
      const response = await staticModule.handle(
        new Request(`http://127.0.0.1:31400${pathname}`),
        new AbortController().signal,
      );
      expect(response.status, pathname).toBe(404);
    }
  });

  it("does no asset I/O until a request is handled", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "ghc-gateway-admin-static-lazy-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "created-after-factory");
    const staticModule = createAdminStaticModule(root);

    await mkdir(root);
    await writeFile(path.join(root, "index.html"), "lazy index");

    const response = await staticModule.handle(
      new Request("http://127.0.0.1:31400/admin"),
      new AbortController().signal,
    );
    expect(await response.text()).toBe("lazy index");
  });

  it("propagates cancellation instead of converting it to a 404", async () => {
    const staticModule = createAdminStaticModule(await assetRoot());
    const controller = new AbortController();
    const reason = new DOMException("request cancelled", "AbortError");
    const response = staticModule.handle(
      new Request("http://127.0.0.1:31400/admin"),
      controller.signal,
    );
    controller.abort(reason);

    await expect(response).rejects.toBe(reason);
  });
});
