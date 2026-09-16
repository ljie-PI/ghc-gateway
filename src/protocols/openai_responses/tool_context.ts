import type { ResponsesRequest } from "./dto.js";
import {
  projectResponsesToolsForCompatibility,
  type ResponsesToolCompatibilityProjection,
} from "../conversion/responses_extended_tools.js";
import type { WireJsonObject } from "../../serialization/wire_json.js";

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

/**
 * Compatibility adapter for retired bridge fixtures. Extended declaration
 * projection is owned by the production conversion module.
 */
export function buildRequestToolContext(request: Readonly<ResponsesRequest>): RequestToolContext {
  return compatibilityContext(projectResponsesToolsForCompatibility(request.body));
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

function compatibilityContext(projection: ResponsesToolCompatibilityProjection): RequestToolContext {
  const chatNameToBinding = new Map<string, ToolBinding>();
  const sourceNameToChatName = new Map<string, string>();
  for (const binding of projection.bindings) {
    chatNameToBinding.set(binding.chatName, {
      kind: binding.kind,
      originalName: binding.sourceName,
      ...(binding.namespace === undefined ? {} : { namespace: binding.namespace }),
    });
    sourceNameToChatName.set(sourceToolKey(binding.namespace, binding.sourceName), binding.chatName);
  }
  return {
    chatTools: projection.chatTools,
    seenChatNames: new Set(chatNameToBinding.keys()),
    chatNameToBinding,
    sourceNameToChatName,
  };
}
