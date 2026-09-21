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
  it("serves the Admin index only for exact GET root", async () => {
    const root = await assetRoot();
    const staticModule = createAdminStaticModule(root);

    const response = await staticModule.handle(
      new Request("http://127.0.0.1:31400/?view=accounts"),
      new AbortController().signal,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("<!doctype html><title>Admin</title>");
  });

  it("serves exact assets with MIME types and immutable caching only for hashed assets", async () => {
    const root = await assetRoot();
    await writeFile(path.join(root, "assets", "app-D4f19aBc.js"), "export const ready = true;");
    await writeFile(path.join(root, "assets", "theme.css"), "body { color: black; }");
    await writeFile(path.join(root, "icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    const staticModule = createAdminStaticModule(root);

    const script = await staticModule.handle(
      new Request("http://127.0.0.1:31400/assets/app-D4f19aBc.js"),
      new AbortController().signal,
    );
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe("export const ready = true;");
    for (const alias of ["/assets/app-D4f19aBc.js/", "/assets//app-D4f19aBc.js"]) {
      expect((await staticModule.handle(
        new Request(`http://127.0.0.1:31400${alias}`),
        new AbortController().signal,
      )).status, alias).toBe(404);
    }

    const style = await staticModule.handle(
      new Request("http://127.0.0.1:31400/assets/theme.css"),
      new AbortController().signal,
    );
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(style.headers.has("cache-control")).toBe(false);

  });

  it("returns 404 for missing assets without serving the index", async () => {
    const staticModule = createAdminStaticModule(await assetRoot());

    for (const pathname of [
      "/assets",
      "/assets/",
      "/assets/missing.js",
    ]) {
      const response = await staticModule.handle(
        new Request(`http://127.0.0.1:31400${pathname}`),
        new AbortController().signal,
      );
      expect(response.status, pathname).toBe(404);
      expect(response.headers.get("content-type"), pathname).not.toBe("text/html; charset=utf-8");
    }
  });

  it("does not serve old Admin paths, unknown roots, reserved routes, or non-GET requests", async () => {
    const staticModule = createAdminStaticModule(await assetRoot());
    const requests = [
      new Request("http://127.0.0.1:31400/admin"),
      new Request("http://127.0.0.1:31400/admin/"),
      new Request("http://127.0.0.1:31400/admin/accounts"),
      new Request("http://127.0.0.1:31400/admin/api/v1"),
      new Request("http://127.0.0.1:31400/admin/api/v1/status"),
      new Request("http://127.0.0.1:31400/__ghcg/control/v1/status"),
      new Request("http://127.0.0.1:31400/v1/models"),
      new Request("http://127.0.0.1:31400/v1/chat/completions"),
      new Request("http://127.0.0.1:31400/healthz"),
      new Request("http://127.0.0.1:31400/readyz"),
      new Request("http://127.0.0.1:31400/unknown"),
      new Request("http://127.0.0.1:31400/", { method: "HEAD" }),
      new Request("http://127.0.0.1:31400/", { method: "POST" }),
      new Request("http://127.0.0.1:31400/assets/app.js", { method: "POST" }),
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
    await symlink(outside, path.join(root, "assets", "escape"), process.platform === "win32" ? "junction" : "dir");
    const staticModule = createAdminStaticModule(root);
    const paths = [
      "/assets/..%2foutside.txt",
      "/assets/%2fetc/passwd",
      "/assets%5capp.js",
      "/assets/%00app.js",
      "/assets/%252fapp.js",
      "/assets/%",
      "/assets/%2e%2e/outside.txt",
      "/assets/escape/secret.txt",
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
      new Request("http://127.0.0.1:31400/"),
      new AbortController().signal,
    );
    expect(await response.text()).toBe("lazy index");
  });

  it("propagates cancellation instead of converting it to a 404", async () => {
    const staticModule = createAdminStaticModule(await assetRoot());
    const controller = new AbortController();
    const reason = new DOMException("request cancelled", "AbortError");
    const response = staticModule.handle(
      new Request("http://127.0.0.1:31400/"),
      controller.signal,
    );
    controller.abort(reason);

    await expect(response).rejects.toBe(reason);
  });
});
