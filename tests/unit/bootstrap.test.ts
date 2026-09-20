import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupConfig } from "../../src/config/startup_config.js";
import type { GatewayConfig, HostedGateway } from "../../src/gateway/create_gateway.js";
import { bootstrapGateway, type BootstrapOptions } from "../../src/main.js";

const capture = vi.hoisted(() => ({ startup: undefined as StartupConfig | undefined }));

vi.mock("../../src/gateway/create_gateway.js", () => ({
  createGateway: (config: Readonly<GatewayConfig>): Promise<HostedGateway> => {
    capture.startup = config.startup;
    return Promise.resolve({
      fetch: () => Promise.resolve(new Response()),
      listen: () => Promise.resolve({ host: "127.0.0.1", port: config.startup.port }),
      close: () => Promise.resolve(),
    });
  },
}));

describe("public gateway bootstrap", () => {
  beforeEach(() => {
    capture.startup = undefined;
  });

  it("accepts legacy startup input and conservatively marks its data directory custom", async () => {
    const homedir = "Q:/tmp/home";
    const legacyStartup: NonNullable<BootstrapOptions["startup"]> = {
      host: "127.0.0.1",
      port: 31_400,
      dataDir: path.join(homedir, ".ghc-gateway"),
      logLevel: "info",
    };

    await bootstrapGateway({ startup: legacyStartup, homedir, routes: [] });

    expect(capture.startup).toEqual({ ...legacyStartup, dataDirSource: "custom" });
  });

  it("preserves an explicitly specified data directory source", async () => {
    const startup: StartupConfig = {
      host: "127.0.0.1",
      port: 31_400,
      dataDir: "Q:/tmp/home/.ghc-gateway",
      dataDirSource: "default",
      logLevel: "info",
    };

    await bootstrapGateway({ startup, routes: [] });

    expect(capture.startup).toEqual(startup);
  });
});
