import { describe, expect, it } from "vitest";
import { ConversionDegradationCollector } from "../../src/protocols/conversion/degradations.js";
import {
  projectCompleteToolRounds,
  projectIndependentOption,
  projectKnownObject,
  projectToolRequest,
  reconcileProjectedToolControls,
  type ToolHistoryProjectionItem,
} from "../../src/protocols/conversion/request_projection.js";
import { ConversionContractError, type SemanticRequestItem, type SemanticTool } from "../../src/protocols/conversion/types.js";
import { isWireJsonObject, parseWireJson, serializeWireJson, type WireJsonObject } from "../../src/serialization/wire_json.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function object(json: string): WireJsonObject {
  const value = parseWireJson(encoder.encode(json), { maxBytes: 4096, maxDepth: 16 });
  if (!isWireJsonObject(value)) throw new Error("expected object");
  return value;
}

function text(text: string): SemanticRequestItem {
  return { type: "message", role: "user", content: [{ type: "text", text }] };
}

function call(callId: string, name = "lookup"): Extract<SemanticRequestItem, { readonly type: "tool_call" }> {
  return { type: "tool_call", callId, name, argumentsJson: "{}" };
}

function result(callId: string): Extract<SemanticRequestItem, { readonly type: "tool_result" }> {
  return { type: "tool_result", callId, content: [{ type: "text", text: "ok" }], isError: false };
}

function tool(name: string): SemanticTool {
  return { kind: "function", name, parameters: object("{}") };
}

describe("auditable request projection", () => {
  it("omits duplicate ordinary extensions while preserving known member order and number lexemes", () => {
    const degradations = new ConversionDegradationCollector();
    const projected = projectKnownObject(
      object("{\"first\":1e+2,\"PRIVATE_KEY\":\"PRIVATE_VALUE\",\"PRIVATE_KEY\":false,\"last\":-0}"),
      {
        knownKeys: new Set(["first", "last"]),
        sensitiveKeys: new Set(["tool_call_id"]),
        ruleId: "REQ-TEST-PROJECTION",
        omission: "messages.extensions_omitted",
        degradations,
      },
    );

    expect(decoder.decode(serializeWireJson(projected))).toBe("{\"first\":1e+2,\"last\":-0}");
    expect(degradations.values()).toEqual(["messages.extensions_omitted"]);
    expect(JSON.stringify(degradations.values())).not.toContain("PRIVATE");
  });

  it("rejects duplicate known fields, sensitive fields, and carriers hidden in omitted values", () => {
    for (const input of [
      object("{\"known\":1,\"known\":2}"),
      object("{\"known\":1,\"tool_call_id\":\"call_private\"}"),
      object("{\"known\":1,\"extension\":{\"signature\":\"ghcg-rsn-v1:private\"}}"),
    ]) {
      const degradations = new ConversionDegradationCollector();
      expect(() => projectKnownObject(input, {
        knownKeys: new Set(["known"]),
        sensitiveKeys: new Set(["tool_call_id"]),
        omittedValueIsUnsafe: (value) => JSON.stringify(value).includes("ghcg-rsn-v1:"),
        ruleId: "REQ-TEST-PROJECTION",
        omission: "messages.extensions_omitted",
        degradations,
      })).toThrowError(ConversionContractError);
      expect(degradations.values()).toEqual([]);
    }
  });

  it("omits only explicitly malformed independent options and propagates parser failures", () => {
    const degradations = new ConversionDegradationCollector();
    expect(projectIndependentOption(undefined, () => ({ kind: "malformed" }), {
      omission: "request.option_omitted", degradations,
    })).toBeUndefined();
    expect(projectIndependentOption("valid", (value) => ({ kind: "value", value }), {
      omission: "request.option_omitted", degradations,
    })).toBe("valid");
    expect(projectIndependentOption({ kind: "number", lexeme: "17" }, () => ({ kind: "malformed" }), {
      omission: "request.option_omitted", degradations,
    })).toBeUndefined();
    expect(degradations.values()).toEqual(["request.option_omitted"]);
    expect(() => projectIndependentOption("bad", () => {
      throw new ConversionContractError("invalid_request", "REQ-TEST-CORE");
    }, { omission: "request.option_omitted", degradations })).toThrowError("REQ-TEST-CORE");
  });

  it("retains exact complete parallel rounds in source order", () => {
    const degradations = new ConversionDegradationCollector();
    const candidates: readonly ToolHistoryProjectionItem[] = [
      { kind: "item", item: text("before") },
      { kind: "tool_call", callId: "call_1", bindingKey: "function", item: call("call_1") },
      { kind: "tool_call", callId: "call_2", bindingKey: "function", item: call("call_2") },
      { kind: "tool_result", callId: "call_2", bindingKey: "function", item: result("call_2") },
      { kind: "tool_result", callId: "call_1", bindingKey: "function", item: result("call_1") },
      { kind: "item", item: text("after") },
    ];

    expect(projectCompleteToolRounds(candidates, degradations)).toEqual(candidates.map((candidate) => candidate.item));
    expect(degradations.values()).toEqual([]);
  });

  it("removes ambiguous, malformed, orphaned, and incomplete tool rounds without guessed rebinding", () => {
    const degradations = new ConversionDegradationCollector();
    const candidates: readonly ToolHistoryProjectionItem[] = [
      { kind: "item", item: text("keep-a") },
      { kind: "tool_call", callId: "call_bad", bindingKey: "function" },
      { kind: "tool_result", callId: "call_bad", bindingKey: "function", item: result("call_bad") },
      { kind: "item", item: text("keep-b") },
      { kind: "tool_call", bindingKey: "function", item: call("generated-id-must-not-bind") },
      { kind: "tool_result", callId: "generated-id-must-not-bind", bindingKey: "function", item: result("generated-id-must-not-bind") },
      { kind: "item", item: text("keep-c") },
      { kind: "tool_call", callId: "call_incomplete", bindingKey: "function", item: call("call_incomplete") },
      { kind: "item", item: text("keep-d") },
      { kind: "tool_result", callId: "call_orphan", bindingKey: "function", item: result("call_orphan") },
    ];

    expect(projectCompleteToolRounds(candidates, degradations)).toEqual([
      text("keep-a"), text("keep-b"), text("keep-c"), text("keep-d"),
    ]);
    expect(degradations.values()).toEqual(["tools.history_omitted"]);
  });

  it("removes every occurrence of duplicate identities instead of selecting a winner", () => {
    const degradations = new ConversionDegradationCollector();
    const candidates: readonly ToolHistoryProjectionItem[] = [
      { kind: "tool_call", callId: "call_same", bindingKey: "function", item: call("call_same", "first") },
      { kind: "tool_result", callId: "call_same", bindingKey: "function", item: result("call_same") },
      { kind: "item", item: text("boundary") },
      { kind: "tool_call", callId: "call_same", bindingKey: "function", item: call("call_same", "second") },
      { kind: "tool_result", callId: "call_same", bindingKey: "function", item: result("call_same") },
    ];

    expect(projectCompleteToolRounds(candidates, degradations)).toEqual([text("boundary")]);
    expect(degradations.values()).toEqual(["tools.history_omitted"]);
  });

  it("removes every member of a partial parallel round when one pair is malformed", () => {
    const degradations = new ConversionDegradationCollector();
    const candidates: readonly ToolHistoryProjectionItem[] = [
      { kind: "item", item: text("before") },
      { kind: "tool_call", callId: "call_good", bindingKey: "function", item: call("call_good") },
      { kind: "tool_call", callId: "call_bad", bindingKey: "function" },
      { kind: "tool_result", callId: "call_good", bindingKey: "function", item: result("call_good") },
      { kind: "tool_result", callId: "call_bad", bindingKey: "function", item: result("call_bad") },
      { kind: "item", item: text("after") },
    ];

    expect(projectCompleteToolRounds(candidates, degradations)).toEqual([text("before"), text("after")]);
    expect(degradations.values()).toEqual(["tools.history_omitted"]);
  });

  it("removes the completed side of a round when a new call appears after partial results", () => {
    const degradations = new ConversionDegradationCollector();
    const candidates: readonly ToolHistoryProjectionItem[] = [
      { kind: "item", item: text("before") },
      { kind: "tool_call", callId: "call_1", bindingKey: "function", item: call("call_1") },
      { kind: "tool_call", callId: "call_2", bindingKey: "function", item: call("call_2") },
      { kind: "tool_result", callId: "call_1", bindingKey: "function", item: result("call_1") },
      { kind: "tool_call", callId: "call_3", bindingKey: "function", item: call("call_3") },
      { kind: "tool_result", callId: "call_2", bindingKey: "function", item: result("call_2") },
      { kind: "tool_result", callId: "call_3", bindingKey: "function", item: result("call_3") },
      { kind: "item", item: text("after") },
    ];

    expect(projectCompleteToolRounds(candidates, degradations)).toEqual([text("before"), text("after")]);
    expect(degradations.values()).toEqual(["tools.history_omitted"]);
  });

  it("rejects candidate IDs that disagree with decoded item IDs", () => {
    const degradations = new ConversionDegradationCollector();
    expect(projectCompleteToolRounds([
      { kind: "tool_call", callId: "source_id", bindingKey: "function", item: call("different_id") },
      { kind: "tool_result", callId: "source_id", bindingKey: "function", item: result("source_id") },
    ], degradations)).toEqual([]);
    expect(degradations.values()).toEqual(["tools.history_omitted"]);
  });

  it("fails closed for removed forced choices and explicitly audits orphaned parallel control", () => {
    expect(() => reconcileProjectedToolControls({
      tools: [tool("kept")],
      toolChoice: { kind: "tool", name: "removed" },
      parallelToolCalls: false,
      degradations: new ConversionDegradationCollector(),
    })).toThrowError("REQ-TOOL-CHOICE-REMOVED");

    const degradations = new ConversionDegradationCollector();
    expect(reconcileProjectedToolControls({
      tools: [],
      toolChoice: { kind: "auto" },
      parallelToolCalls: false,
      degradations,
    })).toEqual({ toolChoice: { kind: "auto" } });
    expect(degradations.values()).toEqual(["tools.parallel_control_omitted"]);
  });

  it("returns only a sequence and controls that pass the shared binding validator", () => {
    const degradations = new ConversionDegradationCollector();
    expect(projectToolRequest({
      source: "responses",
      candidates: [
        { kind: "tool_call", callId: "call_1", bindingKey: "function", item: call("call_1") },
        { kind: "tool_result", callId: "call_1", bindingKey: "function", item: result("call_1") },
      ],
      tools: [tool("lookup")],
      toolChoice: { kind: "tool", name: "lookup" },
      parallelToolCalls: false,
      degradations,
    })).toMatchObject({
      items: [call("call_1"), result("call_1")],
      toolChoice: { kind: "tool", name: "lookup" },
      parallelToolCalls: false,
    });
  });
});
