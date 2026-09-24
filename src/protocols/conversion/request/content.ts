import { isWireJsonArray, isWireJsonObject, parseWireJson, serializeWireJson, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { TOOL_RESULT_ERROR_MARKER, TOOL_RESULT_MEDIA_REPLACEMENT } from "../compatibility_markers.js";
import { containsReasoningCarrier, isReasoningCarrier } from "../reasoning_carriers.js";
import { projectIndependentOption } from "../request_projection.js";
import { type ConversionDegradationRule, type SemanticContent, type SemanticImage } from "../types.js";
import { invalid, oneMember, optionalString, requiredArray, requiredObject, requiredString, unsupported, wireArray, wireObject } from "../wire.js";
import { MESSAGES_SENSITIVE_EXTENSION_FIELDS, optionalDiscriminator, optionalProtocolObject, projectMessagesMembers, projectRequestMembers, requestObject, safeIndependentOption, validateCacheControl } from "./projection.js";

export function decodeChatContent(
  value: WireJson | undefined,
  textOnly: boolean,
  allowNull = false,
  degradations?: Set<ConversionDegradationRule>,
): readonly SemanticContent[] {
  if ((value === null || value === undefined) && allowNull) {
    return [];
  }
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  if (allowNull && !isWireJsonArray(value)) {
    if (value !== undefined && containsReasoningCarrier(value)) invalid("REQ-C-CONTENT");
    degradations?.add("request.option_omitted");
    return [];
  }
  const array = requiredArray(value, "REQ-C-CONTENT");
  return array.items.flatMap((item): readonly SemanticContent[] => {
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-C-CONTENT-BLOCK");
      degradations?.add("chat.extensions_omitted");
      return [];
    }
    let block = item;
    const type = optionalDiscriminator(
      oneMember(block, "type", "REQ-C-CONTENT-TYPE"),
      "REQ-C-CONTENT-TYPE",
      degradations ?? new Set(),
    );
    if (type === undefined) return [];
    if (type === "text") {
      block = projectRequestMembers(
        block,
        new Set(["type", "text"]),
        "REQ-C-TEXT",
        "chat.extensions_omitted",
        degradations ?? new Set(),
      );
      return [{
        type: "text",
        text: requiredString(oneMember(block, "text", "REQ-C-TEXT"), "REQ-C-TEXT", true),
      } as const];
    }
    if (type === "image_url" && !textOnly) {
      block = projectRequestMembers(
        block,
        new Set(["type", "image_url"]),
        "REQ-C-IMAGE",
        "chat.extensions_omitted",
        degradations ?? new Set(),
      );
      const image = projectRequestMembers(
        requestObject(oneMember(block, "image_url", "REQ-C-IMAGE"), "REQ-C-IMAGE"),
        new Set(["url", "detail"]),
        "REQ-C-IMAGE",
        "chat.extensions_omitted",
        degradations ?? new Set(),
      );
      return [imageContent(
        requiredString(oneMember(image, "url", "REQ-C-IMAGE-URL"), "REQ-C-IMAGE-URL"),
        optionalString(oneMember(image, "detail", "REQ-C-IMAGE-DETAIL"), "REQ-C-IMAGE-DETAIL"),
        "REQ-C-IMAGE",
        degradations,
      )];
    }
    (degradations ?? new Set()).add("chat.extensions_omitted");
    return [];
  });
}

export function decodeMessagesImage(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
  omission: "messages.extensions_omitted" | "responses.extensions_omitted" = "messages.extensions_omitted",
): SemanticImage | undefined {
  const rawSource = optionalProtocolObject(value, "REQ-M-IMAGE-SOURCE", degradations);
  if (rawSource === undefined) return undefined;
  let source = rawSource;
  const type = optionalDiscriminator(
    oneMember(source, "type", "REQ-M-IMAGE-SOURCE-TYPE"),
    "REQ-M-IMAGE-SOURCE-TYPE",
    degradations,
  );
  if (type === undefined) return undefined;
  if (type === "base64") {
    const allowed = new Set(["type", "media_type", "data"]);
    if (degradations !== undefined) {
      source = projectMessagesMembers(
        source,
        allowed,
        "REQ-M-IMAGE-SOURCE",
        degradations,
        MESSAGES_SENSITIVE_EXTENSION_FIELDS,
      );
    }
    const mediaType = requiredString(
      oneMember(source, "media_type", "REQ-M-IMAGE-MIME"),
      "REQ-M-IMAGE-MIME",
    );
    const data = requiredString(oneMember(source, "data", "REQ-M-IMAGE-DATA"), "REQ-M-IMAGE-DATA");
    return imageContent(`data:${mediaType};base64,${data}`, undefined, "REQ-M-IMAGE");
  }
  if (type === "url") {
    const allowed = new Set(["type", "url"]);
    if (degradations !== undefined) {
      source = projectMessagesMembers(
        source,
        allowed,
        "REQ-M-IMAGE-SOURCE",
        degradations,
        MESSAGES_SENSITIVE_EXTENSION_FIELDS,
      );
    }
    return imageContent(
      requiredString(oneMember(source, "url", "REQ-M-IMAGE-URL"), "REQ-M-IMAGE-URL"),
      undefined,
      "REQ-M-IMAGE",
    );
  }
  degradations.add(omission);
  return undefined;
}

export function decodeResponsesContent(
  value: WireJson | undefined,
  allowImage: boolean,
  assistant: boolean,
  degradations: Set<ConversionDegradationRule>,
): readonly SemanticContent[] {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  return requiredArray(value, "REQ-R-CONTENT").items.flatMap((item): readonly SemanticContent[] => {
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-R-CONTENT-BLOCK");
      degradations.add("responses.extensions_omitted");
      return [];
    }
    let block = item;
    const type = optionalDiscriminator(
      oneMember(block, "type", "REQ-R-CONTENT-TYPE"),
      "REQ-R-CONTENT-TYPE",
      degradations,
    );
    if (type === undefined) return [];
    if (type === "input_text" || type === "output_text" || type === "text") {
      block = projectRequestMembers(
        block,
        new Set(["type", "text", "annotations"]),
        "REQ-R-TEXT",
        "responses.extensions_omitted",
        degradations,
      );
      const annotations = oneMember(block, "annotations", "REQ-R-TEXT-ANNOTATIONS");
      if (annotations !== undefined) {
        const parsed = projectIndependentOption(
          safeIndependentOption(annotations, "REQ-R-TEXT-ANNOTATIONS"),
          (candidate) => isWireJsonArray(candidate) ? { kind: "value", value: candidate } : { kind: "malformed" },
          { omission: "request.option_omitted", degradations },
        );
        if (assistant && parsed !== undefined && parsed.items.length > 0) {
          degradations.add("request.option_omitted");
        }
        if (parsed === undefined) {
          block = { kind: "object", members: block.members.filter((member) => member.key !== "annotations") };
        }
        degradations.add("request.option_omitted");
      }
      return [{
        type: "text",
        text: requiredString(oneMember(block, "text", "REQ-R-TEXT"), "REQ-R-TEXT", true),
      } as const];
    }
    if (type === "refusal") {
      block = projectRequestMembers(
        block,
        new Set(["type", "refusal"]),
        "REQ-R-REFUSAL",
        "responses.extensions_omitted",
        degradations,
      );
      return [{
        type: "refusal",
        text: requiredString(oneMember(block, "refusal", "REQ-R-REFUSAL"), "REQ-R-REFUSAL", true),
      } as const];
    }
    if (type === "input_image" && allowImage) {
      block = projectRequestMembers(
        block,
        new Set(["type", "image_url", "detail"]),
        "REQ-R-IMAGE",
        "responses.extensions_omitted",
        degradations,
      );
      return [imageContent(
        requiredString(oneMember(block, "image_url", "REQ-R-IMAGE-URL"), "REQ-R-IMAGE-URL"),
        optionalString(oneMember(block, "detail", "REQ-R-IMAGE-DETAIL"), "REQ-R-IMAGE-DETAIL"),
        "REQ-R-IMAGE",
        degradations,
      )];
    }
    degradations.add("responses.extensions_omitted");
    return [];
  });
}

export function decodeToolResultContent(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
  messagesProjection = false,
): readonly SemanticContent[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.startsWith("data:image/")
      && new TextEncoder().encode(trimmed).byteLength >= 8192
    ) {
      return [imageContent(trimmed, undefined, "REQ-MEDIA-DATA-URL")];
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: WireJson | undefined;
      try {
        const bytes = new TextEncoder().encode(trimmed);
        parsed = parseWireJson(bytes, {
          maxBytes: bytes.byteLength,
          maxDepth: Math.min(Math.max(bytes.byteLength, 64), 4096),
        });
      } catch {
        // A non-protocol JSON-looking string remains ordinary tool text.
      }
      if (parsed !== undefined) {
        const extracted = extractEmbeddedToolMedia(parsed);
        if (extracted.media.length > 0) {
          return [
            {
              type: "text",
              text: new TextDecoder().decode(serializeWireJson(extracted.value)),
            },
            ...extracted.media,
          ];
        }
      }
    }
    return [{ type: "text", text: value }];
  }
  if (isWireJsonObject(value)) {
    const type = oneMember(value, "type", "REQ-TOOL-RESULT-TYPE");
    if (type === "image") {
      value = projectRequestMembers(
        value,
        new Set(["type", "source"]),
        "REQ-TOOL-RESULT-IMAGE",
        "responses.extensions_omitted",
        degradations,
      );
      const image = decodeMessagesImage(
        oneMember(value, "source", "REQ-TOOL-RESULT-IMAGE"),
        degradations,
        "responses.extensions_omitted",
      );
      return image === undefined ? [] : [image];
    }
    if (type === "input_image") {
      value = projectRequestMembers(
        value,
        new Set(["type", "image_url", "detail"]),
        "REQ-TOOL-RESULT-IMAGE",
        "responses.extensions_omitted",
        degradations,
      );
      return [imageContent(
        requiredString(
          oneMember(value, "image_url", "REQ-TOOL-RESULT-IMAGE-URL"),
          "REQ-TOOL-RESULT-IMAGE-URL",
        ),
        optionalString(
          oneMember(value, "detail", "REQ-TOOL-RESULT-IMAGE-DETAIL"),
          "REQ-TOOL-RESULT-IMAGE-DETAIL",
        ),
        "REQ-TOOL-RESULT-IMAGE",
        degradations,
      )];
    }
    if (type === "image_url") {
      value = projectRequestMembers(
        value,
        new Set(["type", "image_url"]),
        "REQ-TOOL-RESULT-IMAGE",
        "responses.extensions_omitted",
        degradations,
      );
      const image = projectRequestMembers(requiredObject(
        oneMember(value, "image_url", "REQ-TOOL-RESULT-IMAGE"),
        "REQ-TOOL-RESULT-IMAGE",
      ), new Set(["url", "detail"]), "REQ-TOOL-RESULT-IMAGE", "responses.extensions_omitted", degradations);
      return [imageContent(
        requiredString(oneMember(image, "url", "REQ-TOOL-RESULT-IMAGE-URL"), "REQ-TOOL-RESULT-IMAGE-URL"),
        optionalString(oneMember(image, "detail", "REQ-TOOL-RESULT-IMAGE-DETAIL"), "REQ-TOOL-RESULT-IMAGE-DETAIL"),
        "REQ-TOOL-RESULT-IMAGE",
        degradations,
      )];
    }
    const extracted = extractEmbeddedToolMedia(value);
    return [{
      type: "text",
      text: new TextDecoder().decode(serializeWireJson(extracted.value)),
    }, ...extracted.media];
  }

  function extractEmbeddedToolMedia(
    value: WireJson,
    depth = 0,
  ): { readonly value: WireJson; readonly media: readonly SemanticImage[] } {
    if (depth > 32) {
      return { value, media: [] };
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        trimmed.startsWith("data:image/")
        && new TextEncoder().encode(trimmed).byteLength >= 8192
      ) {
        return {
          value: TOOL_RESULT_MEDIA_REPLACEMENT,
          media: [imageContent(trimmed, undefined, "REQ-MEDIA-DATA-URL")],
        };
      }
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        let parsed: WireJson;
        try {
          const bytes = new TextEncoder().encode(trimmed);
          parsed = parseWireJson(bytes, {
            maxBytes: Math.max(bytes.byteLength, 1),
            maxDepth: Math.min(Math.max(bytes.byteLength, 64), 4096),
          });
        } catch {
          return { value, media: [] };
        }
        const extracted = extractEmbeddedToolMedia(parsed, depth + 1);
        if (extracted.media.length > 0) {
          return {
            value: new TextDecoder().decode(serializeWireJson(extracted.value)),
            media: extracted.media,
          };
        }
      }
      return { value, media: [] };
    }
    if (isWireJsonArray(value)) {
      const items: WireJson[] = [];
      const media: SemanticImage[] = [];
      for (const item of value.items) {
        const extracted = extractEmbeddedToolMedia(item, depth + 1);
        items.push(extracted.value);
        media.push(...extracted.media);
      }
      return { value: { kind: "array", items }, media };
    }
    if (!isWireJsonObject(value)) {
      return { value, media: [] };
    }
    const type = oneMember(value, "type", "REQ-TOOL-RESULT-EMBEDDED-TYPE");
    if (type === "image") {
      value = projectRequestMembers(
        value,
        new Set(["type", "source"]),
        "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
        "responses.extensions_omitted",
        degradations,
      );
      const image = decodeMessagesImage(
        oneMember(value, "source", "REQ-TOOL-RESULT-EMBEDDED-IMAGE"),
        degradations,
        "responses.extensions_omitted",
      );
      if (image === undefined) return { value, media: [] };
      return {
        value: TOOL_RESULT_MEDIA_REPLACEMENT,
        media: [image],
      };
    }
    if (type === "input_image") {
      value = projectRequestMembers(
        value,
        new Set(["type", "image_url", "detail"]),
        "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
        "responses.extensions_omitted",
        degradations,
      );
      return {
        value: TOOL_RESULT_MEDIA_REPLACEMENT,
        media: [imageContent(
          requiredString(
            oneMember(value, "image_url", "REQ-TOOL-RESULT-EMBEDDED-URL"),
            "REQ-TOOL-RESULT-EMBEDDED-URL",
          ),
          optionalString(
            oneMember(value, "detail", "REQ-TOOL-RESULT-EMBEDDED-DETAIL"),
            "REQ-TOOL-RESULT-EMBEDDED-DETAIL",
          ),
          "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
          degradations,
        )],
      };
    }
    if (type === "image_url") {
      value = projectRequestMembers(
        value,
        new Set(["type", "image_url"]),
        "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
        "responses.extensions_omitted",
        degradations,
      );
      const image = projectRequestMembers(requiredObject(
        oneMember(value, "image_url", "REQ-TOOL-RESULT-EMBEDDED-IMAGE"),
        "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
      ), new Set(["url", "detail"]), "REQ-TOOL-RESULT-EMBEDDED-IMAGE", "responses.extensions_omitted", degradations);
      return {
        value: TOOL_RESULT_MEDIA_REPLACEMENT,
        media: [imageContent(
          requiredString(
            oneMember(image, "url", "REQ-TOOL-RESULT-EMBEDDED-URL"),
            "REQ-TOOL-RESULT-EMBEDDED-URL",
          ),
          optionalString(
            oneMember(image, "detail", "REQ-TOOL-RESULT-EMBEDDED-DETAIL"),
            "REQ-TOOL-RESULT-EMBEDDED-DETAIL",
          ),
          "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
          degradations,
        )],
      };
    }
    const members: Array<{ key: string; value: WireJson }> = [];
    const media: SemanticImage[] = [];
    for (const member of value.members) {
      if (member.key !== "content") {
        members.push(member);
        continue;
      }
      const extracted = extractEmbeddedToolMedia(member.value, depth + 1);
      members.push({ key: member.key, value: extracted.value });
      media.push(...extracted.media);
    }
    return { value: { kind: "object", members }, media };
  }
  const array = requiredArray(value, "REQ-TOOL-RESULT-CONTENT");
  return array.items.flatMap((item): readonly SemanticContent[] => {
    const omission = messagesProjection ? "messages.extensions_omitted" : "responses.extensions_omitted";
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-TOOL-RESULT-BLOCK");
      degradations.add(omission);
      return [];
    }
    let block = item;
    const rawType = oneMember(block, "type", "REQ-TOOL-RESULT-TYPE");
    if (typeof rawType !== "string" || rawType.length === 0) {
      if (containsReasoningCarrier(block)) invalid("REQ-TOOL-RESULT-TYPE");
      degradations.add(omission);
      return [];
    }
    const type = rawType;
    if (type === "text" || type === "input_text") {
      const allowed = new Set(["type", "text", "cache_control"]);
      if (messagesProjection) {
        block = projectMessagesMembers(block, allowed, "REQ-TOOL-RESULT-TEXT", degradations);
      } else {
        block = projectRequestMembers(
          block,
          allowed,
          "REQ-TOOL-RESULT-TEXT",
          "responses.extensions_omitted",
          degradations,
        );
      }
      if (oneMember(block, "cache_control", "REQ-TOOL-RESULT-CACHE") !== undefined) {
        validateCacheControl(
          oneMember(block, "cache_control", "REQ-TOOL-RESULT-CACHE"),
          messagesProjection ? degradations : undefined,
        );
        degradations.add("cache.control_omitted");
      }
      return [{
        type: "text",
        text: requiredString(
          oneMember(block, "text", "REQ-TOOL-RESULT-TEXT"),
          "REQ-TOOL-RESULT-TEXT",
          true,
        ),
      } as const];
    }
    if (type === "image") {
      const allowed = new Set(["type", "source", "cache_control"]);
      if (messagesProjection) {
        block = projectMessagesMembers(block, allowed, "REQ-TOOL-RESULT-IMAGE", degradations);
      } else {
        block = projectRequestMembers(
          block,
          allowed,
          "REQ-TOOL-RESULT-IMAGE",
          "responses.extensions_omitted",
          degradations,
        );
      }
      if (oneMember(block, "cache_control", "REQ-TOOL-RESULT-CACHE") !== undefined) {
        validateCacheControl(
          oneMember(block, "cache_control", "REQ-TOOL-RESULT-CACHE"),
          messagesProjection ? degradations : undefined,
        );
        degradations.add("cache.control_omitted");
      }
      const image = decodeMessagesImage(
        oneMember(block, "source", "REQ-TOOL-RESULT-IMAGE"),
        degradations,
        messagesProjection ? "messages.extensions_omitted" : "responses.extensions_omitted",
      );
      return image === undefined ? [] : [image];
    }
    if (type === "input_image") {
      const allowed = new Set(["type", "image_url", "detail"]);
      if (messagesProjection) {
        block = projectMessagesMembers(block, allowed, "REQ-TOOL-RESULT-IMAGE", degradations);
      } else {
        block = projectRequestMembers(
          block,
          allowed,
          "REQ-TOOL-RESULT-IMAGE",
          "responses.extensions_omitted",
          degradations,
        );
      }
      return [imageContent(
        requiredString(
          oneMember(block, "image_url", "REQ-TOOL-RESULT-IMAGE-URL"),
          "REQ-TOOL-RESULT-IMAGE-URL",
        ),
        optionalString(
          oneMember(block, "detail", "REQ-TOOL-RESULT-IMAGE-DETAIL"),
          "REQ-TOOL-RESULT-IMAGE-DETAIL",
        ),
        "REQ-TOOL-RESULT-IMAGE",
        degradations,
      )];
    }
    degradations.add(omission);
    return [];
  });
}

export function encodeChatContent(content: readonly SemanticContent[]): WireJson {
  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }
  return wireArray(content.map((part) => {
    if (part.type === "text") {
      return wireObject([["type", "text"], ["text", part.text]]);
    }
    if (part.type === "image") {
      return encodeChatImage(part);
    }
    return wireObject([["type", "text"], ["text", part.text]]);
  }));
}

export function encodeChatImage(part: SemanticImage): WireJsonObject {
  return wireObject([
    ["type", "image_url"],
    ["image_url", wireObject([["url", part.url], ["detail", part.detail]])],
  ]);
}

export function encodeResponsesContent(content: SemanticContent, assistant: boolean): WireJsonObject {
  if (content.type === "image") {
    if (assistant) {
      unsupported("REQ-TARGET-R-ASSISTANT-IMAGE");
    }
    return wireObject([["type", "input_image"], ["image_url", content.url], ["detail", content.detail]]);
  }
  if (content.type === "refusal") {
    return wireObject([["type", "refusal"], ["refusal", content.text]]);
  }
  return wireObject([["type", assistant ? "output_text" : "input_text"], ["text", content.text]]);
}

export function encodeResponsesToolResultContent(
  content: readonly SemanticContent[],
  isError: boolean,
): WireJson {
  if (!isError && content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }
  return wireArray([
    ...(isError
      ? [wireObject([["type", "input_text"], ["text", TOOL_RESULT_ERROR_MARKER]])]
      : []),
    ...content.map((part) => encodeResponsesContent(part, false)),
  ]);
}

export function encodeMessagesContent(content: SemanticContent): WireJsonObject {
  if (content.type === "text") {
    return wireObject([["type", "text"], ["text", content.text]]);
  }
  if (content.type === "refusal") {
    return wireObject([["type", "text"], ["text", content.text]]);
  }
  const data = parseDataUrl(content.url);
  if (data !== undefined) {
    return wireObject([
      ["type", "image"],
      ["source", wireObject([
        ["type", "base64"],
        ["media_type", data.mediaType],
        ["data", data.data],
      ])],
    ]);
  }
  return wireObject([
    ["type", "image"],
    ["source", wireObject([["type", "url"], ["url", content.url]])],
  ]);
}

function imageContent(
  url: string,
  detail: string | undefined,
  ruleId: string,
  degradations?: Set<ConversionDegradationRule>,
): SemanticImage {
  if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
    if (isReasoningCarrier(detail)) invalid(ruleId);
    degradations?.add("request.option_omitted");
    detail = undefined;
  }
  if (parseDataUrl(url) === undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      invalid(ruleId);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      unsupported(ruleId);
    }
  }
  return {
    type: "image",
    url,
    ...(detail === undefined ? {} : { detail }),
  };
}

function parseDataUrl(url: string): { readonly mediaType: string; readonly data: string } | undefined {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(url);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { mediaType: match[1], data: match[2] };
}

export function textContent(content: readonly SemanticContent[]): string | undefined {
  const text = content
    .filter((part): part is Extract<SemanticContent, { readonly type: "text" | "refusal" }> => (
      part.type === "text" || part.type === "refusal"
    ))
    .map((part) => part.text)
    .join("");
  return text.length === 0 ? undefined : text;
}

export function toolResultText(text: string, isError: boolean): string {
  return isError
    ? `${TOOL_RESULT_ERROR_MARKER}${text.length === 0 ? "" : `\n${text}`}`
    : text;
}
