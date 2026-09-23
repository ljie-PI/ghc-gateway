// Pure authored scenario inputs shared by corpus recording and offline SDK replay.
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
  "Put each shot on its own line that begins with its HH:MM start time; no other line may begin with a time.",
  "Tie the shots to the visible blue/silver styling, coat movement, sword placement, and reserved mood from the reference image.",
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

export interface TextScenario {
  readonly id: "plain-text" | "image";
  readonly prompt: string;
  readonly system?: string;
  readonly imagePath?: string;
  readonly facts: readonly { readonly name: string; readonly pattern: RegExp }[];
}

export const WEATHER_PROMPT = "What is the weather in Tokyo?";
export const WEATHER_RESPONSES_PROMPT = "Call get_weather once with city Tokyo.";
export const PARALLEL_WEATHER_PROMPT = "Get weather for Tokyo and Paris simultaneously using get_weather twice.";
export const MIXED_WEATHER_PROMPT = "What is the weather in the city where this character resides? Call get_weather.";
export const WEATHER_RESULT = "{\"temperature\":22,\"condition\":\"sunny\"}";
export const REASONING_PROMPT = "Explain quantum entanglement in 20 words.";
/** Lower efforts omit public reasoning from the recorded Chat model. */
export const REASONING_EFFORT = "medium";

// Independently pinned from the recorded corpus; the recorder reports replacements. Matchers consume
// these constants rather than deriving semantic history from replay response bodies.
export const SESSION_ASSISTANT_TEXT_SHA256 = {
  chat: [
    "9ff9f487e69e55e26d8e401534bb9644971edd7b8663c9fd110c81cfcbe856ef",
    undefined,
    "013f8e93bc3af9ad47e2193c0a1dec9f95c4f675e1aa3cb767da2304d88a874e",
    "c98278327011032e0f603afe8c698f1be4aff0fd92df1a1649c1ab0bfd9beb0d",
    "6b63efb45bbfb2375bef8ba4b33adb17586cc8a84464bf7e3bb2377b9895bce0",
  ],
  responses: [
    "c324655c0ae5f5fe07deaea87d4d1656aeb40bb94245bcaeae84c4932cbd447b",
    undefined,
    "1e46d40982670e4dc515f3b5dfe48cb6a10761c03831ef856827b16c858d69a1",
    "5006c1da753b249767c068f43abbf221c345b50f3941060f7a412ce82797a032",
    "5c06b1d842f26e35eb0f1cfd12d4396495359a849788cdcb0b30608d6c22b967",
  ],
  messages: [
    "70b26397517cd74dbfbb233e081fa87c243a76f6953accaa2472407d36c6d49b",
    undefined,
    "e6036d0f29b5657fc1dddd4fc90e04c7c3eb58f535f90fa0d44d94e894a49efe",
    "bbd0e9cebf2e665f135f35a51891c3f2001bc09d88a63aca780f4323830a2725",
    "b4449b9c70df3c3832c388a33c76cecfa00fa87ec264a7a312366acff48046e2",
  ],
} as const;

export const WEATHER_PARAMETERS = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
} as const;

const IMAGE_FACTS: TextScenario["facts"] = [
  { name: "likely character", pattern: /Vergil/iu },
  { name: "blue palette", pattern: /blue/iu },
  { name: "silver or white styling", pattern: /silver|white/iu },
  { name: "coat silhouette", pattern: /coat/iu },
  { name: "sword prop", pattern: /sword|katana/iu },
  { name: "reserved mood", pattern: /reserved|stoic|controlled|composed|cool|intense|calm/iu },
];

export const TEXT_SCENARIOS: readonly TextScenario[] = [
  { id: "plain-text", prompt: LONG_TEXT_PROMPT, facts: [] },
  {
    id: "image",
    prompt: SESSION_IMAGE_PROMPT,
    system: IMAGE_ANALYSIS_SYSTEM,
    imagePath: "tests/sdk/images/vergil.jpg",
    facts: IMAGE_FACTS,
  },
];

/** Complete text length required for recorded long-text and image answers. */
export const MIN_TEXT_SCENARIO_CHARACTERS = 1_001;
/** Complete text length required for recorded coherent-session text turns. */
export const MIN_SESSION_TEXT_CHARACTERS = 601;
export const SESSION_SHOT_COUNT = 6;

/** Facts every recorded text turn of the coherent session must state. Turn 2 is tools only. */
export function sessionTurnFacts(turn: 1 | 3 | 4 | 5): readonly RegExp[] {
  if (turn === 1) return IMAGE_FACTS.map((fact) => fact.pattern);
  return [
    /Tokyo/iu, /silver|white/iu, /coat/iu, /sword|katana/iu, /30%/u, /13\s*(?:kph|km\/h)/iu,
    ...(turn === 4 ? [/15:00/u, /18:00/u, /contingency|rain|shelter|covered/iu] : [
      /Paris/iu, /blue/iu, /20\s*°?\s*C/u, /14\s*°?\s*C/u, /70%/u, /21\s*(?:kph|km\/h)/iu,
    ]),
    ...(turn === 5 ? [/Image-derived claims/iu, /Tool-derived claims/iu, /Unsupported claims/iu, /handoff/iu] : []),
  ];
}

/** Count shot-list lines that start with a time in the 15:00-18:59 window. */
export function scheduledShotCount(text: string): number {
  return [...text.matchAll(/^[*\- \t]*(?:15|16|17|18):[0-5]\d/gmu)].length;
}
