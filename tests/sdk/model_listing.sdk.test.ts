import { CHAT_MODEL } from "./synthetic_scenarios.js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SyntheticSdkHarness, startSyntheticSdkHarness } from "./replay_harness.js";

describe("official SDK model listing", () => {
  let harness: SyntheticSdkHarness;

  beforeAll(async () => {
    harness = await startSyntheticSdkHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes the shared catalog with OpenAI and Anthropic clients", async () => {
    const openai = new OpenAI({ apiKey: "local", baseURL: harness.openAiBaseUrl, fetch: harness.fetch, maxRetries: 0 });
    const anthropic = new Anthropic({ apiKey: "local", baseURL: harness.baseUrl, fetch: harness.fetch, maxRetries: 0 });

    const [openAiModels, anthropicModels] = await Promise.all([
      openai.models.list(),
      anthropic.models.list(),
    ]);

    expect(openAiModels.data.map((model) => model.id)).toContain(CHAT_MODEL);
    expect(anthropicModels.data.map((model) => model.id)).toContain(CHAT_MODEL);
    expect(harness.upstream.requests.map(({ method, path }) => ({ method, path }))).toEqual([{ method: "GET", path: "/models" }]);
    expect(harness.transport.inspect()).toMatchObject({ closed: false, responseLeases: 0, pools: { active: 0, waiters: 0 } });
  });
});
