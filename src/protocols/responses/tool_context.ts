import { createHash } from "node:crypto";
import { canonicalizeWireJson } from "../../serialization/canonical_json.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type { ResponsesRequest } from "./dto.js";

export type ToolBindingKind = "function" | "namespace" | "custom" | "tool_search";

export interface ToolBinding {
  readonly kind: ToolBindingKind;
  readonly originalName: string;
  readonly namespace?: string;
}

export interface RequestToolContext {
  readonly chatTools: readonly WireJsonObject[];
  readonly seenChatNames: ReadonlySet<string>;
  readonly chatNameToBinding: ReadonlyMap<string, ToolBinding>;
  readonly sourceNameToChatName: ReadonlyMap<string, string>;
}

interface MutableToolContext {
  readonly chatTools: WireJsonObject[];
  readonly seenChatNames: Set<string>;
  readonly chatNameToBinding: Map<string, ToolBinding>;
  readonly sourceNameToChatName: Map<string, string>;
}

const CUSTOM_INPUT_SCHEMA: WireJsonObject = object([
  ["type", "object"],
  ["properties", object([
    ["input", object([
      ["type", "string"],
      ["description", "Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description."],
    ])],
  ])],
  ["required", array(["input"])],
]);

const TOOL_SEARCH_SCHEMA: WireJsonObject = object([
  ["type", "object"],
  ["properties", object([
    ["query", object([
      ["type", "string"],
      ["description", "Search query for tools or connectors to load."],
    ])],
    ["limit", object([
      ["type", "integer"],
      ["description", "Maximum number of tool groups to return."],
    ])],
  ])],
  ["required", array(["query"])],
]);

const TOOL_SEARCH_DESCRIPTION = "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.";

export function buildRequestToolContext(request: Readonly<ResponsesRequest>): RequestToolContext {
  const context: MutableToolContext = {
    chatTools: [],
    seenChatNames: new Set<string>(),
    chatNameToBinding: new Map<string, ToolBinding>(),
    sourceNameToChatName: new Map<string, string>(),
  };

  const tools = memberValues(request.body, "tools")[0];
  if (isWireJsonArray(tools)) {
    for (const tool of tools.items) {
      addToolDeclaration(context, tool);
    }
  }
  collectToolSearchDeclarations(context, request.input);

  return {
    chatTools: context.chatTools,
    seenChatNames: context.seenChatNames,
    chatNameToBinding: context.chatNameToBinding,
    sourceNameToChatName: context.sourceNameToChatName,
  };
}

export function sourceToolKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? ""}\u0000${name}`;
}

export function chatNameForSource(
  context: RequestToolContext,
  namespace: string | undefined,
  name: string,
): string | undefined {
  return context.sourceNameToChatName.get(sourceToolKey(namespace, name));
}

function addToolDeclaration(context: MutableToolContext, value: WireJson): void {
  if (typeof value === "string") {
    addCustomTool(context, value, value);
    return;
  }
  if (!isWireJsonObject(value)) {
    return;
  }
  const type = memberValues(value, "type")[0];
  if (type === "function" || (type === undefined && functionShape(value) !== undefined)) {
    addFunctionTool(context, value, undefined);
    return;
  }
  if (type === "namespace") {
    addNamespaceTool(context, value);
    return;
  }
  if (type === "custom") {
    const name = stringMember(value, "name")?.trim() ?? "";
    addCustomTool(context, name, value);
    return;
  }
  if (type === "tool_search") {
    addToolSearch(context);
  }
}

function addFunctionTool(context: MutableToolContext, tool: WireJsonObject, namespace: string | undefined): void {
  const shape = functionShape(tool);
  if (shape === undefined) {
    return;
  }
  const originalName = stringMember(shape, "name")?.trim() ?? "";
  if (originalName.length === 0) {
    return;
  }
  const chatName = namespace === undefined ? originalName : hashedNamespaceName(namespace, originalName);
  const parameters = cleanupFunctionParameters(memberValues(shape, "parameters")[0]);
  const description = memberValues(shape, "description")[0] ?? null;
  const nestedStrict = memberValues(shape, "strict")[0];
  const strict = nestedStrict === undefined ? memberValues(tool, "strict")[0] : nestedStrict;
  const functionMembers: Array<readonly [string, WireJson]> = [
    ["name", chatName],
    ["description", description],
    ["parameters", parameters],
  ];
  if (strict === true || strict === false) {
    functionMembers.push(["strict", strict]);
  }
  addChatTool(context, chatName, {
    kind: namespace === undefined ? "function" : "namespace",
    originalName,
    ...(namespace === undefined ? {} : { namespace }),
  }, object([
    ["type", "function"],
    ["function", object(functionMembers)],
  ]));
  context.sourceNameToChatName.set(sourceToolKey(namespace, originalName), chatName);
}

function addNamespaceTool(context: MutableToolContext, tool: WireJsonObject): void {
  const namespace = stringMember(tool, "name") ?? "";
  const children = arrayMember(tool, "tools") ?? arrayMember(tool, "children");
  if (children === undefined) {
    return;
  }
  for (const child of children.items) {
    if (isWireJsonObject(child) && memberValues(child, "type")[0] === "function") {
      addFunctionTool(context, child, namespace);
    }
  }
}

function addCustomTool(context: MutableToolContext, name: string, original: WireJson): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return;
  }
  addChatTool(context, trimmed, { kind: "custom", originalName: trimmed }, object([
    ["type", "function"],
    ["function", object([
      ["name", trimmed],
      ["description", `Original tool definition:\n\`\`\`json\n${canonicalString(original)}\n\`\`\``],
      ["parameters", CUSTOM_INPUT_SCHEMA],
    ])],
  ]));
  context.sourceNameToChatName.set(sourceToolKey(undefined, trimmed), trimmed);
}

function addToolSearch(context: MutableToolContext): void {
  addChatTool(context, "tool_search", { kind: "tool_search", originalName: "tool_search" }, object([
    ["type", "function"],
    ["function", object([
      ["name", "tool_search"],
      ["description", TOOL_SEARCH_DESCRIPTION],
      ["parameters", TOOL_SEARCH_SCHEMA],
    ])],
  ]));
  context.sourceNameToChatName.set(sourceToolKey(undefined, "tool_search"), "tool_search");
}

function addChatTool(
  context: MutableToolContext,
  chatName: string,
  binding: ToolBinding,
  tool: WireJsonObject,
): void {
  if (context.seenChatNames.has(chatName)) {
    return;
  }
  context.seenChatNames.add(chatName);
  context.chatNameToBinding.set(chatName, binding);
  context.chatTools.push(tool);
}

function functionShape(tool: WireJsonObject): WireJsonObject | undefined {
  const nested = memberValues(tool, "function")[0];
  if (isWireJsonObject(nested)) {
    return nested;
  }
  return tool;
}

function cleanupFunctionParameters(value: WireJson | undefined): WireJsonObject {
  if (!isWireJsonObject(value)) {
    return object([
      ["type", "object"],
      ["properties", object([])],
    ]);
  }
  const members = value.members.filter((member) => member.key !== "type");
  return {
    kind: "object",
    members: [{ key: "type", value: "object" }, ...members],
  };
}

function collectToolSearchDeclarations(context: MutableToolContext, value: WireJson | undefined, depth = 0): void {
  if (value === undefined || depth > 32) {
    return;
  }
  if (isWireJsonArray(value)) {
    for (const item of value.items) {
      collectToolSearchDeclarations(context, item, depth + 1);
    }
    return;
  }
  if (!isWireJsonObject(value)) {
    return;
  }
  if (memberValues(value, "type")[0] === "tool_search_output") {
    const tools = arrayMember(value, "tools");
    if (tools !== undefined) {
      for (const tool of tools.items) {
        addToolDeclaration(context, tool);
      }
    }
  }
  for (const member of value.members) {
    collectToolSearchDeclarations(context, member.value, depth + 1);
  }
}

function hashedNamespaceName(namespace: string, childName: string): string {
  const full = `${namespace}__${childName}`;
  if (new TextEncoder().encode(full).byteLength <= 64) {
    return full;
  }
  const suffix = `__${createHash("sha256").update(full).digest("hex").slice(0, 16)}`;
  const maxPrefixBytes = 64 - new TextEncoder().encode(suffix).byteLength;
  let prefix = "";
  for (const char of full) {
    const next = `${prefix}${char}`;
    if (new TextEncoder().encode(next).byteLength > maxPrefixBytes) {
      break;
    }
    prefix = next;
  }
  return `${prefix}${suffix}`;
}

function canonicalString(value: WireJson): string {
  return new TextDecoder().decode(canonicalizeWireJson(value));
}

function stringMember(object: WireJsonObject, key: string): string | undefined {
  const value = memberValues(object, key)[0];
  return typeof value === "string" ? value : undefined;
}

function arrayMember(object: WireJsonObject, key: string) {
  const value = memberValues(object, key)[0];
  return isWireJsonArray(value) ? value : undefined;
}

function object(members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return { kind: "object", members: members.map(([key, value]) => ({ key, value })) };
}

function array(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}
