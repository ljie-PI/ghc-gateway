import { GatewayFailureError } from "../../gateway/failures.js";
import { isWireJsonObject, parseWireJson, type WireJsonObject } from "../../serialization/wire_json.js";
import type { SemanticResponseItem, SemanticToolCallItem } from "./types.js";

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

export class SemanticItemLedger {
  private readonly encoder = new TextEncoder();
  private usedBytes = 0;
  private readonly tools = new Map<string, ToolState>();
  private readonly messages = new Map<string, MessageState>();
  private readonly messageParts = new Map<string, MessagePartState>();
  private readonly order: Array<{ readonly kind: "message" | "tool"; readonly key: string }> = [];

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

  startTool(input: {
    readonly key: string;
    readonly itemId?: string | undefined;
    readonly callId: string;
    readonly name: string;
  }): void {
    if (this.tools.has(input.key) || input.callId.length === 0 || input.name.length === 0) {
      invalid();
    }
    this.reserve(input.key);
    if (input.itemId !== undefined) {
      this.reserve(input.itemId);
    }
    this.reserve(input.callId);
    this.reserve(input.name);
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

  finishTool(key: string, snapshot?: string, completed = false): string {
    const tool = this.tools.get(key);
    if (tool === undefined) {
      invalid();
    }
    if (tool.done) {
      if (snapshot === undefined || snapshot === tool.argumentsJson) {
        if (completed) {
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
    if (completed) {
      validateArguments(tool.argumentsJson);
    }
    tool.done = true;
    return suffix;
  }

  finishOpenTools(): void {
    for (const tool of this.tools.values()) {
      validateArguments(tool.argumentsJson);
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
}

function compareResponseItemKeys(
  left: { readonly key: string },
  right: { readonly key: string },
): number {
  const leftMatch = /^responses:(\d+)(?::|$)/u.exec(left.key);
  const rightMatch = /^responses:(\d+)(?::|$)/u.exec(right.key);
  if (leftMatch?.[1] === undefined || rightMatch?.[1] === undefined) {
    return 0;
  }
  return Number.parseInt(leftMatch[1], 10) - Number.parseInt(rightMatch[1], 10);
}

function compareMessagePartKeys(left: string, right: string): number {
  const leftMatch = /^responses:\d+:(\d+):/u.exec(left);
  const rightMatch = /^responses:\d+:(\d+):/u.exec(right);
  if (leftMatch?.[1] === undefined || rightMatch?.[1] === undefined) {
    return 0;
  }
  return Number.parseInt(leftMatch[1], 10) - Number.parseInt(rightMatch[1], 10);
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
