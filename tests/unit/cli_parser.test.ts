import path from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/cli/control_client.js";
import { parseCli, ROOT_HELP } from "../../src/cli/parser.js";

const home = path.resolve("Q:/tmp/ghcg-home");

describe("CLI parser", () => {
  it("renders the canonical root help snapshot", () => {
    expect(parseCli(["--help"], { homedir: home }).command).toEqual({
      kind: "help",
      text: ROOT_HELP,
    });
    expect(ROOT_HELP).toBe([
      "Usage: ghcg [--data-dir <path>] [--json] <command>",
      "",
      "Commands:",
      "  serve",
      "  start",
      "  stop",
      "  restart",
      "  status",
      "  auth login [--host <domain>]",
      "  auth login poll <flow-id>",
      "  auth logout [--account <account-id>]",
      "  auth status",
      "  accounts list",
      "  accounts use <account-id>",
      "  accounts remove <account-id>",
      "  models list [--account <account-id>]",
      "  models current",
      "  models set <model-id>",
      "  config get [key]",
      "  config set <key> <value>",
      "",
    ].join("\n"));
  });

  it("uses data-dir precedence without scanning other directories", () => {
    expect(parseCli(["status"], {
      env: { GHC_GATEWAY_DATA_DIR: "env-dir" },
      homedir: home,
    }).dataDir).toBe(path.resolve("env-dir"));
    expect(parseCli(["--data-dir", "cli-dir", "status"], {
      env: { GHC_GATEWAY_DATA_DIR: "env-dir" },
      homedir: home,
    }).dataDir).toBe(path.resolve("cli-dir"));
    expect(parseCli(["status"], { homedir: home }).dataDir).toBe(path.join(home, ".ghc-gateway"));
    expect(() => parseCli(["--data-dir", "", "status"], { homedir: home })).toThrow(CliError);
    expect(() => parseCli(["status"], { env: { GHC_GATEWAY_DATA_DIR: "" }, homedir: home })).toThrow(CliError);
  });

  it("parses serve and start startup-only flags", () => {
    const serve = parseCli(["--json", "serve", "--port", "31401", "--log-level", "debug"], { homedir: home });
    expect(serve.json).toBe(true);
    expect(serve.command).toMatchObject({ kind: "serve" });
    if (serve.command.kind !== "serve") {
      throw new Error("expected serve");
    }
    expect(serve.command.startup.port).toBe(31_401);
    expect(serve.command.startup.logLevel).toBe("debug");
    expect(serve.command.startup.dataDirSource).toBe("default");

    const start = parseCli(["start", "--data-dir", "daemon-dir", "--port", "31402"], { homedir: home });
    expect(start.command).toMatchObject({ kind: "lifecycle", action: "start" });
    if (start.command.kind !== "lifecycle" || start.command.startup === undefined) {
      throw new Error("expected start lifecycle");
    }
    expect(start.command.startup.dataDir).toBe(path.resolve("daemon-dir"));
    expect(start.command.startup.dataDirSource).toBe("custom");
    expect(start.command.startup.port).toBe(31_402);
  });

  it("preserves startup data-directory provenance for serve, start, and restart", () => {
    const defaultDataDir = path.join(home, ".ghc-gateway");
    for (const command of ["serve", "start", "restart"] as const) {
      const parsedDefault = parseCli([command], { homedir: home }).command;
      if ((parsedDefault.kind !== "serve" && parsedDefault.kind !== "lifecycle") || parsedDefault.startup === undefined) {
        throw new Error(`expected ${command} startup`);
      }
      expect(parsedDefault.startup).toMatchObject({ dataDir: defaultDataDir, dataDirSource: "default" });

      const parsedExplicit = parseCli(["--data-dir", defaultDataDir, command], { homedir: home }).command;
      if ((parsedExplicit.kind !== "serve" && parsedExplicit.kind !== "lifecycle") || parsedExplicit.startup === undefined) {
        throw new Error(`expected explicit ${command} startup`);
      }
      expect(parsedExplicit.startup).toMatchObject({ dataDir: defaultDataDir, dataDirSource: "custom" });

      const parsedEnvironment = parseCli([command], {
        env: { GHC_GATEWAY_DATA_DIR: defaultDataDir },
        homedir: home,
      }).command;
      if ((parsedEnvironment.kind !== "serve" && parsedEnvironment.kind !== "lifecycle") || parsedEnvironment.startup === undefined) {
        throw new Error(`expected environment ${command} startup`);
      }
      expect(parsedEnvironment.startup).toMatchObject({ dataDir: defaultDataDir, dataDirSource: "custom" });
    }
  });

  it("renders command help without starting foreground serve", () => {
    expect(parseCli(["serve", "--help"], { homedir: home }).command).toEqual({
      kind: "help",
      text: "Usage: ghcg [--data-dir <path>] [--json] serve\n\n  --diagnostics  Write bounded, content-free request diagnostics for this invocation.\n",
    });
    expect(parseCli(["start", "--help"], { homedir: home }).command).toEqual({
      kind: "help",
      text: "Usage: ghcg [--data-dir <path>] [--json] start\n\n  --diagnostics  Write bounded, content-free request diagnostics for this invocation.\n",
    });

  });

  it("enables diagnostics only for an explicitly requested startup invocation", () => {
    for (const command of ["serve", "start", "restart"]) {
      for (const enabled of [false, true]) {
        const parsed = parseCli([command, ...(enabled ? ["--diagnostics"] : [])], { homedir: home }).command;
        if (parsed.kind !== "serve" && parsed.kind !== "lifecycle") throw new Error("expected startup");
        expect(parsed.startup?.diagnostics === true).toBe(enabled);
      }
    }
    for (const args of [
      ["status", "--diagnostics"], ["stop", "--diagnostics"],
      ["serve", "--diagnostics", "false"], ["restart", "--port", "31401"],
    ]) expect(() => parseCli(args, { homedir: home })).toThrow(CliError);
  });

  it("renders group help from the canonical registry", () => {
    expect(parseCli(["auth", "--help"], { homedir: home }).command).toEqual({
      kind: "help",
      text: [
        "Usage: ghcg [--data-dir <path>] [--json] auth <command>",
        "",
        "Commands:",
        "  auth login [--host <domain>]",
        "  auth login poll <flow-id>",
        "  auth logout [--account <account-id>]",
        "  auth status",
        "",
      ].join("\n"),
    });
    expect(parseCli(["accounts", "--help"], { homedir: home }).command).toMatchObject({ kind: "help" });
    expect(parseCli(["models", "--help"], { homedir: home }).command).toMatchObject({ kind: "help" });
    expect(parseCli(["config", "--help"], { homedir: home }).command).toMatchObject({ kind: "help" });
    expect(parseCli(["auth", "login", "--help"], { homedir: home }).command).toEqual({
      kind: "help",
      text: "Usage: ghcg [--data-dir <path>] [--json] auth login [--host <domain>]\n",
    });
    expect(parseCli(["models", "set", "--help"], { homedir: home }).command).toEqual({
      kind: "help",
      text: "Usage: ghcg [--data-dir <path>] [--json] models set <model-id>\n",
    });
  });

  it("parses every management command to a control operation", () => {
    expect(parseCli(["auth", "login"], { homedir: home }).command).toEqual({ kind: "control", operation: "auth.login.start", args: {} });
    expect(parseCli(["auth", "login", "--host", "ghe.example.com"], { homedir: home }).command).toEqual({ kind: "control", operation: "auth.login.start", args: { host: "ghe.example.com" } });
    expect(parseCli(["auth", "login", "poll", "flow-1"], { homedir: home }).command).toEqual({ kind: "control", operation: "auth.login.poll", args: { flowId: "flow-1" } });
    expect(parseCli(["auth", "logout", "--account", "github.com/1"], { homedir: home }).command).toEqual({ kind: "control", operation: "auth.logout", args: { accountId: "github.com/1" } });
    expect(parseCli(["auth", "status"], { homedir: home }).command).toEqual({ kind: "control", operation: "auth.status", args: {} });
    expect(parseCli(["accounts", "list"], { homedir: home }).command).toEqual({ kind: "control", operation: "accounts.list", args: {} });
    expect(parseCli(["accounts", "use", "github.com/1"], { homedir: home }).command).toEqual({ kind: "control", operation: "accounts.use", args: { accountId: "github.com/1" } });
    expect(parseCli(["accounts", "remove", "github.com/1"], { homedir: home }).command).toEqual({ kind: "control", operation: "accounts.remove", args: { accountId: "github.com/1" } });
    expect(parseCli(["models", "list", "--account", "github.com/1"], { homedir: home }).command).toEqual({ kind: "control", operation: "models.list", args: { accountId: "github.com/1" } });
    expect(parseCli(["models", "current"], { homedir: home }).command).toEqual({ kind: "control", operation: "models.current", args: {} });
    expect(parseCli(["models", "set", "gpt"], { homedir: home }).command).toEqual({ kind: "control", operation: "models.set", args: { modelId: "gpt" } });
    expect(parseCli(["config", "get", "limits.requestBodyBytes"], { homedir: home }).command).toEqual({ kind: "control", operation: "config.get", args: { key: "limits.requestBodyBytes" } });
    expect(parseCli(["config", "set", "limits.requestBodyBytes", "1048576"], { homedir: home }).command).toEqual({ kind: "control", operation: "config.set", args: { key: "limits.requestBodyBytes", value: "1048576" } });
  });

  it("rejects unknown commands, chat aliases, missing args, and misplaced startup flags", () => {
    for (const argv of [
      ["chat"],
      ["help"],
      ["ghcpo"],
      ["models", "set"],
      ["accounts", "use"],
      ["status", "--port", "31400"],
      ["auth", "login", "--host"],
      ["admin"],
      ["admin", "--help"],
      ["admin", "open"],
      ["admin", "open", "--help"],
      ["-h"],
      ["--bogus", "status"],
    ]) {
      expect(() => parseCli(argv, { homedir: home }), argv.join(" ")).toThrow(CliError);
    }
  });
});
