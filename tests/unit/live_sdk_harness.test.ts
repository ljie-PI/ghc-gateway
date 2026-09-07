import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLiveRequestPlan,
  assertSelectedDefaultAccount,
  expectCancelledStream,
  LIVE_ROUTES,
  LiveCallLedger,
  type LiveCliModel,
  type LiveRouteKey,
  type LiveRouteSelection,
  parseManagedConvertedResponseId,
  readLiveConfiguration,
  validateRouteSelections,
} from "../live/sdk/harness.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live SDK acceptance harness", () => {
  it("requires an explicit model, expected unsupported result, or catalog gap for every route", () => {
    const env = unavailableEnvironment();
    env.GHC_GATEWAY_LIVE_C_TO_R_UNAVAILABLE = undefined;
    env.GHC_GATEWAY_LIVE_C_TO_R_MODEL = "responses-only";
    const configuration = readLiveConfiguration(env);
    expect(configuration.accountId).toBe("github.com/1");
    expect(configuration.routes.c_to_r).toEqual({ kind: "model", modelId: "responses-only" });
    expect(configuration.routes.r_to_m).toEqual({
      kind: "unavailable",
      reason: "catalog_not_declared",
    });

    env.GHC_GATEWAY_LIVE_C_TO_R_UNSUPPORTED_MODEL = "responses-only";
    expect(() => readLiveConfiguration(env)).toThrow(/set exactly one/u);
  });

  it("requires live inference to use the selected current default account without switching it", () => {
    const accounts = {
      defaultAccountId: "github.com/1",
      items: [
        { accountId: "github.com/1", state: "active" as const },
        { accountId: "github.com/2", state: "active" as const },
      ],
    };
    expect(() => assertSelectedDefaultAccount("github.com/1", accounts)).not.toThrow();
    expect(() => assertSelectedDefaultAccount("github.com/2", accounts))
      .toThrow(/must equal the current default account/u);
  });

  it("validates route targets from exact native protocol declarations without model-name or mode inference", () => {
    const selections = {
      c_to_c: modelSelection("dual"),
      c_to_m: modelSelection("messages-only"),
      c_to_r: modelSelection("responses-only"),
      m_to_c: modelSelection("dual"),
      m_to_m: modelSelection("messages-only"),
      m_to_r: modelSelection("responses-only"),
      r_to_c: modelSelection("chat-only"),
      r_to_m: modelSelection("messages-only"),
      r_to_r: modelSelection("dual"),
    } satisfies Record<LiveRouteKey, LiveRouteSelection>;
    const models = [
      liveModel("dual", ["chat", "responses"]),
      liveModel("chat-only", ["chat"]),
      liveModel("messages-only", ["messages"]),
      liveModel("responses-only", ["responses"]),
    ];
    expect(() => validateRouteSelections(selections, models)).not.toThrow();

    expect(() => validateRouteSelections({
      ...selections,
      r_to_c: modelSelection("dual"),
    }, models)).toThrow(/would plan responses, not chat/u);

    expect(() => assertLiveRequestPlan("c_to_r", "responses-only", {
      model: "responses-only",
      messages: [{ role: "user", content: "probe" }],
    }, models, "github.com/1")).not.toThrow();
    expect(() => assertLiveRequestPlan("c_to_r", "responses-only", {
      model: "responses-only",
      messages: [{ role: "user", content: "probe" }],
      stop: ["END"],
    }, models, "github.com/1")).toThrow(/would plan no route, not responses/u);
  });

  it("rejects a catalog-unavailable declaration when the current snapshot contains that route", () => {
    const selections = Object.fromEntries(LIVE_ROUTES.map((route) => [
      route.key,
      { kind: "unavailable", reason: "catalog_not_declared" },
    ])) as Record<LiveRouteKey, LiveRouteSelection>;
    expect(() => validateRouteSelections(selections, [
      liveModel("messages-only", ["messages"]),
    ])).toThrow(/conflicts with the current capability catalog/u);
  });

  it("decodes managed converted response IDs with explicit upstream protocol ownership", () => {
    const encoded = Buffer.from([
      "litellm:custom_llm_provider:github_copilot",
      "model_id:messages-only",
      "upstream_protocol:messages",
      "response_id:nonce-1",
    ].join(";"), "utf8").toString("base64");
    expect(parseManagedConvertedResponseId(`resp_${encoded}`)).toEqual({
      modelId: "messages-only",
      upstreamProtocol: "messages",
      responseId: "nonce-1",
    });

    const obsolete = Buffer.from(
      "litellm:custom_llm_provider:github_copilot;model_id:x;response_id:y",
      "utf8",
    ).toString("base64");
    expect(parseManagedConvertedResponseId(`resp_${obsolete}`)).toBeNull();
  });

  it("counts only explicit loopback inference calls and enforces the hard budget", async () => {
    const remote = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", remote);
    const ledger = new LiveCallLedger(1);
    const guarded = ledger.fetch("http://127.0.0.1:31400");

    await guarded("http://127.0.0.1:31400/v1/models");
    await ledger.run("r_to_r", async () => {
      await guarded("http://127.0.0.1:31400/v1/responses", { method: "POST" });
    });
    await expect(ledger.run("r_to_r", async () => {
      await guarded("http://127.0.0.1:31400/v1/responses", { method: "POST" });
    })).rejects.toThrow(/call budget exceeded/u);
    await expect(guarded("https://example.com/v1/models")).rejects.toThrow(/outside/u);
    expect(ledger.snapshot()).toMatchObject({
      inferenceCalls: 2,
      catalogCalls: 1,
      byRoute: { r_to_r: 2 },
      maxInferenceCalls: 1,
    });
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it("waits past an in-flight value until an aborted stream reaches a terminal state", async () => {
    let nextCount = 0;
    let returned = false;
    let aborted = false;
    const stream: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCount += 1;
            return nextCount === 1
              ? { done: false as const, value: 1 }
              : { done: true as const, value: undefined };
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    await expectCancelledStream(stream, () => {
      aborted = true;
    });
    expect(aborted).toBe(true);
    expect(nextCount).toBe(2);
    expect(returned).toBe(true);
  });
});

function unavailableEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GHC_GATEWAY_LIVE_TESTS: "1",
    GHC_GATEWAY_LIVE_ACCOUNT_ID: "github.com/1",
  };
  for (const route of LIVE_ROUTES) {
    env[`${route.envPrefix}_UNAVAILABLE`] = "catalog_not_declared";
  }
  return env;
}

function modelSelection(modelId: string): LiveRouteSelection {
  return { kind: "model", modelId };
}

function liveModel(
  id: string,
  protocols: readonly ("chat" | "messages" | "responses")[],
): LiveCliModel {
  return {
    id,
    discovered: true,
    configured: false,
    verified: true,
    enabled: true,
    visible: true,
    protocols,
    protocolsSource: "live",
    protocolsConflict: false,
    protocolsLiveState: "value",
    chatOutputTokenField: protocols.includes("chat") ? "max_completion_tokens" : null,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
  };
}
