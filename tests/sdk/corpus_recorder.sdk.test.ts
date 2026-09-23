import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoundCopilot } from "../../src/copilot/backend.js";
import type { UpstreamByteResponse, UpstreamByteStream } from "../../src/copilot/upstream_types.js";
import { parseReplayManifestText, readReplayResponse } from "../support/replay/corpus.js";
import type { ReplayScenario, ReplayScenarioManifest } from "../support/replay/types.js";
import { DEFAULT_CORPUS_DIRECTORY, recordReplayCorpus } from "./corpus_recorder.js";
import { assertOfflineSdkTestsEnabled } from "./replay_harness.js";
import { createReplayScenarios } from "./replay_scenarios.js";
import { SESSION_ASSISTANT_TEXT_SHA256 } from "./scenarios.js";

/**
 * Serve the committed corpus as the "live" upstream, selecting each step only through the
 * independently authored replay predicates. Re-recording must then reproduce every body exactly,
 * proving recorder requests and replay matchers describe the same native gateway traffic.
 */
function corpusUpstream(manifest: ReplayScenarioManifest, scenarios: readonly ReplayScenario[], served: string[]): BoundCopilot {
  const progress = new Map(scenarios.map((scenario) => [scenario.scenarioId, 0]));
  const exchanges = new Map(manifest.exchanges.map((exchange) => [exchange.caseId, exchange]));
  const select = async (route: string, body: Uint8Array, stream: boolean) => {
    const request = JSON.parse(Buffer.from(body).toString("utf8")) as { model?: unknown };
    const candidates = scenarios.flatMap((scenario) => {
      const step = scenario.steps[progress.get(scenario.scenarioId)!];
      const exchange = step === undefined ? undefined : exchanges.get(step.caseId);
      return exchange !== undefined && exchange.request.path === route && exchange.response.stream === stream
        && exchange.upstreamModel === request.model && step!.matchesRequest(request) ? [{ scenario, exchange }] : [];
    });
    if (candidates.length !== 1) throw new Error("ambiguous or unmatched recording request");
    const [{ scenario, exchange }] = candidates as [typeof candidates[number]];
    progress.set(scenario.scenarioId, progress.get(scenario.scenarioId)! + 1);
    served.push(exchange.caseId);
    const bytes = await readReplayResponse(DEFAULT_CORPUS_DIRECTORY, exchange);
    return { headers: new Headers(exchange.response.headers), bytes };
  };
  const buffered = async (route: string, request: { body: Uint8Array }): Promise<UpstreamByteResponse> => {
    const { headers, bytes } = await select(route, request.body, false);
    return { status: 200, headers, body: bytes };
  };
  const streamed = async (route: string, request: { body: Uint8Array }): Promise<UpstreamByteStream> => {
    const { headers, bytes } = await select(route, request.body, true);
    return {
      status: 200, headers,
      bytes: (async function* () { for (let offset = 0; offset < bytes.length; offset += 97) yield bytes.subarray(offset, offset + 97); })(),
      cancel: async () => undefined,
    } as UpstreamByteStream;
  };
  return {
    accountId: "corpus", target: { endpoint: "http://127.0.0.1:9", token: "corpus" },
    completeChat: (request) => buffered("/chat/completions", request),
    openChatStream: (request) => streamed("/chat/completions", request),
    completeResponses: (request) => buffered("/responses", request),
    openResponsesStream: (request) => streamed("/responses", request),
    completeMessages: (request) => buffered("/v1/messages", request),
    openMessagesStream: (request) => streamed("/v1/messages", request),
  } as BoundCopilot;
}

describe("corpus recorder through the production gateway and official SDKs", () => {
  let directory: string;
  let manifest: ReplayScenarioManifest;

  beforeAll(async () => {
    assertOfflineSdkTestsEnabled();
    directory = await mkdtemp(path.join(tmpdir(), "ghcg-corpus-recording-"));
    await cp(DEFAULT_CORPUS_DIRECTORY, directory, { recursive: true });
    manifest = parseReplayManifestText(await readFile(path.join(DEFAULT_CORPUS_DIRECTORY, "manifest.json"), "utf8"));
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("plans every corpus case without binding an account", async () => {
    const plan = await recordReplayCorpus({}, { bind: async () => { throw new Error("must not bind"); } });
    expect(plan).toMatchObject({ executed: false, requests: manifest.exchanges.length });
  });

  it("re-records the whole corpus byte-for-byte and reports the pinned session digests", async () => {
    const served: string[] = [];
    const scenarios = await createReplayScenarios(manifest);
    const result = await recordReplayCorpus({ execute: true }, {
      bind: async () => corpusUpstream(manifest, scenarios, served),
      corpusDirectory: directory,
      now: () => new Date(1_700_000_000_000),
    });
    if (!result.executed) throw new Error("expected execution");
    expect(new Set(served)).toEqual(new Set(manifest.exchanges.map((exchange) => exchange.caseId)));
    expect(served).toHaveLength(manifest.exchanges.length);
    const published = new Map(result.exchanges.map((exchange) => [exchange.caseId, exchange]));
    for (const exchange of manifest.exchanges) {
      expect(published.get(exchange.caseId)).toEqual(expect.objectContaining({
        bodyFile: exchange.response.bodyFile, sha256: exchange.response.bodySha256,
      }));
    }
    const rewritten = parseReplayManifestText(await readFile(path.join(directory, "manifest.json"), "utf8"));
    expect(rewritten.exchanges.map((exchange) => [exchange.caseId, exchange.response]))
      .toEqual(manifest.exchanges.map((exchange) => [exchange.caseId, exchange.response]));
    expect(rewritten.responseSets).toEqual(manifest.responseSets);
    for (const protocol of ["chat", "responses", "messages"] as const) {
      expect(result.sessionAssistantTextSha256[protocol]).toEqual(SESSION_ASSISTANT_TEXT_SHA256[protocol].map((digest) => digest ?? null));
    }
  });
});
