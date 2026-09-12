import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseReplayManifestText, validateReplayScenarios } from "../../src/replay/server.js";
import { createReplayScenarios } from "../sdk/replay_scenarios.js";
import {
  IMAGE_ANALYSIS_SYSTEM, MIXED_WEATHER_PROMPT, PARALLEL_WEATHER_PROMPT, SESSION_IMAGE_PROMPT,
  WEATHER_PARAMETERS, WEATHER_PROMPT, WEATHER_RESULT,
} from "../sdk/scenarios.js";

async function catalogue() {
  const manifest = parseReplayManifestText(await readFile(new URL("../sdk/corpus/manifest.json", import.meta.url), "utf8"));
  return { manifest, scenarios: validateReplayScenarios(manifest.exchanges, await createReplayScenarios(manifest)) };
}

function predicate(scenarios: Awaited<ReturnType<typeof catalogue>>["scenarios"], id: string, step = 1) {
  const found = scenarios.find((scenario) => scenario.scenarioId === id)?.steps[step - 1]?.matchesRequest;
  if (found === undefined) throw new Error("missing scenario predicate");
  return found;
}

describe("structured SDK replay catalogue", () => {
  it("owns every case exactly once with contiguous bounded steps", async () => {
    const { manifest, scenarios } = await catalogue();
    const caseIds = scenarios.flatMap((scenario) => scenario.steps.map((step) => step.caseId));
    expect(scenarios).toHaveLength(30);
    expect(caseIds).toHaveLength(45);
    expect(new Set(caseIds)).toEqual(new Set(manifest.exchanges.map((exchange) => exchange.caseId)));
    for (const scenario of scenarios) {
      expect(scenario.steps.map((step) => step.ordinal)).toEqual(scenario.steps.map((_, index) => index + 1));
      expect(scenario.steps.length).toBeLessThanOrEqual(64);
    }
  });

  it("rejects deceptive magic substrings and structural image mutations", async () => {
    const { scenarios } = await catalogue();
    const text = predicate(scenarios, "replay.chat.plain-text.nonstream");
    for (const deceptive of ["image", "Paris", "twice", "simultaneously", "quantum", "tool_result", "function_call_output", "{\"role\":\"tool\"}"]) {
      expect(text({ model: "gemini-3.5-flash", messages: [{ role: "user", content: deceptive }] })).toBe(false);
    }
    const imageBase64 = (await readFile(new URL("../sdk/images/vergil.jpg", import.meta.url))).toString("base64");
    const image = predicate(scenarios, "replay.chat.image.nonstream");
    const valid = { model: "gemini-3.5-flash", messages: [
      { role: "system", content: IMAGE_ANALYSIS_SYSTEM },
      { role: "user", content: [
        { type: "text", text: SESSION_IMAGE_PROMPT },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "auto" } },
      ] },
    ] };
    expect(image(valid)).toBe(true);
    expect(image({ ...valid, messages: [...valid.messages].reverse() })).toBe(false);
    expect(image(JSON.parse(JSON.stringify(valid).replace("image/jpeg", "image/png")))).toBe(false);
    expect(image(JSON.parse(JSON.stringify(valid).replace(imageBase64.slice(0, 20), "d3Jvbmc=")))).toBe(false);
  });

  it("pins tool prompt, image, name and schema while bounding inspected collections", async () => {
    const { scenarios } = await catalogue();
    const parallel = predicate(scenarios, "replay.chat.parallel-tools.nonstream");
    const validParallel = { model: "gemini-3.5-flash", messages: [{ role: "user", content: PARALLEL_WEATHER_PROMPT }], tools: [{
      type: "function", function: { name: "get_weather", parameters: { ...WEATHER_PARAMETERS, additionalProperties: false } },
    }] };
    expect(parallel(validParallel)).toBe(true);
    expect(parallel({ ...validParallel, messages: [{ role: "user", content: `${PARALLEL_WEATHER_PROMPT} quantum` }] })).toBe(false);
    expect(parallel(JSON.parse(JSON.stringify(validParallel).replace("get_weather", "wrong_tool")))).toBe(false);
    expect(parallel(JSON.parse(JSON.stringify(validParallel).replace("\"city\":{\"type\":\"string\"}", "\"city\":{\"type\":\"integer\"}")))).toBe(false);
    expect(parallel({ ...validParallel, messages: new Array(65).fill(validParallel.messages[0]) })).toBe(false);

    const imageBase64 = (await readFile(new URL("../sdk/images/vergil.jpg", import.meta.url))).toString("base64");
    const mixed = predicate(scenarios, "replay.messages.mixed-image-tool.nonstream");
    expect(mixed({ model: "claude-sonnet-4", messages: [{ role: "user", content: [
      { type: "text", text: MIXED_WEATHER_PROMPT },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
    ] }], tools: [{ name: "get_weather", input_schema: { ...WEATHER_PARAMETERS, additionalProperties: false } }] })).toBe(true);
  });

  it("requires exact owned Responses continuation and call/result binding", async () => {
    const { manifest, scenarios } = await catalogue();
    const responseFile = manifest.exchanges.find((item) => item.caseId === "replay.responses.tool-call.nonstream")!.response.bodyFile;
    const fixed = JSON.parse(await readFile(new URL(`../sdk/corpus/${responseFile}`, import.meta.url), "utf8"));
    const call = fixed.output.find((item: { type: string }) => item.type === "function_call");
    const second = predicate(scenarios, "replay.responses.weather-roundtrip", 2);
    const valid = { model: "gpt-5.5", previous_response_id: fixed.id, input: [
      { type: "function_call_output", call_id: call.call_id, output: WEATHER_RESULT },
    ] };
    expect(second(valid)).toBe(true);
    expect(second({ ...valid, previous_response_id: "resp_unowned" })).toBe(false);
    expect(second({ ...valid, input: [{ ...valid.input[0], call_id: "call_wrong" }] })).toBe(false);
    expect(second({ ...valid, input: [
      { type: "function_call", call_id: call.call_id, name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
      ...valid.input,
    ] })).toBe(false);
  });

  it("requires ordered weather call/result identity, complete arguments and exact JSON result", async () => {
    const { manifest, scenarios } = await catalogue();
    const callResponse = JSON.parse(await readFile(new URL(`../sdk/corpus/${manifest.exchanges.find((item) => item.caseId === "replay.messages.tool-call.nonstream")!.response.bodyFile}`, import.meta.url), "utf8"));
    const call = callResponse.content.find((item: { type: string }) => item.type === "tool_use");
    const first = predicate(scenarios, "replay.messages.weather-roundtrip", 1);
    const second = predicate(scenarios, "replay.messages.weather-roundtrip", 2);
    const firstBody = { model: "claude-sonnet-4", messages: [{ role: "user", content: WEATHER_PROMPT }], tools: [{
      name: "get_weather", input_schema: WEATHER_PARAMETERS,
    }] };
    expect(first(firstBody)).toBe(true);
    const valid = { model: "claude-sonnet-4", messages: [
      { role: "user", content: WEATHER_PROMPT },
      { role: "assistant", content: [{ type: "tool_use", id: call.id, name: "get_weather", input: { city: "Tokyo" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: WEATHER_RESULT }] },
    ] };
    expect(second(valid)).toBe(true);
    expect(second({ ...valid, messages: [...valid.messages].reverse() })).toBe(false);
    expect(second(JSON.parse(JSON.stringify(valid).replaceAll(call.id, "call_wrong")))).toBe(false);
    expect(second(JSON.parse(JSON.stringify(valid).replace(WEATHER_RESULT.replaceAll("\"", "\\\""), "not-json")))).toBe(false);
    expect(second(JSON.parse(JSON.stringify(valid).replace("\"city\":\"Tokyo\"", "\"city\":\"Paris\"")))).toBe(false);
  });
});
