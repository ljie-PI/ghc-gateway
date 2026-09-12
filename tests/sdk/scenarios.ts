import { IMAGE_ANALYSIS_SYSTEM, LONG_TEXT_PROMPT, SESSION_IMAGE_PROMPT } from "../../scripts/tooling/capture_scenarios.js";

export {
  IMAGE_ANALYSIS_SYSTEM, LONG_TEXT_PROMPT, SESSION_SYSTEM, SESSION_IMAGE_PROMPT, FORECAST_COMPARE_PROMPT,
  FORECAST_FIELDS, FORECAST_PARAMETERS, FORECAST_TOOL_OPENAI, FORECAST_TOOL_RESPONSES,
  FORECAST_TOOL_ANTHROPIC, expectedForecastArguments, TOKYO_RESULT, PARIS_RESULT,
  SESSION_SYNTHESIS_PROMPT, SESSION_SHOT_LIST_PROMPT, SESSION_AUDIT_PROMPT,
} from "../../scripts/tooling/capture_scenarios.js";

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
export const WEATHER_PARAMETERS = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
} as const;

export const TEXT_SCENARIOS: readonly TextScenario[] = [
  { id: "plain-text", prompt: LONG_TEXT_PROMPT, facts: [] },
  {
    id: "image",
    prompt: SESSION_IMAGE_PROMPT,
    system: IMAGE_ANALYSIS_SYSTEM,
    imagePath: "tests/sdk/images/vergil.jpg",
    facts: [
      { name: "likely character", pattern: /Vergil/iu },
      { name: "blue palette", pattern: /blue/iu },
      { name: "silver or white styling", pattern: /silver|white/iu },
      { name: "coat silhouette", pattern: /coat/iu },
      { name: "sword prop", pattern: /sword|katana/iu },
      { name: "reserved mood", pattern: /reserved|stoic|controlled|composed|cool|intense|calm/iu },
    ],
  },
];
