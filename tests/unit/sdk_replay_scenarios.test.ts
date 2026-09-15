import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseReplayManifestText, validateReplayScenarios } from "../support/replay/server.js";
import { createReplayScenarios } from "../sdk/replay_scenarios.js";
import { syntheticSdkFixtureCatalog } from "../sdk/synthetic_scenarios.js";
import { REPLAY_TARGETS } from "../sdk/client.js";
import { matchesSessionRequest } from "../sdk/session_expectations.js";
import {
  expectedForecastArguments, FORECAST_COMPARE_PROMPT, FORECAST_TOOL_OPENAI, IMAGE_ANALYSIS_SYSTEM,
  MIXED_WEATHER_PROMPT, PARALLEL_WEATHER_PROMPT, PARIS_RESULT, SESSION_IMAGE_PROMPT,
  SESSION_SHOT_LIST_PROMPT, SESSION_SYNTHESIS_PROMPT, SESSION_SYSTEM, TOKYO_RESULT,
  WEATHER_PARAMETERS, WEATHER_PROMPT, WEATHER_RESULT,
} from "../sdk/scenarios.js";

async function catalogue(reasoningDownstream?: "chat" | "messages" | "responses", toolDownstream?: "chat" | "messages" | "responses") {
  const manifest = parseReplayManifestText(await readFile(new URL("../sdk/corpus/manifest.json", import.meta.url), "utf8"));
  return { manifest, scenarios: validateReplayScenarios(manifest.exchanges, await createReplayScenarios(manifest, { ...(reasoningDownstream === undefined ? {} : { reasoningDownstream }), ...(toolDownstream === undefined ? {} : { toolDownstream }) })) };
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

  it("matches complete authored synthetic request bodies, not prompt substrings or tool presence", () => {
    const expectations = syntheticSdkFixtureCatalog().filter((entry) => entry.path === "/chat/completions");
    const matches = (body: unknown) => expectations.some((entry) => typeof entry.body === "function" && entry.body(Buffer.from(JSON.stringify(body))));
    const valid = { model: "chat-sdk", messages: [{ role: "user", content: "sdk-chat-nonstream" }] };
    expect(matches(valid)).toBe(true);
    expect(matches({ ...valid, unexpected: true })).toBe(false);
    expect(matches({ ...valid, tools: [] })).toBe(false);
    expect(matches({ ...valid, model: "unowned" })).toBe(false);
    expect(matches({ ...valid, messages: [{ role: "assistant", content: "sdk-chat-nonstream" }] })).toBe(false);
    expect(matches({ ...valid, messages: [{ role: "user", content: "prefix sdk-chat-nonstream suffix" }] })).toBe(false);
  });

  it("initializes replay target model IDs independently of harness imports", () => {
    expect(REPLAY_TARGETS).toEqual([
      { protocol: "chat", model: "gemini-3.5-flash" },
      { protocol: "responses", model: "gpt-5.5" },
      { protocol: "messages", model: "claude-sonnet-4" },
    ]);
  });

  it.each(["chat", "messages", "responses"] as const)("pins native reasoning and only the approved converted absence for %s", async (downstream) => {
    const { scenarios } = await catalogue(downstream);
    for (const protocol of ["chat", "messages", "responses"] as const) {
      const matches = predicate(scenarios, `replay.${protocol}.reasoning-effort.nonstream`);
      const base = protocol === "responses"
        ? { input: "Explain quantum entanglement in 20 words." }
        : { messages: [{ role: "user", content: "Explain quantum entanglement in 20 words." }] };
      const reasoning = protocol === "chat" ? { reasoning_effort: "low" }
        : protocol === "responses" ? { reasoning: { effort: "low" } } : { output_config: { effort: "low" } };
      expect(matches({ ...base, ...reasoning })).toBe(protocol === downstream);
      expect(matches(base)).toBe(protocol !== downstream);
      expect(matches(JSON.parse(JSON.stringify({ ...base, ...reasoning }).replace("\"low\"", "\"high\"")))).toBe(false);
      expect(matches({ ...base, thinking: { type: "enabled", budget_tokens: 8000 } })).toBe(false);
      expect(matches({ ...base, tools: [] })).toBe(false);
      expect(matches(protocol === "responses" ? { input: "wrong" } : { messages: [{ role: "user", content: "wrong" }] })).toBe(false);
    }
  });

  it.each(["chat", "messages"] as const)("matches exact normalized %s weather history, not arbitrary minimal transcripts", async (protocol) => {
    const { manifest, scenarios } = await catalogue();
    const file = manifest.exchanges.find((entry) => entry.caseId === `replay.${protocol}.tool-call.nonstream`)!.response.bodyFile;
    const response = JSON.parse(await readFile(new URL(`../sdk/corpus/${file}`, import.meta.url), "utf8"));
    const id: string = protocol === "chat" ? response.choices[0].message.tool_calls[0].id
      : response.content.find((item: { type: string }) => item.type === "tool_use").id;
    const call = protocol === "chat"
      ? { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" } }] }
      : { role: "assistant", content: [{ type: "tool_use", id, name: "get_weather", input: { city: "Tokyo" } }] };
    const result = protocol === "chat" ? { role: "tool", tool_call_id: id, content: WEATHER_RESULT }
      : { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: WEATHER_RESULT }] }] };
    const user = { role: "user", content: protocol === "chat" ? WEATHER_PROMPT : [{ type: "text", text: WEATHER_PROMPT }] };
    const matches = predicate(scenarios, `replay.${protocol}.weather-roundtrip`, 2);
    const valid = { messages: [user, call, result] };
    expect(matches(valid)).toBe(true);
    expect(matches({ messages: [call, result] })).toBe(false);
    if (protocol === "messages") expect(matches({ messages: [
      { role: "user", content: [{ type: "text", text: "Use the tool result for the original task." }] }, call, result,
    ] })).toBe(true);
    expect(matches({ messages: [result, call] })).toBe(false);
    expect(matches({ messages: [user, user, call, result] })).toBe(false);
    expect(matches({ messages: [user, result] })).toBe(false);
    expect(matches({ ...valid, previous_response_id: "resp_unowned" })).toBe(false);
    expect(matches(JSON.parse(JSON.stringify(valid).replaceAll(id, "wrong_id")))).toBe(false);
    expect(matches(JSON.parse(JSON.stringify(valid).replace("get_weather", "wrong_function")))).toBe(false);
    expect(matches(JSON.parse(JSON.stringify(valid).replace("Tokyo", "Paris")))).toBe(false);
    if (protocol === "messages") {
      const mutated = structuredClone(valid) as { messages: { content: unknown }[] };
      mutated.messages[0]!.content = [{ type: "text", text: WEATHER_PROMPT }, { type: "text", text: "extra" }];
      expect(matches(mutated)).toBe(false);
      mutated.messages[0]!.content = [{ type: "image", source: { type: "url", url: "https://example.invalid/image" } }];
      expect(matches(mutated)).toBe(false);
      expect(matches({ messages: [user, call, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: WEATHER_RESULT }, { type: "text", text: "extra" }] }] }] })).toBe(false);
    }
  });

  it.each(["chat", "messages", "responses"] as const)("pins Chat weather history to the explicitly selected %s downstream", async (downstream) => {
    const { manifest, scenarios } = await catalogue(undefined, downstream);
    const file = manifest.exchanges.find((entry) => entry.caseId === "replay.chat.tool-call.nonstream")!.response.bodyFile;
    const fixed = JSON.parse(await readFile(new URL(`../sdk/corpus/${file}`, import.meta.url), "utf8"));
    const id: string = fixed.choices[0].message.tool_calls[0].id;
    const user = { role: "user", content: WEATHER_PROMPT };
    const call = { role: "assistant", content: null, tool_calls: [
      { id, type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" } },
    ] };
    const result = { role: "tool", tool_call_id: id, content: WEATHER_RESULT };
    const matches = predicate(scenarios, "replay.chat.weather-roundtrip", 2);
    const minimal = { messages: [call, result] };
    expect(matches(minimal)).toBe(downstream === "responses");
    expect(matches({ messages: [user, call, result] })).toBe(downstream !== "responses");
    for (const messages of [[result, call], [user, user, call, result], [call, result, result], [call], [result],
      [call, { ...result, tool_call_id: "unowned" }],
      [call, { ...result, content: "incorrect result" }],
      [{ ...call, tool_calls: [...call.tool_calls, ...call.tool_calls] }, result],
    ]) expect(matches({ messages })).toBe(false);
    expect(matches({ ...minimal, previous_response_id: "resp_unowned" })).toBe(false);
    expect(matches(JSON.parse(JSON.stringify(minimal).replaceAll(id, "unowned")))).toBe(false);
    expect(matches(JSON.parse(JSON.stringify(minimal).replace("get_weather", "wrong_function")))).toBe(false);
    expect(matches(JSON.parse(JSON.stringify(minimal).replace("Tokyo", "Paris")))).toBe(false);
  });

  it("rejects mutated assistant history using independently authored semantic hashes", () => {
    const imageBase64 = "authored-image";
    const firstAssistant = "Independently authored image analysis.";
    const thirdAssistant = "Independently authored city recommendation.";
    const calls = (["Tokyo", "Paris"] as const).map((city, index) => ({
      id: index === 0 ? "call_tokyo" : "call_paris",
      name: "get_hourly_forecast",
      arguments: expectedForecastArguments(city),
    }));
    const messages = [
      { role: "system", content: SESSION_SYSTEM },
      { role: "user", content: [
        { type: "text", text: SESSION_IMAGE_PROMPT },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "auto" } },
      ] },
      { role: "assistant", content: firstAssistant },
      { role: "user", content: FORECAST_COMPARE_PROMPT },
      { role: "assistant", content: null, tool_calls: calls.map((call) => ({
        id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) },
      { role: "tool", tool_call_id: calls[0]!.id, content: TOKYO_RESULT },
      { role: "tool", tool_call_id: calls[1]!.id, content: PARIS_RESULT },
      { role: "user", content: SESSION_SYNTHESIS_PROMPT },
      { role: "assistant", content: thirdAssistant },
      { role: "user", content: SESSION_SHOT_LIST_PROMPT },
    ];
    const expectation = {
      protocol: "chat" as const,
      turn: 4 as const,
      imageBase64,
      assistantTextSha256: [
        createHash("sha256").update(firstAssistant).digest("hex"),
        undefined,
        createHash("sha256").update(thirdAssistant).digest("hex"),
      ],
      calls,
    };

    expect(matchesSessionRequest({ messages, tools: [FORECAST_TOOL_OPENAI] }, expectation)).toBe(true);
    const mutated = structuredClone(messages);
    (mutated[8] as { content: string }).content = `${thirdAssistant} changed`;
    expect(matchesSessionRequest({ messages: mutated, tools: [FORECAST_TOOL_OPENAI] }, expectation)).toBe(false);
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
