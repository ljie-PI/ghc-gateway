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
  text: string;
  refusal: string;
}

export class SemanticItemLedger {
  private readonly encoder = new TextEncoder();
  private usedBytes = 0;
  private readonly tools = new Map<string, ToolState>();
  private readonly messages = new Map<string, MessageState>();
  private readonly order: Array<{ readonly kind: "message" | "tool"; readonly key: string }> = [];

  constructor(private readonly maxBytes: number) {}

  appendText(key: string, delta: string): void {
    this.reserve(delta);
    this.message(key).text += delta;
  }

  appendRefusal(key: string, delta: string): void {
    this.reserve(delta);
    this.message(key).refusal += delta;
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

  finishTool(key: string, snapshot?: string): string {
    const tool = this.tools.get(key);
    if (tool === undefined) {
      invalid();
    }
    if (tool.done) {
      if (snapshot === undefined || snapshot === tool.argumentsJson) {
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
    for (const entry of this.order) {
      if (entry.kind === "message") {
        const message = this.messages.get(entry.key);
        if (message === undefined) {
          invalid();
        }
        const content = [
          ...(message.text.length === 0 ? [] : [{ type: "text", text: message.text } as const]),
          ...(message.refusal.length === 0 ? [] : [{ type: "refusal", text: message.refusal } as const]),
        ];
        if (content.length > 0) {
          items.push({ type: "message", key: entry.key, content });
        }
        continue;
      }
      const tool = this.tool(entry.key);
      if (!tool.done && status === "completed") {
        invalid();
      }
      const item: SemanticToolCallItem = {
        type: "tool_call",
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
    return this.messages.get(key)?.text ?? "";
  }

  refusalValue(key: string): string {
    return this.messages.get(key)?.refusal ?? "";
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
      message = { key, text: "", refusal: "" };
      this.messages.set(key, message);
      this.order.push({ kind: "message", key });
    }
    return message;
  }
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
