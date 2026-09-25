import { GatewayFailureError } from "../../../gateway/failures.js";
import { isWireJsonObject, memberValues, parseWireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import type {
  ResponsesToolBindingLedger,
  ResponsesToolSourceBinding,
  SemanticToolCallItem,
} from "../types.js";
import { wireNumber, wireObject } from "../wire.js";
import { object } from "./responses_extended_tool_shared.js";

export interface RestoredExtendedToolArguments {
  readonly rawCustomInput?: string;
  readonly toolSearchArguments?: WireJsonObject;
  readonly degraded: boolean;
}

export type ResponsesToolStreamEventFamily = "function" | "custom" | "none";

interface ResponseToolItemInput {
  readonly itemId?: string | undefined;
  readonly callId: string;
  readonly status: "in_progress" | "completed" | "incomplete" | "failed";
  readonly argumentsJson: string;
  readonly restored?: RestoredExtendedToolArguments | undefined;
}

interface ResponseToolStreamInput {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly argumentsJson: string;
  readonly restored?: RestoredExtendedToolArguments | undefined;
  readonly nextSequence: () => number;
}

export interface ResponsesToolRestorationPolicy {
  readonly sourceKind: ResponsesToolSourceBinding["kind"];
  readonly sourceName: string;
  readonly namespace?: string | undefined;
  readonly fromExtendedRequest: boolean;
  readonly allowsLooseArguments: boolean;
  readonly streamEventFamily: ResponsesToolStreamEventFamily;
  itemId(provided: string | undefined, callId: string, createUuid: () => string): string | undefined;
  restoreArguments(argumentsJson: string): RestoredExtendedToolArguments;
  restoreSemanticItem(
    item: Readonly<SemanticToolCallItem>,
    restored: Readonly<RestoredExtendedToolArguments>,
  ): SemanticToolCallItem;
  responseItem(input: Readonly<ResponseToolItemInput>): WireJsonObject;
  argumentDeltaEvent(
    itemId: string,
    outputIndex: number,
    delta: string,
    sequence: number,
  ): WireJsonObject | undefined;
  argumentDoneEvents(input: Readonly<ResponseToolStreamInput>): readonly WireJsonObject[];
}

class ToolRestorationPolicy implements ResponsesToolRestorationPolicy {
  readonly sourceKind: ResponsesToolSourceBinding["kind"];
  readonly sourceName: string;
  readonly namespace?: string | undefined;
  readonly allowsLooseArguments: boolean;
  readonly streamEventFamily: ResponsesToolStreamEventFamily;

  constructor(
    binding: Readonly<ResponsesToolSourceBinding> | undefined,
    chatName: string,
    readonly fromExtendedRequest: boolean,
  ) {
    this.sourceKind = binding?.kind ?? "function";
    this.sourceName = binding?.sourceName ?? chatName;
    this.namespace = binding?.namespace;
    this.allowsLooseArguments = this.sourceKind === "custom" || this.sourceKind === "tool_search";
    this.streamEventFamily = this.sourceKind === "custom"
      ? "custom"
      : this.sourceKind === "tool_search" ? "none" : "function";
  }

  itemId(provided: string | undefined, callId: string, createUuid: () => string): string | undefined {
    if (provided !== undefined) return provided;
    if (this.sourceKind === "custom") return "ctc_" + callId;
    if (this.sourceKind === "tool_search") return undefined;
    return this.fromExtendedRequest ? "fc_" + callId : "fc_" + createUuid();
  }

  restoreArguments(argumentsJson: string): RestoredExtendedToolArguments {
    if (this.sourceKind === "custom") {
      if (argumentsJson.trim().length === 0) {
        return { rawCustomInput: "", degraded: false };
      }
      try {
        const parsed = parseUpstreamArguments(argumentsJson);
        const inputs = memberValues(parsed, "input");
        if (inputs.length === 1 && typeof inputs[0] === "string") {
          return { rawCustomInput: inputs[0], degraded: false };
        }
      } catch {
        // Preserve the upstream argument text when it is not the synthetic custom-tool wrapper.
      }
      return { rawCustomInput: argumentsJson, degraded: true };
    }
    if (this.sourceKind === "tool_search") {
      if (argumentsJson.trim().length === 0) {
        return { toolSearchArguments: object([]), degraded: false };
      }
      try {
        return { toolSearchArguments: parseUpstreamArguments(argumentsJson), degraded: false };
      } catch {
        return { toolSearchArguments: object([["query", argumentsJson]]), degraded: true };
      }
    }
    return { degraded: false };
  }

  restoreSemanticItem(
    item: Readonly<SemanticToolCallItem>,
    restored: Readonly<RestoredExtendedToolArguments>,
  ): SemanticToolCallItem {
    return {
      ...item,
      sourceKind: this.sourceKind,
      sourceName: this.sourceName,
      ...(this.namespace === undefined ? {} : { namespace: this.namespace }),
      ...(restored.rawCustomInput === undefined ? {} : { rawCustomInput: restored.rawCustomInput }),
      ...(restored.toolSearchArguments === undefined ? {} : { toolSearchArguments: restored.toolSearchArguments }),
    };
  }

  responseItem(input: Readonly<ResponseToolItemInput>): WireJsonObject {
    if (this.sourceKind === "custom") {
      const restoredInput = input.status === "in_progress"
        ? ""
        : input.restored?.rawCustomInput ?? input.argumentsJson;
      return wireObject([
        ["type", "custom_tool_call"],
        ["id", input.itemId],
        ["call_id", input.callId],
        ["name", this.sourceName],
        ["status", input.status],
        ["input", restoredInput],
      ]);
    }
    if (this.sourceKind === "tool_search") {
      return wireObject([
        ["type", "tool_search_call"],
        ["id", input.itemId],
        ["call_id", input.callId],
        ["status", input.status],
        ["execution", "client"],
        ["arguments", input.status === "in_progress"
          ? wireObject([])
          : input.restored?.toolSearchArguments ?? wireObject([["query", input.argumentsJson]])],
      ]);
    }
    return wireObject([
      ["type", "function_call"],
      ["id", input.itemId],
      ["call_id", input.callId],
      ["name", this.sourceName],
      ["namespace", this.namespace],
      ["arguments", input.argumentsJson],
      ["status", input.status],
    ]);
  }

  argumentDeltaEvent(
    itemId: string,
    outputIndex: number,
    delta: string,
    sequence: number,
  ): WireJsonObject | undefined {
    if (this.streamEventFamily !== "function") return undefined;
    return wireObject([
      ["type", "response.function_call_arguments.delta"],
      ["sequence_number", wireNumber(sequence)],
      ["item_id", itemId],
      ["output_index", wireNumber(outputIndex)],
      ["delta", delta],
    ]);
  }

  argumentDoneEvents(input: Readonly<ResponseToolStreamInput>): readonly WireJsonObject[] {
    if (this.streamEventFamily === "none") return [];
    if (this.streamEventFamily === "custom") {
      const value = input.restored?.rawCustomInput ?? "";
      return [
        ...(value.length === 0 ? [] : [wireObject([
          ["type", "response.custom_tool_call_input.delta"],
          ["sequence_number", wireNumber(input.nextSequence())],
          ["item_id", input.itemId],
          ["output_index", wireNumber(input.outputIndex)],
          ["delta", value],
        ])]),
        wireObject([
          ["type", "response.custom_tool_call_input.done"],
          ["sequence_number", wireNumber(input.nextSequence())],
          ["item_id", input.itemId],
          ["output_index", wireNumber(input.outputIndex)],
          ["input", value],
        ]),
      ];
    }
    return [wireObject([
      ["type", "response.function_call_arguments.done"],
      ["sequence_number", wireNumber(input.nextSequence())],
      ["item_id", input.itemId],
      ["output_index", wireNumber(input.outputIndex)],
      ["name", this.sourceName],
      ["arguments", input.argumentsJson],
    ])];
  }
}

export function createResponsesToolRestorationPolicy(
  binding: Readonly<ResponsesToolSourceBinding> | undefined,
  chatName: string,
  fromExtendedRequest: boolean,
): ResponsesToolRestorationPolicy {
  return new ToolRestorationPolicy(binding, chatName, fromExtendedRequest);
}

export function resolveResponsesToolRestorationPolicy(
  ledger: Readonly<ResponsesToolBindingLedger> | undefined,
  chatName: string,
  duplicateBinding: () => never = invalidUpstream,
): ResponsesToolRestorationPolicy {
  const matches = ledger?.bindings.filter((binding) => binding.chatName === chatName) ?? [];
  if (matches.length > 1) duplicateBinding();
  return createResponsesToolRestorationPolicy(matches[0], chatName, ledger !== undefined);
}

export function responsesToolRestorationPolicyForItem(
  item: Readonly<SemanticToolCallItem>,
): ResponsesToolRestorationPolicy {
  const binding = item.sourceKind === undefined ? undefined : {
    kind: item.sourceKind,
    chatName: item.name,
    sourceName: item.sourceName ?? item.name,
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
  } satisfies ResponsesToolSourceBinding;
  return createResponsesToolRestorationPolicy(binding, item.name, item.sourceKind !== undefined);
}

function parseUpstreamArguments(value: string): WireJsonObject {
  try {
    const bytes = new TextEncoder().encode(value);
    const parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 32 });
    if (!isWireJsonObject(parsed)) invalidToolArguments();
    if (parsed.members.some((member, index) => parsed.members.findIndex((other) => other.key === member.key) !== index)) {
      invalidToolArguments();
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) throw error;
    invalidToolArguments();
  }
}

function invalidUpstream(): never {
  throw new GatewayFailureError({
    kind: "invalid_upstream_response",
    source: "converter",
    phase: "convert",
  });
}

function invalidToolArguments(): never {
  throw new GatewayFailureError({
    kind: "invalid_tool_arguments",
    source: "converter",
    phase: "convert",
  });
}
