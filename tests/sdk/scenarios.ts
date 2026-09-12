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

// Independently pinned from the immutable recordings. Matchers consume these
// constants rather than deriving semantic history from replay response bodies.
export const SESSION_ASSISTANT_TEXT_SHA256 = {
  chat: [
    "536cbb5e2ee0e92d24bf84537564c2ff7b41a2e1bc47fb1e471ab7e6c8b09d34",
    undefined,
    "78953b1d468eac92cad2420b2e6f3205780288b637444fb545971fd9930611d6",
    "3bdc24ddc4eb202b22fb946ee5ff896bb35d3078e0b4e4caeefb76427f66c246",
    "cdfe415a186f302fb3d5ef65734a2c7505e11869a52d1de0f589fe0a9d8c0ac6",
  ],
  responses: [
    "67f1b4642ecf5061b2deb697ac26bbb0d3cf244a7eed43fad78c2c4d17fd1630",
    undefined,
    "e8d6eb7480f5a41f41fa092f1c2276c55ab17e4056c203ff4fc5623ef197c4e1",
    "c68d9fe01a089ea7b4281c57640d257d278a54927db053c741ff0a8899d3cd80",
    "33f6cb85539878dbefd470a40154e634eb6e56d775df38cf0f022c690f85a2cf",
  ],
  messages: [
    "c07a5b4ddfe5f51dfc29febd27619a8f2f49b8330b3f5fa441cffe7b23ea36a2",
    undefined,
    "29cd11052740b8c4ca882c71a5dfed99485ca8126d001e6244d3b392e15448e0",
    "e5afe8be69dc4e0fa01e1432330b14948b1eed1d920d457555ee59204cbd4b2f",
    "6c51f9dc3a7b7bcbe07392a19f7c364f9da337ded3d8bd50ca6fde5636823251",
  ],
} as const;

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
