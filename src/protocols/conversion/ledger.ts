import { GatewayFailureError } from "../../gateway/failures.js";
import { isWireJsonObject, parseWireJson, type WireJsonObject } from "../../serialization/wire_json.js";
import { canonicalizeWireJson } from "../../serialization/canonical_json.js";
import type {
  SemanticOpaqueReasoningState,
  SemanticReasoningItem,
  SemanticMessagesReasoningState,
  SemanticReasoningPresentation,
  SemanticResponseItem,
  SemanticToolCallItem,
} from "./types.js";
import { responseMessagePartPosition, responseOutputIndex } from "./stream_keys.js";

interface ToolState {
  readonly key: string;
  readonly itemId?: string | undefined;
  readonly callId: string;
  readonly name: string;
  argumentsJson: string;
  done: boolean;
}

interface MessageState {
  readonly key: string;
  readonly partKeys: string[];
  frozen: boolean;
}

interface MessagePartState {
  readonly groupKey: string;
  text: string;
  refusal: string;
  textSeen: boolean;
  refusalSeen: boolean;
  frozen: boolean;
}

interface ReasoningState {
  readonly key: string;
  readonly itemId?: string | undefined;
  readonly partKeys: string[];
  status?: "completed" | "incomplete" | "in_progress" | undefined;
  frozen: boolean;
  messagesState?: SemanticMessagesReasoningState | undefined;
  opaqueState?: SemanticOpaqueReasoningState | undefined;
}

interface ReasoningPartState {
  readonly itemKey: string;
  readonly presentation: SemanticReasoningPresentation;
  readonly index: number;
  text: string;
  frozen: boolean;
}

export class SemanticItemLedger {
  private readonly encoder = new TextEncoder();
  private usedBytes = 0;
  private readonly tools = new Map<string, ToolState>();
  private readonly callIds = new Set<string>();
  private readonly messages = new Map<string, MessageState>();
  private readonly messageParts = new Map<string, MessagePartState>();
  private readonly reasoning = new Map<string, ReasoningState>();
  private readonly reasoningParts = new Map<string, ReasoningPartState>();
  private readonly order: Array<{ readonly kind: "message" | "reasoning" | "tool"; readonly key: string }> = [];

  constructor(private readonly maxBytes: number) {}

  startMessage(key: string): void {
    this.message(key);
  }

  appendText(key: string, delta: string, orderKey = key): void {
    this.reserve(delta);
    this.observeText(key, orderKey);
    const part = this.messagePart(key, orderKey);
    if (part.frozen) {
      invalid();
    }
    part.text += delta;
  }

  observeText(key: string, orderKey = key): boolean {
    const message = this.message(orderKey);
    if (message.frozen && !this.messageParts.has(key)) {
      invalid();
    }
    const part = this.messagePart(key, orderKey);
    const first = !part.textSeen;
    part.textSeen = true;
    return first;
  }

  appendRefusal(key: string, delta: string, orderKey = key): void {
    this.reserve(delta);
    this.observeRefusal(key, orderKey);
    const part = this.messagePart(key, orderKey);
    if (part.frozen) {
      invalid();
    }
    part.refusal += delta;
  }

  observeRefusal(key: string, orderKey = key): boolean {
    const message = this.message(orderKey);
    if (message.frozen && !this.messageParts.has(key)) {
      invalid();
    }
    const part = this.messagePart(key, orderKey);
    const first = !part.refusalSeen;
    part.refusalSeen = true;
    return first;
  }

  finishContent(key: string): void {
    const part = this.messageParts.get(key);
    if (part === undefined) {
      invalid();
    }
    part.frozen = true;
  }

  finishMessage(key: string): void {
    const message = this.message(key);
    message.frozen = true;
    for (const partKey of message.partKeys) {
      const part = this.messageParts.get(partKey);
      if (part !== undefined) {
        part.frozen = true;
      }
    }
  }

  startReasoning(
    key: string,
    itemId?: string,
    messagesState?: SemanticMessagesReasoningState,
    opaqueState?: SemanticOpaqueReasoningState,
  ): void {
    this.reasoningState(key, itemId, messagesState, opaqueState);
  }

  appendReasoning(input: {
    readonly key: string;
    readonly partKey: string;
    readonly itemId?: string | undefined;
    readonly presentation: SemanticReasoningPresentation;
    readonly partIndex: number;
    readonly delta: string;
  }): void {
    this.reserve(input.delta);
    const part = this.reasoningPart(input);
    if (part.frozen) {
      invalid();
    }
    part.text += input.delta;
  }

  reasoningValue(partKey: string): string {
    return this.reasoningParts.get(partKey)?.text ?? "";
  }

  finishReasoning(key: string, status: "completed" | "incomplete" | "in_progress"): SemanticReasoningItem {
    const reasoning = this.reasoning.get(key);
    if (reasoning === undefined) {
      invalid();
    }
    if (reasoning.frozen) {
      if (reasoning.status !== status) {
        invalid();
      }
      return this.reasoningItem(reasoning);
    }
    reasoning.frozen = true;
    reasoning.status = status;
    for (const partKey of reasoning.partKeys) {
      const part = this.reasoningParts.get(partKey);
      if (part !== undefined) {
        part.frozen = true;
      }
    }
    return this.reasoningItem(reasoning);
  }

  finishOpenReasoning(status: "completed" | "incomplete"): readonly SemanticReasoningItem[] {
    const items: SemanticReasoningItem[] = [];
    for (const entry of this.order) {
      if (entry.kind !== "reasoning") {
        continue;
      }
      const reasoning = this.reasoning.get(entry.key);
      if (reasoning !== undefined && !reasoning.frozen) {
        items.push(this.finishReasoning(entry.key, status));
      }
    }
    return items;
  }

  startTool(input: {
    readonly key: string;
    readonly itemId?: string | undefined;
    readonly callId: string;
    readonly name: string;
  }): void {
    if (
      this.tools.has(input.key)
      || this.callIds.has(input.callId)
      || input.callId.length === 0
      || input.name.length === 0
    ) {
      invalid();
    }
    this.reserve(input.key);
    if (input.itemId !== undefined) {
      this.reserve(input.itemId);
    }
    this.reserve(input.callId);
    this.reserve(input.name);
    this.callIds.add(input.callId);
    this.tools.set(input.key, { ...input, argumentsJson: "", done: false });
    this.order.push({ kind: "tool", key: input.key });
  }

  appendToolArguments(key: string, delta: string): void {
    const tool = this.tools.get(key);
    if (tool === undefined || tool.done) {
      invalid();
    }
    this.reserve(delta);
    tool.argumentsJson += delta;
  }

  finishTool(key: string, snapshot?: string, completed = false, validateCompleted = true): string {
    const tool = this.tools.get(key);
    if (tool === undefined) {
      invalid();
    }
    if (tool.done) {
      if (snapshot === undefined || snapshot === tool.argumentsJson) {
        if (completed && validateCompleted) {
          validateArguments(tool.argumentsJson);
        }
        return "";
      }
      invalid();
    }
    let suffix = "";
    if (snapshot !== undefined) {
      if (!snapshot.startsWith(tool.argumentsJson)) {
        invalid();
      }
      suffix = snapshot.slice(tool.argumentsJson.length);
      this.reserve(suffix);
      tool.argumentsJson = snapshot;
    }
    if (completed && validateCompleted) {
      validateArguments(tool.argumentsJson);
    }
    tool.done = true;
    return suffix;
  }

  finishOpenTools(validateCompleted: (name: string) => boolean = () => true): void {
    for (const tool of this.tools.values()) {
      if (validateCompleted(tool.name)) validateArguments(tool.argumentsJson);
      tool.done = true;
    }
  }

  toolKeys(): readonly string[] {
    return this.order.filter((entry) => entry.kind === "tool").map((entry) => entry.key);
  }

  tool(key: string): Readonly<ToolState> {
    const tool = this.tools.get(key);
    if (tool === undefined) {
      invalid();
    }
    return tool;
  }

  items(status: "completed" | "incomplete"): readonly SemanticResponseItem[] {
    const items: SemanticResponseItem[] = [];
    for (const entry of [...this.order].sort(compareResponseItemKeys)) {
      if (entry.kind === "message") {
        const message = this.messages.get(entry.key);
        if (message === undefined) {
          invalid();
        }
        const entries = [...message.partKeys].sort(compareMessagePartKeys).flatMap((key) => {
          const part = this.messageParts.get(key);
          if (part === undefined) {
            invalid();
          }
          return [
            ...(!part.textSeen ? [] : [{ key, part: { type: "text", text: part.text } as const }]),
            ...(!part.refusalSeen ? [] : [{ key, part: { type: "refusal", text: part.refusal } as const }]),
          ];
        });
        if (entries.length > 0 || message.frozen) {
          items.push({
            type: "message",
            key: entry.key,
            contentKeys: entries.map((item) => item.key),
            content: entries.map((item) => item.part),
          });
        }
        continue;
      }
      if (entry.kind === "reasoning") {
        const reasoning = this.reasoning.get(entry.key);
        if (reasoning === undefined) {
          invalid();
        }
        if (!reasoning.frozen) {
          reasoning.status = status;
          reasoning.frozen = true;
          for (const partKey of reasoning.partKeys) {
            const part = this.reasoningParts.get(partKey);
            if (part !== undefined) part.frozen = true;
          }
        }
        items.push(this.reasoningItem(reasoning));
        continue;
      }
      const tool = this.tool(entry.key);
      if (!tool.done && status === "completed") {
        invalid();
      }
      const item: SemanticToolCallItem = {
        type: "tool_call",
        key: entry.key,
        ...(tool.itemId === undefined ? {} : { itemId: tool.itemId }),
        callId: tool.callId,
        name: tool.name,
        argumentsJson: tool.argumentsJson,
      };
      items.push(item);
    }
    return items;
  }

  textValue(key: string): string {
    return this.messageParts.get(key)?.text ?? "";
  }

  refusalValue(key: string): string {
    return this.messageParts.get(key)?.refusal ?? "";
  }

  private reserve(value: string): void {
    this.usedBytes += this.encoder.encode(value).byteLength;
    if (this.usedBytes > this.maxBytes) {
      throw new GatewayFailureError({
        kind: "invalid_upstream_response",
        source: "converter",
        phase: "stream",
      });
    }
  }

  private message(key: string): MessageState {
    let message = this.messages.get(key);
    if (message === undefined) {
      this.reserve(key);
      message = { key, partKeys: [], frozen: false };
      this.messages.set(key, message);
      this.order.push({ kind: "message", key });
    }
    return message;
  }

  private messagePart(key: string, groupKey: string): MessagePartState {
    let part = this.messageParts.get(key);
    if (part === undefined) {
      if (key !== groupKey) {
        this.reserve(key);
      }
      part = {
        groupKey,
        text: "",
        refusal: "",
        textSeen: false,
        refusalSeen: false,
        frozen: false,
      };
      this.messageParts.set(key, part);
      this.message(groupKey).partKeys.push(key);
    } else if (part.groupKey !== groupKey) {
      invalid();
    }
    return part;
  }

  private reasoningItem(reasoning: ReasoningState): SemanticReasoningItem {
    const parts = reasoning.partKeys.map((partKey) => {
      const part = this.reasoningParts.get(partKey);
      if (part === undefined) {
        invalid();
      }
      return {
        key: partKey,
        presentation: part.presentation,
        index: part.index,
        text: part.text,
      };
    }).sort(compareReasoningParts);
    return {
      type: "reasoning",
      key: reasoning.key,
      ...(reasoning.itemId === undefined ? {} : { itemId: reasoning.itemId }),
      parts,
      ...(reasoning.status === undefined ? {} : { status: reasoning.status }),
      hasOpaqueState: reasoning.opaqueState !== undefined,
      ...(reasoning.messagesState === undefined ? {} : { messagesState: reasoning.messagesState }),
      ...(reasoning.opaqueState === undefined ? {} : { opaqueState: reasoning.opaqueState }),
    };
  }

  private reasoningPart(input: {
    readonly key: string;
    readonly partKey: string;
    readonly itemId?: string | undefined;
    readonly presentation: SemanticReasoningPresentation;
    readonly partIndex: number;
  }): ReasoningPartState {
    const reasoning = this.reasoningState(input.key, input.itemId);
    if (reasoning.frozen) {
      invalid();
    }
    let part = this.reasoningParts.get(input.partKey);
    if (part === undefined) {
      if (input.partKey !== input.key) this.reserve(input.partKey);
      part = {
        itemKey: input.key,
        presentation: input.presentation,
        index: input.partIndex,
        text: "",
        frozen: false,
      };
      this.reasoningParts.set(input.partKey, part);
      reasoning.partKeys.push(input.partKey);
    } else if (
      part.itemKey !== input.key
      || part.presentation !== input.presentation
      || part.index !== input.partIndex
    ) {
      invalid();
    }
    return part;
  }

  private reasoningState(
    key: string,
    itemId?: string,
    messagesState?: SemanticMessagesReasoningState,
    opaqueState?: SemanticOpaqueReasoningState,
  ): ReasoningState {
    let reasoning = this.reasoning.get(key);
    if (reasoning === undefined) {
      this.reserve(key);
      if (itemId !== undefined) this.reserve(itemId);
      if (messagesState?.type === "thinking") {
        this.reserve(messagesState.thinking);
        this.reserve(messagesState.signature);
      }
      if (messagesState?.type === "redacted_thinking") this.reserve(messagesState.data);
      if (opaqueState !== undefined) this.reserveOpaqueState(opaqueState);
      reasoning = {
        key,
        ...(itemId === undefined ? {} : { itemId }),
        partKeys: [],
        frozen: false,
        ...(messagesState === undefined ? {} : { messagesState }),
        ...(opaqueState === undefined ? {} : { opaqueState }),
      };
      this.reasoning.set(key, reasoning);
      this.order.push({ kind: "reasoning", key });
    } else if (reasoning.itemId !== itemId) {
      invalid();
    } else if (messagesState !== undefined) {
      if (reasoning.messagesState !== undefined && !sameMessagesState(reasoning.messagesState, messagesState)) invalid();
      if (reasoning.messagesState === undefined) {
        if (messagesState.type === "thinking") {
          this.reserve(messagesState.thinking);
          this.reserve(messagesState.signature);
        } else {
          this.reserve(messagesState.data);
        }
      }
      reasoning.messagesState = messagesState;
    }
    if (opaqueState !== undefined) {
      if (reasoning.opaqueState !== undefined && !sameOpaqueState(reasoning.opaqueState, opaqueState)) {
        if (reasoning.frozen && opaqueState.kind === "responses_item") {
          this.reserveOpaqueState(opaqueState);
        } else {
          invalid();
        }
      } else if (reasoning.opaqueState === undefined) {
        this.reserveOpaqueState(opaqueState);
      }
      reasoning.opaqueState = opaqueState;
    }
    return reasoning;
  }

  private reserveOpaqueState(state: SemanticOpaqueReasoningState): void {
    const value = state.kind === "responses_item" ? state.item
      : state.kind === "messages_block" ? state.block : state.state;
    this.usedBytes += canonicalizeWireJson(value).byteLength;
    if (this.usedBytes > this.maxBytes) {
      throw new GatewayFailureError({
        kind: "invalid_upstream_response",
        source: "converter",
        phase: "stream",
      });
    }
  }
}

function sameMessagesState(left: SemanticMessagesReasoningState, right: SemanticMessagesReasoningState): boolean {
  return left.type === right.type
    && (left.type === "thinking"
      ? left.thinking === (right as typeof left).thinking && left.signature === (right as typeof left).signature
      : left.data === (right as typeof left).data);
}

function sameOpaqueState(left: SemanticOpaqueReasoningState, right: SemanticOpaqueReasoningState): boolean {
  if (left.kind !== right.kind) return false;
  const leftValue = left.kind === "responses_item" ? normalizedResponseOpaqueItem(left.item)
    : left.kind === "messages_block" ? left.block : left.state;
  const rightValue = right.kind === "responses_item" ? normalizedResponseOpaqueItem(right.item)
    : right.kind === "messages_block" ? right.block : right.state;
  const leftBytes = canonicalizeWireJson(leftValue);
  const rightBytes = canonicalizeWireJson(rightValue);
  return leftBytes.byteLength === rightBytes.byteLength
    && leftBytes.every((value, index) => value === rightBytes[index]);
}

function normalizedResponseOpaqueItem(item: WireJsonObject): WireJsonObject {
  return {
    kind: "object",
    members: item.members.filter((member) => member.key !== "id" && member.key !== "status"),
  };
}

function compareResponseItemKeys(
  left: { readonly key: string },
  right: { readonly key: string },
): number {
  const leftIndex = responseOutputIndex(left.key);
  const rightIndex = responseOutputIndex(right.key);
  if (leftIndex === undefined || rightIndex === undefined) {
    return 0;
  }
  return leftIndex - rightIndex;
}

function compareMessagePartKeys(left: string, right: string): number {
  const leftPosition = responseMessagePartPosition(left);
  const rightPosition = responseMessagePartPosition(right);
  if (leftPosition === undefined || rightPosition === undefined) {
    return 0;
  }
  return leftPosition.contentIndex - rightPosition.contentIndex;
}

function compareReasoningParts(
  left: { readonly presentation: SemanticReasoningPresentation; readonly index: number },
  right: { readonly presentation: SemanticReasoningPresentation; readonly index: number },
): number {
  if (left.presentation !== right.presentation) {
    return left.presentation === "summary" ? -1 : 1;
  }
  return left.index - right.index;
}

function validateArguments(value: string): WireJsonObject {
  try {
    const bytes = new TextEncoder().encode(value);
    const parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 32 });
    if (!isWireJsonObject(parsed)) {
      invalid();
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({
      kind: "invalid_tool_arguments",
      source: "converter",
      phase: "stream",
      cause: error,
    });
  }
}

function invalid(): never {
  throw new GatewayFailureError({
    kind: "invalid_upstream_response",
    source: "converter",
    phase: "stream",
  });
}
