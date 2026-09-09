// Pure scenario inputs shared by explicit recording and offline SDK replay.
export const LONG_TEXT_PROMPT = [
  "Explain why a production HTTP gateway should enforce separate connection, first-byte, idle-stream, and total-request timeouts.",
  "Write 220-280 words with the headings Purpose, Failure modes, and Operational guidance.",
  "Explain cancellation propagation, connection-pool cleanup, partial streaming responses, and why one timeout cannot safely replace the others.",
  "Use complete paragraphs and finish with a one-sentence operational rule.",
].join(" ");

export const IMAGE_ANALYSIS_SYSTEM = [
  "You are a production visual analyst.",
  "Describe only what is visible in the reference image and keep the analysis concrete.",
].join(" ");

export const SESSION_SYSTEM = [
  "You are a production assistant helping plan one coherent outdoor cosplay photo shoot.",
  "Keep image-derived observations separate from facts returned by tools.",
  "Never invent weather values. Reuse exact tool values in later turns.",
  "When asked for analysis, write concrete production guidance rather than generic praise.",
].join(" ");
export const SESSION_MARKER = "one coherent outdoor cosplay photo shoot";
export const SESSION_IMAGE_PROMPT = [
  "We are planning a Vergil-inspired outdoor photo shoot using this reference image.",
  "Analyze the visible production cues: likely character, dominant color palette, coat silhouette, prop, and mood.",
  "Explain how those cues should influence location and lighting choices, then ask which cities and date to compare.",
  "Write 140-190 words. Do not call a tool yet.",
].join(" ");
export const FORECAST_COMPARE_PROMPT = [
  "Compare Tokyo, JP and Paris, FR for 2026-10-18 from 15:00 through 18:00 local time.",
  "Make exactly two parallel get_hourly_forecast calls, one per city.",
  "For both calls use metric units and request temperature_c, precipitation_probability, cloud_cover_percent, and wind_speed_kph.",
  "Do not recommend a city until the tool results arrive.",
].join(" ");
export const FORECAST_FIELDS = ["temperature_c", "precipitation_probability", "cloud_cover_percent", "wind_speed_kph"] as const;
export const FORECAST_PARAMETERS = {
  type: "object",
  properties: {
    location: {
      type: "object",
      properties: { city: { type: "string" }, country_code: { type: "string", minLength: 2, maxLength: 2 } },
      required: ["city", "country_code"] as string[],
      additionalProperties: false,
    },
    date: { type: "string", description: "ISO date, YYYY-MM-DD" },
    start_hour: { type: "integer", minimum: 0, maximum: 23 },
    end_hour: { type: "integer", minimum: 1, maximum: 24 },
    units: { type: "string", enum: ["metric", "imperial"] },
    fields: { type: "array", items: { type: "string", enum: [...FORECAST_FIELDS] }, minItems: 4, maxItems: 4 },
  },
  required: ["location", "date", "start_hour", "end_hour", "units", "fields"] as string[],
  additionalProperties: false,
} as const;
const FORECAST_DESCRIPTION = "Return an hourly outdoor-shoot forecast for one city. Call once per city when comparing locations.";
export const FORECAST_TOOL_OPENAI = {
  type: "function",
  function: { name: "get_hourly_forecast", description: FORECAST_DESCRIPTION, parameters: FORECAST_PARAMETERS },
} as const;
export const FORECAST_TOOL_RESPONSES = {
  type: "function", name: "get_hourly_forecast", description: FORECAST_DESCRIPTION, parameters: FORECAST_PARAMETERS, strict: true,
} as const;
export const FORECAST_TOOL_ANTHROPIC = {
  name: "get_hourly_forecast", description: FORECAST_DESCRIPTION, input_schema: FORECAST_PARAMETERS,
} as const;
export function expectedForecastArguments(city: "Tokyo" | "Paris") {
  return {
    location: { city, country_code: city === "Tokyo" ? "JP" : "FR" },
    date: "2026-10-18", start_hour: 15, end_hour: 18, units: "metric", fields: [...FORECAST_FIELDS],
  };
}
export const TOKYO_RESULT = JSON.stringify({
  location: { city: "Tokyo", country_code: "JP" }, date: "2026-10-18", units: "metric",
  hours: [
    { time: "15:00", temperature_c: 20, precipitation_probability: 20, cloud_cover_percent: 45, wind_speed_kph: 11 },
    { time: "16:00", temperature_c: 19, precipitation_probability: 25, cloud_cover_percent: 50, wind_speed_kph: 12 },
    { time: "17:00", temperature_c: 18, precipitation_probability: 30, cloud_cover_percent: 55, wind_speed_kph: 13 },
    { time: "18:00", temperature_c: 17, precipitation_probability: 30, cloud_cover_percent: 60, wind_speed_kph: 12 },
  ],
});
export const PARIS_RESULT = JSON.stringify({
  location: { city: "Paris", country_code: "FR" }, date: "2026-10-18", units: "metric",
  hours: [
    { time: "15:00", temperature_c: 14, precipitation_probability: 60, cloud_cover_percent: 80, wind_speed_kph: 18 },
    { time: "16:00", temperature_c: 13, precipitation_probability: 65, cloud_cover_percent: 85, wind_speed_kph: 19 },
    { time: "17:00", temperature_c: 12, precipitation_probability: 70, cloud_cover_percent: 90, wind_speed_kph: 21 },
    { time: "18:00", temperature_c: 11, precipitation_probability: 70, cloud_cover_percent: 90, wind_speed_kph: 20 },
  ],
});
export const SESSION_SYNTHESIS_PROMPT = [
  "Using only these forecast values and the earlier image analysis, recommend one city for the shoot.",
  "Compare both cities across the full 15:00-18:00 window, quote exact weather values, and explain how the winning conditions support the image-derived palette, silhouette, prop, and mood.",
  "Write 220-300 words and do not call another tool.",
].join(" ");
export const SESSION_SHOT_LIST_PROMPT = [
  "Keep the recommended city and turn the plan into a six-shot sequence scheduled from 15:00 to 18:00.",
  "Tie each shot to visible blue/silver styling, coat movement, sword placement, or the reserved mood from the reference image.",
  "Include one weather contingency and repeat the exact precipitation and wind facts that justify it.",
  "Write 200-260 words; do not call tools.",
].join(" ");
export const SESSION_AUDIT_PROMPT = [
  "Audit the plan without calling tools.",
  "Under Image-derived claims, list only facts visible in the original reference.",
  "Under Tool-derived claims, list the exact Tokyo and Paris forecast facts used.",
  "Under Unsupported claims, identify anything in the plan that was not supported by either source; write none if there are none.",
  "Finish with a 60-90 word handoff note for the photographer.",
].join(" ");

export const CAPTURE_SCENARIOS = ["long-text", "image", "parallel-tools", "five-turn"] as const;
export type CaptureScenario = typeof CAPTURE_SCENARIOS[number];
export interface ScenarioTurn {
  readonly prompt: string;
  readonly image: boolean;
  readonly tools: boolean;
  readonly minTextCharacters: number;
}
export function scenarioDefinition(scenario: CaptureScenario): { system: string; turns: readonly ScenarioTurn[] } {
  const turn = (prompt: string, image = false, tools = false, minTextCharacters = 600): ScenarioTurn => ({ prompt, image, tools, minTextCharacters });
  if (scenario === "long-text") return { system: "You are a concise production engineering assistant.", turns: [turn(LONG_TEXT_PROMPT, false, false, 1_000)] };
  if (scenario === "image") return { system: IMAGE_ANALYSIS_SYSTEM, turns: [turn(SESSION_IMAGE_PROMPT, true)] };
  if (scenario === "parallel-tools") return { system: SESSION_SYSTEM, turns: [turn(FORECAST_COMPARE_PROMPT, false, true, 0)] };
  return { system: SESSION_SYSTEM, turns: [
    turn(SESSION_IMAGE_PROMPT, true),
    turn(FORECAST_COMPARE_PROMPT, false, true, 0),
    turn(SESSION_SYNTHESIS_PROMPT, false, false, 1_000),
    turn(SESSION_SHOT_LIST_PROMPT, false, false, 1_000),
    turn(SESSION_AUDIT_PROMPT),
  ] };
}
