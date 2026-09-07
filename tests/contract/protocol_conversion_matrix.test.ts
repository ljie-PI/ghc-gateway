import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { createAnthropicMessagesRoute } from "../../src/protocols/anthropic_messages/endpoint.js";
import { createOpenAiChatRoute } from "../../src/protocols/openai_chat/endpoint.js";
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nowMs = (): number => 1_700_000_000_000;

describe("protocol conversion matrix", () => {
  it.each([
    ["chat", "chat", "native-chat", "chat"],
    ["chat", "messages", "native-messages", "messages"],
    ["chat", "responses", "native-responses", "responses"],
    ["messages", "chat", "native-chat", "chat"],
    ["messages", "messages", "native-messages", "messages"],
    ["messages", "responses", "native-responses", "responses"],
    ["responses", "chat", "native-chat", "chat"],
    ["responses", "messages", "native-messages", "messages"],
    ["responses", "responses", "native-responses", "responses"],
  ] as const)(
    "executes %s -> %s with one typed %s operation",
    async (source, _target, model, expectedKind) => {
      const harness = await matrixGateway();
      try {
        const response = await harness.gw.fetch(protocolRequest(source, model));
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("ok");
        expect(harness.backend.captured.map((entry) => entry.kind)).toEqual([expectedKind]);
      } finally {
        await harness.close();
      }
    },
  );

  it("uses candidate compatibility before fixed priority without probing or fallback", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/chat/completions", {
        model: "responses-messages",
        messages: [{ role: "user", content: "hi" }],
        stop: ["END"],
      }));
      expect(response.status).toBe(200);
      expect(harness.backend.captured.map((entry) => entry.kind)).toEqual(["messages"]);
      expect(JSON.parse(decoder.decode(harness.messagesBodies[0]))).toMatchObject({
        model: "responses-messages",
        stop_sequences: ["END"],
      });

    } finally {
      await harness.close();
    }
  });

  it.each([
    [{
      tools: [
        { type: "custom", name: "render", format: { type: "text" } },
        { type: "function", name: "bad", parameters: [], unknown: true },
      ],
    }, 422],
    [{
      tools: [{
        type: "namespace",
        name: "ns",
        tools: [{
          type: "function",
          name: "bad",
          parameters: "invalid",
          strict: "invalid",
          unknown_constraint: true,
        }],
      }],
    }, 422],
    [{
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      parallel_tool_calls: "bad",
    }, 400],
    [{
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      tool_choice: { type: "custom", name: "missing" },
    }, 400],
  ] as const)("strictly rejects malformed extended tool declarations and controls", async (extra, status) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        ...extra,
      }));
      expect(response.status).toBe(status);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects duplicate fields in flat namespace children before inference", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(rawRequest(
        "/v1/responses",
        "{\"model\":\"native-chat\",\"input\":\"render\",\"tools\":[{\"type\":\"namespace\",\"name\":\"ns\",\"tools\":[{\"type\":\"function\",\"name\":\"lookup\",\"parameters\":{\"type\":\"object\"},\"strict\":false,\"strict\":true}]}]}",
      ));
      expect(response.status).toBe(400);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects duplicate fields in discovered namespaces before inference", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(rawRequest(
        "/v1/responses",
        "{\"model\":\"native-chat\",\"input\":[{\"type\":\"tool_search_call\",\"call_id\":\"call_search\",\"arguments\":{\"query\":\"lookup\"}},{\"type\":\"tool_search_output\",\"call_id\":\"call_search\",\"tools\":[{\"type\":\"namespace\",\"name\":\"first\",\"name\":\"second\",\"tools\":[{\"type\":\"function\",\"name\":\"lookup\",\"parameters\":{\"type\":\"object\"}}]}]}],\"tools\":[{\"type\":\"tool_search\"}]}",
      ));
      expect(response.status).toBe(400);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("round-trips a buffered custom tool through scoped Responses history", async () => {
    const harness = await matrixGateway();
    try {
      const first = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      const firstBody = await first.json() as {
        id: string;
        output: Array<{ type: string; call_id?: string }>;
      };
      const call = firstBody.output.find((item) => item.type === "custom_tool_call");
      expect(call?.call_id).toBe("call_custom");
      const second = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        previous_response_id: firstBody.id,
        input: [{
          type: "custom_tool_call_output",
          call_id: "call_custom",
          output: "done",
        }],
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("ok");
      expect(harness.backend.captured.map((entry) => entry.kind)).toEqual(["chat", "chat"]);
    } finally {
      await harness.close();
    }
  });

  it("continues an ordinary function call declared alongside an extended tool", async () => {
    const harness = await matrixGateway();
    try {
      const tools = [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object" },
          strict: false,
        },
        { type: "custom", name: "render", format: { type: "text" } },
      ];
      const first = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "ordinary-mixed",
        tools,
      }));
      expect(first.status).toBe(200);
      const firstBody = await first.json() as {
        id: string;
        output: Array<{ type: string; call_id?: string; name?: string }>;
      };
      expect(firstBody.output).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "call_ordinary", name: "lookup" }),
      ]));

      const second = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        previous_response_id: firstBody.id,
        input: [{
          type: "function_call_output",
          call_id: "call_ordinary",
          output: "done",
        }],
        tools,
      }));
      expect(second.status).toBe(200);
      expect(harness.backend.captured.map((entry) => entry.kind)).toEqual(["chat", "chat"]);
    } finally {
      await harness.close();
    }
  });

  it("preserves compatible Responses function strict defaults on the extended Chat route", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [
          {
            type: "function",
            name: "strict_lookup",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
          {
            type: "namespace",
            name: "ns",
            tools: [{
              type: "function",
              name: "nested_strict_lookup",
              parameters: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              strict: true,
            }],
          },
          { type: "custom", name: "render", format: { type: "text" } },
        ],
      }));
      expect(response.status).toBe(200);
      const request = JSON.parse(decoder.decode(harness.chatBodies[0])) as {
        tools: Array<{ function: { name: string; strict?: boolean } }>;
      };
      expect(request.tools.find((tool) => tool.function.name === "strict_lookup")?.function.strict).toBe(true);
      expect(request.tools.find((tool) => tool.function.name !== "strict_lookup"
        && tool.function.name !== "render")?.function.strict).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rejects ambiguous Responses auto strictness on the extended Chat route", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [
          {
            type: "function",
            name: "ambiguous",
            parameters: {
              type: "object",
              properties: { optional_value: { type: "string" } },
            },
          },
          { type: "custom", name: "render", format: { type: "text" } },
        ],
      }));
      expect(response.status).toBe(422);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["none", "none"],
    ["max", "xhigh"],
  ] as const)("uses normalized Responses reasoning effort %s on the extended Chat route", async (source, expected) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        reasoning: { effort: source },
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(response.status).toBe(200);
      const request = JSON.parse(decoder.decode(harness.chatBodies[0])) as { reasoning_effort?: string };
      expect(request.reasoning_effort).toBe(expected);
    } finally {
      await harness.close();
    }
  });

  it("round-trips a buffered namespace tool and preserves incomplete item status", async () => {
    const harness = await matrixGateway();
    try {
      const first = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "namespace",
        tools: [{
          type: "namespace",
          name: "ns",
          tools: [{
            type: "function",
            name: "lookup",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          }],
        }],
      }));
      const firstBody = await first.json() as {
        id: string;
        output: Array<{ type: string; call_id?: string; namespace?: string }>;
      };
      const call = firstBody.output.find((item) => item.type === "function_call");
      expect(call).toMatchObject({ call_id: "call_namespace", namespace: "ns" });
      const second = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        previous_response_id: firstBody.id,
        input: [{
          type: "function_call_output",
          call_id: "call_namespace",
          output: "failed",
          status: "failed",
        }],
        tools: [{
          type: "namespace",
          name: "ns",
          tools: [{
            type: "function",
            name: "lookup",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          }],
        }],
      }));
      expect(second.status).toBe(200);
      expect(decoder.decode(harness.chatBodies[1])).toContain("[cc-switch:tool-result-error]");

      const incomplete = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "partial-custom",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(await incomplete.json()).toMatchObject({
        status: "incomplete",
        output: expect.arrayContaining([
          expect.objectContaining({ type: "custom_tool_call", status: "incomplete" }),
        ]),
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      input: "collision",
      tools: [
        { type: "function", name: "ns__lookup", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "ns",
          tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        },
      ],
    },
    {
      input: [{ type: "tool_search_call", call_id: "call_search" }],
      tools: [{ type: "tool_search" }],
    },
    {
      input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "unsafe" }] }],
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    },
    {
      input: { role: "developer", content: [{ type: "input_text", text: "unsafe" }] },
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    },
    {
      input: [
        { role: "user", content: [{ type: "input_text", text: "first" }] },
        { role: "system", content: [{ type: "input_text", text: "late" }] },
      ],
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    },
    {
      input: [
        { type: "tool_search_call", call_id: "call_search", arguments: { query: "x" } },
        {
          type: "tool_search_output",
          call_id: "call_search",
          tools: [{ type: "custom", name: "grammar", format: { type: "grammar", syntax: "regex" } }],
        },
      ],
      tools: [{ type: "tool_search" }],
    },
    {
      input: "namespace choice",
      tools: [{
        type: "namespace",
        name: "ns",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      }],
      tool_choice: { type: "function", namespace: "missing", name: "lookup" },
    },
    {
      input: [
        { type: "custom_tool_call", call_id: "call_dup", name: "render", input: "x" },
        { type: "function_call", call_id: "call_dup", name: "lookup", arguments: "{}" },
      ],
      tools: [
        { type: "custom", name: "render", format: { type: "text" } },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
    },
    {
      input: [
        { type: "custom_tool_call", call_id: "call_1", name: "render", input: "x" },
        { role: "user", content: [{ type: "input_text", text: "interrupt" }] },
        { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
      ],
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    },
  ])("rejects lossy extended tool variants before inference", async (request) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        ...request,
      }));
      expect([400, 422]).toContain(response.status);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("preserves tool-search discovery declarations in a buffered round trip", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: [
          {
            type: "tool_search_call",
            call_id: "call_search",
            arguments: { query: "lookup" },
          },
          {
            type: "tool_search_output",
            call_id: "call_search",
            tools: [{
              type: "function",
              name: "lookup",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            }],
          },
          {
            type: "function_call",
            call_id: "call_lookup",
            name: "lookup",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_lookup",
            output: "done",
          },
        ],
        tools: [{ type: "tool_search" }],
      }));
      expect(response.status).toBe(200);
      expect(harness.backend.captured.map((entry) => entry.kind)).toEqual(["chat"]);
    } finally {
      await harness.close();
    }
  });

  it("rejects extended tool-result media instead of dropping long adjacent text", async () => {
    const harness = await matrixGateway();
    try {
      const longText = "x".repeat(9000);
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: [
          { type: "custom_tool_call", call_id: "call_1", name: "render", input: "x" },
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: [
              { type: "input_text", text: longText },
              { type: "input_image", image_url: "data:image/png;base64,QUJD" },
            ],
          },
        ],
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(response.status).toBe(422);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects JSON-encoded extended result media before inference", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: [
          { type: "custom_tool_call", call_id: "call_1", name: "render", input: "x" },
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: JSON.stringify({
              content: [{ type: "input_image", image_url: "data:image/png;base64,QUJD" }],
            }),
          },
        ],
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(response.status).toBe(422);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["chat", "native-chat", "chat-stream", "[DONE]"],
    ["chat", "native-messages", "messages-stream", "[DONE]"],
    ["chat", "native-responses", "responses-stream", "[DONE]"],
    ["messages", "native-chat", "chat-stream", "event: message_stop"],
    ["messages", "native-messages", "messages-stream", "event: message_stop"],
    ["messages", "native-responses", "responses-stream", "event: message_stop"],
    ["responses", "native-chat", "chat-stream", "response.completed"],
    ["responses", "native-messages", "messages-stream", "response.completed"],
    ["responses", "native-responses", "responses-stream", "response.completed"],
  ] as const)(
    "streams %s through %s with one operation and an exact success terminal",
    async (source, modelId, expectedKind, terminal) => {
      const harness = await matrixGateway();
      try {
        const response = await harness.gw.fetch(protocolRequest(source, modelId, { stream: true }));
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("ok");
        expect(text).toContain(terminal);
        expect(harness.backend.captured.map((entry) => entry.kind)).toEqual([expectedKind]);
        if (source === "chat") {
          expect(text.match(/data: \[DONE\]/gu)).toHaveLength(1);
        } else if (source === "messages") {
          expect(text).not.toContain("[DONE]");
          expect(text.match(/event: message_stop/gu)).toHaveLength(1);
        } else {
          expect(text).not.toContain("[DONE]");
          expect(text.match(/event: response\.completed/gu)).toHaveLength(1);
        }
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    ["/v1/chat/completions", "{\"model\":\"responses-messages\",\"messages\":[],\"unknown\":null}", 422],
    ["/v1/chat/completions", "{\"model\":\"native-responses\",\"messages\":[],\"n\":2}", 422],
    ["/v1/messages", "{\"model\":\"native-responses\",\"max_tokens\":8,\"messages\":[],\"stop_sequences\":[\"x\"]}", 400],
    ["/v1/responses", "{\"model\":\"native-messages\",\"input\":\"hi\",\"background\":true}", 422],
  ] as const)("rejects converted request %s before inference", async (path, body, status) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(rawRequest(path, body));
      expect(response.status).toBe(status);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("preserves unknown extensions on all native paths", async () => {
    const harness = await matrixGateway();
    try {
      const requests = [
        protocolRequest("chat", "native-chat", { native_extension: { z: 1 } }),
        protocolRequest("messages", "native-messages", { native_extension: { z: 2 } }),
        protocolRequest("responses", "native-responses", { native_extension: { z: 3 } }),
      ];
      for (const request of requests) {
        expect((await harness.gw.fetch(request)).status).toBe(200);
      }
      expect(JSON.parse(decoder.decode(harness.chatBodies[0]))).toMatchObject({
        native_extension: { z: 1 },
      });
      expect(JSON.parse(decoder.decode(harness.messagesBodies[0]))).toMatchObject({
        native_extension: { z: 2 },
      });
      expect(JSON.parse(decoder.decode(harness.responsesBodies[0]))).toMatchObject({
        native_extension: { z: 3 },
      });
    } finally {
      await harness.close();
    }
  });

  it("pins a Responses continuation to Messages and consumes previous_response_id locally", async () => {
    const harness = await matrixGateway();
    try {
      await harness.history.recordCheckpoint({
        responseId: "resp_messages_owned",
        output: [{
          kind: "object",
          members: [
            { key: "type", value: "function_call" },
            { key: "id", value: "fc_owned" },
            { key: "call_id", value: "call_owned" },
            { key: "name", value: "lookup" },
            { key: "arguments", value: "{\"q\":\"x\"}" },
          ],
        }],
      }, {
        accountId: "github.com/1",
        modelId: "dual-messages",
        upstreamOrigin: "https://api.githubcopilot.com",
        owner: "converted",
        upstreamProtocol: "messages",
        conversionVersion: "responses-messages-v1",
      }, "complete", new AbortController().signal);

      const rejected = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "dual-messages",
        previous_response_id: "resp_messages_owned",
        input: [{
          type: "function_call_output",
          call_id: "call_owned",
          output: "result",
        }],
      }));
      expect(rejected.status).not.toBe(200);
      await rejected.text();
      expect(harness.backend.captured).toEqual([]);

      for (const content of ["", [], [{ type: "input_text", text: "" }]]) {
        const emptyContext = await harness.gw.fetch(jsonRequest("/v1/responses", {
          model: "dual-messages",
          previous_response_id: "resp_messages_owned",
          input: [
            { type: "message", role: "user", content },
            {
              type: "function_call_output",
              call_id: "call_owned",
              output: "result",
            },
          ],
        }));
        expect(emptyContext.status).not.toBe(200);
        await emptyContext.text();
      }
      expect(harness.backend.captured).toEqual([]);

      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "dual-messages",
        previous_response_id: "resp_messages_owned",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Use the tool result for the original task." }],
          },
          {
            type: "function_call_output",
            call_id: "call_owned",
            output: "result",
          },
        ],
      }));
      expect(response.status).toBe(200);
      expect(harness.backend.captured.map((entry) => entry.kind)).toEqual(["messages"]);
      const forwarded = decoder.decode(harness.messagesBodies[0]);
      expect(forwarded).not.toContain("previous_response_id");
      expect(forwarded).toContain("call_owned");
      expect(forwarded).toContain("original task");
    } finally {
      await harness.close();
    }
  });

  it("keeps the existing Responses-to-Chat custom tool adapter connected", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        max_completion_tokens: 7,
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
        tool_choice: { type: "custom", name: "render" },
      }));
      expect(response.status).toBe(200);
      const payload = await response.json() as { output?: unknown[] };
      expect(payload.output).toEqual(expect.arrayContaining([expect.objectContaining({
        type: "custom_tool_call",
        call_id: "call_custom",
        name: "render",
        input: "hello",
      })]));
      expect(JSON.parse(decoder.decode(harness.chatBodies[0]))).toMatchObject({ max_tokens: 7 });
      expect(decoder.decode(harness.chatBodies[0])).not.toContain("max_completion_tokens");
      expect(harness.backend.captured.map((entry) => entry.kind)).toEqual(["chat"]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    [{ max_output_tokens: -1 }, 400],
    [{ text: { format: { type: "json_schema", name: "x", schema: { type: "object" } } } }, 422],
    [{ stream: true }, 422],
  ] as const)("rejects unsafe extended-tool semantics before inference", async (extra, status) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
        ...extra,
      }));
      expect(response.status).toBe(status);
      await response.text();
      expect(harness.backend.captured).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});

interface MatrixHarness {
  readonly gw: Gateway;
  readonly backend: ScriptedCopilotBackend;
  readonly history: SqliteResponsesHistory;
  readonly chatBodies: Uint8Array[];
  readonly messagesBodies: Uint8Array[];
  readonly responsesBodies: Uint8Array[];
  close(): Promise<void>;
}

async function matrixGateway(): Promise<MatrixHarness> {
  const database = openDatabase({
    path: ":memory:",
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(responsesHistoryMigration),
      embedMigration(responsesContinuationMigration),
    ],
    nowMs,
  });
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
  await directory.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "test-token" },
  });
  const catalog = new CopilotModelCatalog({
    async fetch() {
      return {
        data: [
          model("native-chat", ["/v1/chat/completions"]),
          model("native-messages", ["/v1/messages"]),
          model("native-responses", ["/v1/responses"]),
          model("responses-messages", ["/v1/responses", "/v1/messages"]),
          model("dual-messages", ["/v1/responses", "/v1/messages"]),
        ],
      };
    },
  }, () => new Date(nowMs()));
  const history = new SqliteResponsesHistory(database, { nowMs });
  const chatBodies: Uint8Array[] = [];
  const messagesBodies: Uint8Array[] = [];
  const responsesBodies: Uint8Array[] = [];
  const backend = new ScriptedCopilotBackend({
    chat(request) {
      chatBodies.push(request.body);
      const captured = JSON.parse(decoder.decode(request.body)) as {
        messages?: Array<{ role?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const hasToolResult = captured.messages?.some((message) => message.role === "tool") === true;
      const custom = captured.tools?.some((tool) => tool.function?.name === "render") === true;
      const namespace = captured.tools?.some((tool) => tool.function?.name === "ns__lookup") === true;
      const ordinaryMixed = decoder.decode(request.body).includes("ordinary-mixed");
      const partialCustom = decoder.decode(request.body).includes("partial-custom");
      const toolCall = partialCustom
        ? {
          id: "call_custom",
          type: "function",
          function: { name: "render", arguments: "{\"input\":\"x\"" },
        }
        : ordinaryMixed
          ? {
            id: "call_ordinary",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          }
          : namespace
            ? {
              id: "call_namespace",
              type: "function",
              function: { name: "ns__lookup", arguments: "{}" },
            }
            : {
              id: "call_custom",
              type: "function",
              function: { name: "render", arguments: "{\"input\":\"hello\"}" },
            };
      return {
        status: 200,
        headers: new Headers(),
        body: encoder.encode(JSON.stringify({
          id: "chatcmpl_matrix",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "matrix",
          choices: [{
            index: 0,
            message: (custom || namespace) && !hasToolResult
              ? {
                role: "assistant",
                content: null,
                tool_calls: [toolCall],
              }
              : { role: "assistant", content: "ok" },
            finish_reason: partialCustom
              ? "length"
              : (custom || namespace) && !hasToolResult ? "tool_calls" : "stop",
          }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        })),
      };
    },
    messages(request) {
      messagesBodies.push(request.body);
      return {
        status: 200,
        headers: new Headers(),
        body: encoder.encode(JSON.stringify({
          id: "msg_matrix",
          type: "message",
          role: "assistant",
          model: "matrix",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 1 },
        })),
      };
    },
    responses(request) {
      responsesBodies.push(request.body);
      return {
        status: 200,
        headers: new Headers(),
        body: encoder.encode(JSON.stringify({
          id: "resp_matrix",
          object: "response",
          created_at: 1_700_000_000,
          status: "completed",
          output: [{
            id: "msg_matrix",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        })),
      };
    },
    chatStream(request) {
      chatBodies.push(request.body);
      return [
        encoder.encode(`data: ${JSON.stringify({
          id: "chatcmpl_matrix_stream",
          object: "chat.completion.chunk",
          created: 1_700_000_000,
          model: "matrix",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        })}\n\n`),
        encoder.encode("data: [DONE]\n\n"),
      ];
    },
    messagesStream(request) {
      messagesBodies.push(request.body);
      return [
        messagesEvent("message_start", {
          type: "message_start",
          message: {
            id: "msg_matrix_stream",
            type: "message",
            role: "assistant",
            content: [],
            model: "matrix",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 0 },
          },
        }),
        messagesEvent("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        messagesEvent("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        }),
        messagesEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
        messagesEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
        messagesEvent("message_stop", { type: "message_stop" }),
      ];
    },
    responsesStream(request) {
      responsesBodies.push(request.body);
      const response = {
        id: "resp_matrix_stream",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        output: [{
          id: "msg_matrix_stream",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      };
      return [
        responsesEvent(0, "response.created", { response: { ...response, status: "in_progress", output: [] } }),
        responsesEvent(1, "response.output_item.added", {
          output_index: 0,
          item: { ...response.output[0], status: "in_progress", content: [] },
        }),
        responsesEvent(2, "response.output_text.delta", {
          item_id: "msg_matrix_stream",
          output_index: 0,
          content_index: 0,
          delta: "ok",
        }),
        responsesEvent(3, "response.output_text.done", {
          item_id: "msg_matrix_stream",
          output_index: 0,
          content_index: 0,
          text: "ok",
        }),
        responsesEvent(4, "response.output_item.done", {
          output_index: 0,
          item: response.output[0],
        }),
        responsesEvent(5, "response.completed", { response }),
      ];
    },
  });
  const routeDependencies = {
    directory,
    catalog,
    preferences: directory.preferences,
    copilot: backend,
    createUuid: () => "00000000-0000-4000-8000-000000000104",
    nowMs,
  };
  const gw = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:\\ghc-gateway-tests\\matrix\\.home" }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, [
    createOpenAiChatRoute(routeDependencies),
    createAnthropicMessagesRoute(routeDependencies),
    createResponsesRoute({ ...routeDependencies, history, nowUnixSeconds: () => 1_700_000_000 }),
  ], { createRequestId: () => "req_matrix" });
  return {
    gw,
    backend,
    history,
    chatBodies,
    messagesBodies,
    responsesBodies,
    async close() {
      await gw.close();
      closeDatabase(database);
    },
  };
}

function model(id: string, supportedEndpoints: string[]) {
  return {
    id,
    name: id,
    vendor: "test",
    model_picker_enabled: true,
    model_info: {
      supported_endpoints: supportedEndpoints,
      max_output_tokens: 16_384,
      default_output_tokens: 4_096,
      chat_output_token_field: "max_tokens",
      supported_parameters: [
        "temperature",
        "top_p",
        "response_format",
        "text.format",
        "output_config.format",
        "reasoning_effort",
        "reasoning",
        "reasoning.effort",
        "output_config.effort",
      ],
    },
  };
}

function protocolRequest(
  source: "chat" | "messages" | "responses",
  modelId: string,
  extra: Readonly<Record<string, unknown>> = {},
): Request {
  if (source === "chat") {
    return jsonRequest("/v1/chat/completions", {
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    });
  }
  if (source === "messages") {
    return jsonRequest("/v1/messages", {
      model: modelId,
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    });
  }
  return jsonRequest("/v1/responses", { model: modelId, input: "hi", ...extra });
}

function jsonRequest(path: string, body: unknown): Request {
  return rawRequest(path, JSON.stringify(body));
}

function rawRequest(path: string, body: string): Request {
  return new Request(`http://127.0.0.1:31400${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(path === "/v1/messages" ? { "anthropic-version": "2023-06-01" } : {}),
    },
    body,
  });
}

function messagesEvent(type: string, payload: Readonly<Record<string, unknown>>): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function responsesEvent(
  sequenceNumber: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Uint8Array {
  const event = { type, sequence_number: sequenceNumber, ...payload };
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}
