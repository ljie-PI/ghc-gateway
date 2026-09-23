import { GatewayFailureError } from "../../gateway/failures.js";
import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { isReasoningCarrier } from "../conversion/reasoning_carriers.js";
import { RequestSequenceTracker } from "../conversion/request_sequence.js";

const TOP_LEVEL_CORE = [
  "model", "messages", "system", "max_tokens", "stream", "temperature", "top_p", "top_k",
  "stop_sequences", "tools", "tool_choice", "thinking", "output_config", "metadata",
] as const;
const OWNERSHIP_FIELDS = new Set([
  "call_id", "data", "encrypted_content", "previous_response_id", "reasoning", "reasoning_content", "reasoning_details",
  "reasoning_items", "reasoning_text", "signature", "thinking_blocks", "tool_call_id", "tool_use_id",
  "thinking", "redacted_thinking",
]);
const NESTED_RESULT_OWNERSHIP_FIELDS = new Set([
  "call_id", "encrypted_content", "previous_response_id", "reasoning_content", "reasoning_details",
  "reasoning_items", "reasoning_text", "signature", "thinking_blocks", "tool_call_id", "tool_use_id",
]);
const SERVER_TOOL_RESULT_TYPES = new Set([
  "advisor_tool_result",
  "bash_code_execution_tool_result",
  "code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "web_fetch_tool_result",
  "web_search_tool_result",
  "mcp_tool_result",
]);
const BROWSER_TOOL_NAMES = new Set([
  "close_tab", "double_click", "file_upload", "find", "form_input", "get_page_text", "hold_key", "hover",
  "javascript_exec", "key", "left_click", "left_click_drag", "left_mouse_down", "left_mouse_up", "list_tabs",
  "middle_click", "mouse_move", "navigate", "new_tab", "read_console", "read_network", "read_page", "right_click",
  "screenshot", "scroll", "scroll_to", "switch_tab", "triple_click", "type", "wait", "zoom",
]);
const COMPUTER_TOOL_NAMES = new Set([
  "cursor_position", "double_click", "hold_key", "key", "left_click", "left_click_drag", "left_mouse_down",
  "left_mouse_up", "middle_click", "mouse_move", "right_click", "screenshot", "scroll", "triple_click", "type", "wait", "zoom",
]);

interface NativeToolRegistry {
  readonly names: ReadonlySet<string>;
  readonly browserMembers: ReadonlySet<string>;
  readonly computerMembers: ReadonlySet<string>;
  readonly mcpToolsets: ReadonlySet<string>;
  readonly hasTools: boolean;
}

interface NativeCallBinding {
  readonly resultType: string;
  readonly toolsetName?: string;
}

export function validateMessagesRequestSecurity(body: WireJsonObject): void {
  rejectSelectedDuplicates(body, [...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(body, new Set(["thinking"]));
  rejectCarrierOutsideDocumentedSlots(body, new Set());
}

export function validateNativeMessagesRequestEnvelope(body: WireJsonObject): void {
  rejectDuplicates(body, TOP_LEVEL_CORE);
  rejectUnexpectedOwnership(body, new Set(["thinking"]));
  optionalString(body, "model");
  optionalPositiveInteger(body, "max_tokens");
  optionalBoolean(body, "stream");
  optionalNumber(body, "temperature", 0, 1);
  optionalNumber(body, "top_p", 0, 1);
  optionalPositiveInteger(body, "top_k");
  validateStringList(optionalOne(body, "stop_sequences"));
  validateSystem(optionalOne(body, "system"));
  validateThinkingConfig(optionalOne(body, "thinking"));
  const tools = validateTools(optionalOne(body, "tools"));
  validateToolChoice(optionalOne(body, "tool_choice"), tools);
  validateOutputConfig(optionalOne(body, "output_config"));
  validateObjectCore(optionalOne(body, "metadata"), ["user_id"]);

  const messages = exactlyOne(body, "messages");
  if (!isWireJsonArray(messages)) invalid();

  const sequence = new RequestSequenceTracker<NativeCallBinding>(() => invalid());
  for (const value of messages.items) {
    const message = object(value);
    rejectDuplicates(message, ["role", "content", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(message, new Set());
    const role = exactlyOne(message, "role");
    if (role !== "user" && role !== "assistant") invalid();
    const content = exactlyOne(message, "content");
    if (typeof content === "string") {
      sequence.observeMessage(role);
      continue;
    }
    if (!isWireJsonArray(content)) invalid();

    let ordinary = false;
    for (const valueBlock of content.items) {
      const block = object(valueBlock);
      const type = exactlyOne(block, "type");
      if (typeof type !== "string" || type.length === 0) invalid();
      if (type === "text" || type === "image") {
        validateContentBlock(block, type, role, sequence, tools);
        ordinary = true;
        continue;
      }
      if (ordinary) {
        sequence.observeMessage(role);
        ordinary = false;
      }
      validateContentBlock(block, type, role, sequence, tools);
    }
    if (ordinary) sequence.observeMessage(role);
  }
  sequence.finish();
}

function validateContentBlock(
  block: WireJsonObject,
  type: string,
  role: "user" | "assistant",
  sequence: RequestSequenceTracker<NativeCallBinding>,
  tools: NativeToolRegistry,
): void {
  if (type === "text") {
    rejectDuplicates(block, ["type", "text", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set());
    if (typeof exactlyOne(block, "text") !== "string") invalid();
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  if (type === "image") {
    if (role !== "user") invalid();
    rejectDuplicates(block, ["type", "source", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set());
    validateImageSource(exactlyOne(block, "source"));
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  if (type === "tool_use") {
    rejectDuplicates(block, ["type", "id", "name", "input", "toolset_name", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set());
    const id = exactlyOne(block, "id");
    const input = exactlyOne(block, "input");
    const name = exactlyOne(block, "name");
    if (
      role !== "assistant"
      || typeof id !== "string"
      || id.length === 0
      || typeof name !== "string"
      || name.length === 0
      || !isWireJsonObject(input)
    ) invalid();
    rejectDuplicates(input, []);
    const toolsetName = optionalOne(block, "toolset_name");
    if (toolsetName !== undefined && toolsetName !== null && typeof toolsetName !== "string") invalid();
    const browser = toolsetName === "browser_toolset_20260801" && tools.browserMembers.has(name);
    const computer = toolsetName === "computer_toolset_20260801" && tools.computerMembers.has(name);
    if (toolsetName !== undefined && toolsetName !== null && !browser && !computer) invalid();
    const binding: NativeCallBinding = {
      resultType: browser ? "browser_tool_result" : "tool_result",
      ...(typeof toolsetName === "string" ? { toolsetName } : {}),
    };
    sequence.observeToolCall(id, binding);
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  if (type === "tool_result") {
    rejectDuplicates(block, ["type", "tool_use_id", "content", "is_error", "toolset_name", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set(["tool_use_id"]));
    const id = exactlyOne(block, "tool_use_id");
    const toolsetName = optionalOne(block, "toolset_name");
    if (toolsetName !== undefined && toolsetName !== null && typeof toolsetName !== "string") invalid();
    if (role !== "user" || typeof id !== "string") invalid();
    const content = optionalOne(block, "content");
    const isError = optionalOne(block, "is_error");
    if (isError !== undefined && typeof isError !== "boolean") invalid();
    validateCacheControl(optionalOne(block, "cache_control"));
    if (content !== undefined && typeof content !== "string" && !isWireJsonArray(content)) invalid();
    sequence.observeToolResult(id, (expected) => {
      if (expected.toolsetName !== (toolsetName ?? undefined)) invalid();
      if (isWireJsonArray(content)) {
        let browserStates = 0;
        const downloadIds = new Set<string>();
        for (const item of content.items) {
          const itemType = isWireJsonObject(item) ? optionalOne(item, "type") : undefined;
          if (itemType === "browser_state") {
            browserStates += 1;
            if (expected.resultType !== "browser_tool_result" || browserStates > 1 || isError === true) invalid();
          }
          validateToolResultPart(item, downloadIds);
        }
      }
    });
    return;
  }
  if (type === "server_tool_use" || type === "mcp_tool_use") {
    rejectDuplicates(block, ["type", "id", "name", "server_name", "input", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set());
    const id = exactlyOne(block, "id");
    const name = exactlyOne(block, "name");
    if (role !== "assistant" || typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) invalid();
    if (type === "mcp_tool_use") {
      const serverName = exactlyOne(block, "server_name");
      if (typeof serverName !== "string" || serverName.length === 0) invalid();
    }
    exactlyOne(block, "input");
    const binding: NativeCallBinding = { resultType: managedResultType(type, name) };
    sequence.observeToolCall(id, binding);
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  if (SERVER_TOOL_RESULT_TYPES.has(type)) {
    rejectDuplicates(block, ["type", "tool_use_id", "content", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set(["tool_use_id"]));
    const id = exactlyOne(block, "tool_use_id");
    if (role !== "assistant" || typeof id !== "string") invalid();
    const content = optionalOne(block, "content");
    if (type !== "mcp_tool_result" && content === undefined) invalid();
    const isError = optionalOne(block, "is_error");
    if (isError !== undefined && typeof isError !== "boolean") invalid();
    sequence.observeToolResult(id, (expected) => {
      if (expected.resultType !== type) invalid();
      validateManagedResultContent(type, content);
    });
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  if (type === "thinking") {
    rejectDuplicates(block, ["type", "thinking", "signature", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set(["signature", "thinking"]));
    if (typeof exactlyOne(block, "thinking") !== "string") invalid();
    const signature = optionalOne(block, "signature");
    if (signature !== undefined && (typeof signature !== "string" || signature.length === 0)) invalid();
    sequence.observeReasoning();
    return;
  }
  if (type === "redacted_thinking") {
    rejectDuplicates(block, ["type", "data", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set(["data"]));
    if (typeof exactlyOne(block, "data") !== "string") invalid();
    sequence.observeReasoning();
    return;
  }
  rejectDuplicates(block, ["type", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(block, new Set());
  if (type === "browser_state") invalid();
  if (type === "document") validateDocumentBlock(block, role);
  if (type === "search_result") validateSearchResultBlock(block);
  sequence.observeMessage(role);
}

function validateToolResultPart(value: WireJson, downloadIds: Set<string>): void {
  const block = object(value);
  const type = exactlyOne(block, "type");
  rejectDuplicates(block, ["type", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(block, new Set());
  if (type === "text" || type === "input_text") {
    if (typeof exactlyOne(block, "text") !== "string") invalid();
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  if (type === "image") {
    validateImageSource(exactlyOne(block, "source"));
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  if (type === "input_image") {
    const imageUrl = exactlyOne(block, "image_url");
    if (typeof imageUrl !== "string" || !validImageLocation(imageUrl)) invalid();
    const detail = optionalOne(block, "detail");
    if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") invalid();
    return;
  }
  if (type === "document") {
    validateDocumentBlock(block, "user");
    return;
  }
  if (type === "search_result") {
    validateSearchResultBlock(block);
    return;
  }
  if (type === "tool_reference") {
    requiredManagedString(block, "tool_name");
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  if (type === "browser_state") {
    const tabs = exactlyOne(block, "tabs");
    if (!isWireJsonArray(tabs)) invalid();
    let active = 0;
    const tabIds = new Set<string>();
    for (const item of tabs.items) {
      const tab = object(item);
      rejectDuplicates(tab, ["tab_id", "title", "url", "active", ...OWNERSHIP_FIELDS]);
      rejectUnexpectedOwnership(tab, new Set());
      const tabId = exactlyOne(tab, "tab_id");
      if (typeof tabId !== "string" || tabId.length === 0 || tabIds.has(tabId)) invalid();
      tabIds.add(tabId);
      if (typeof exactlyOne(tab, "title") !== "string" || typeof exactlyOne(tab, "url") !== "string") invalid();
      const isActive = optionalOne(tab, "active");
      if (isActive !== undefined && typeof isActive !== "boolean") invalid();
      if (isActive === true) active += 1;
    }
    if (tabs.items.length > 0 && active !== 1) invalid();
    const stateChanges = optionalOne(block, "state_changes");
    if (stateChanges !== undefined && stateChanges !== null) {
      if (!isWireJsonArray(stateChanges) || stateChanges.items.length === 0) invalid();
      for (const item of stateChanges.items) validateBrowserStateChange(item, tabIds, downloadIds);
    }
    validateCacheControl(optionalOne(block, "cache_control"));
    return;
  }
  invalid();
}

function validateCitationsConfig(value: WireJson): void {
  const citations = object(value);
  rejectDuplicates(citations, ["enabled", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(citations, new Set());
  const enabled = optionalOne(citations, "enabled");
  if (enabled !== undefined && typeof enabled !== "boolean") invalid();
}

function validateBrowserStateChange(
  value: WireJson,
  tabIds: ReadonlySet<string>,
  downloadIds: Set<string>,
): void {
  const change = object(value);
  rejectDuplicates(change, ["type", "tab_id", "download_id", "url", "path", "size_bytes", "error", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(change, new Set());
  const type = exactlyOne(change, "type");
  if (type === "tab_opened") {
    const tabId = exactlyOne(change, "tab_id");
    if (typeof tabId !== "string" || !tabIds.has(tabId)) invalid();
    return;
  }
  if (type !== "download_started" && type !== "download_completed" && type !== "download_failed") invalid();
  const downloadId = exactlyOne(change, "download_id");
  if (typeof downloadId !== "string" || downloadId.length === 0 || downloadIds.has(downloadId)) invalid();
  downloadIds.add(downloadId);
  requiredManagedString(change, "url");
  if (type === "download_completed") {
    optionalManagedString(change, "path", true);
    optionalManagedInteger(change, "size_bytes", true);
  }
  if (type === "download_failed") optionalManagedString(change, "error", true);
}

function validateDocumentBlock(block: WireJsonObject, role: "user" | "assistant"): void {
  if (role !== "user") invalid();
  if (exactlyOne(block, "type") !== "document") invalid();
  rejectDuplicates(block, ["type", "source", "title", "context", "citations", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(block, new Set());
  const title = optionalOne(block, "title");
  if (title !== undefined && title !== null && typeof title !== "string") invalid();
  const context = optionalOne(block, "context");
  if (context !== undefined && context !== null && typeof context !== "string") invalid();
  const citations = optionalOne(block, "citations");
  if (citations !== undefined && citations !== null) {
    const config = object(citations);
    rejectDuplicates(config, ["enabled", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(config, new Set());
    const enabled = optionalOne(config, "enabled");
    if (enabled !== undefined && typeof enabled !== "boolean") invalid();
  }
  validateCacheControl(optionalOne(block, "cache_control"));
  const source = object(exactlyOne(block, "source"));
  rejectDuplicates(source, ["type", "content", "data", "url", "file_id", "media_type", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(source, new Set(["data"]));
  const sourceType = exactlyOne(source, "type");
  if (sourceType === "base64") {
    const mediaType = exactlyOne(source, "media_type");
    const data = exactlyOne(source, "data");
    if (mediaType !== "application/pdf" || typeof data !== "string" || !strictBase64(data)) invalid();
  } else if (sourceType === "text") {
    if (exactlyOne(source, "media_type") !== "text/plain" || typeof exactlyOne(source, "data") !== "string") invalid();
  } else if (sourceType === "content") {
    const content = exactlyOne(source, "content");
    if (typeof content === "string") return;
    if (!isWireJsonArray(content)) invalid();
    for (const item of content.items) {
      const contentBlock = object(item);
      const contentType = exactlyOne(contentBlock, "type");
      if (contentType === "text") {
        rejectDuplicates(contentBlock, ["type", "text", ...OWNERSHIP_FIELDS]);
        rejectUnexpectedOwnership(contentBlock, new Set());
        if (typeof exactlyOne(contentBlock, "text") !== "string") invalid();
        validateCacheControl(optionalOne(contentBlock, "cache_control"));
      } else if (contentType === "image") {
        rejectDuplicates(contentBlock, ["type", "source", ...OWNERSHIP_FIELDS]);
        rejectUnexpectedOwnership(contentBlock, new Set());
        validateImageSource(exactlyOne(contentBlock, "source"));
        validateCacheControl(optionalOne(contentBlock, "cache_control"));
      } else {
        invalid();
      }
    }
  } else if (sourceType === "url") {
    const url = exactlyOne(source, "url");
    if (typeof url !== "string") invalid();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalid();
    } catch {
      invalid();
    }
  } else if (sourceType === "file") {
    const fileId = exactlyOne(source, "file_id");
    if (typeof fileId !== "string" || fileId.length === 0) invalid();
  } else {
    invalid();
  }
}

function validateSearchResultBlock(block: WireJsonObject): void {
  requiredManagedString(block, "source");
  requiredManagedString(block, "title");
  const content = exactlyOne(block, "content");
  if (!isWireJsonArray(content)) invalid();
  for (const item of content.items) {
    const text = object(item);
    rejectDuplicates(text, ["type", "text", "citations", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(text, new Set());
    if (exactlyOne(text, "type") !== "text" || typeof exactlyOne(text, "text") !== "string") invalid();
    const textCitations = optionalOne(text, "citations");
    if (textCitations !== undefined && textCitations !== null) validateTextCitations(textCitations);
    validateCacheControl(optionalOne(text, "cache_control"));
  }
  const citations = optionalOne(block, "citations");
  if (citations !== undefined) validateCitationsConfig(citations);
  validateCacheControl(optionalOne(block, "cache_control"));
}

function validateTextCitations(value: WireJson): void {
  if (!isWireJsonArray(value)) invalid();
  for (const item of value.items) {
    const citation = object(item);
    rejectDuplicates(citation, ["type", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(citation, new Set());
    const type = exactlyOne(citation, "type");
    requiredManagedString(citation, "cited_text", true);
    if (type === "char_location") {
      requiredManagedNonnegativeInteger(citation, "document_index");
      const start = requiredManagedNonnegativeInteger(citation, "start_char_index");
      const end = requiredManagedNonnegativeInteger(citation, "end_char_index");
      if (end <= start) invalid();
      requiredManagedNullableString(citation, "document_title");
    } else if (type === "page_location") {
      requiredManagedNonnegativeInteger(citation, "document_index");
      const start = requiredManagedNonnegativeInteger(citation, "start_page_number");
      const end = requiredManagedNonnegativeInteger(citation, "end_page_number");
      if (end < start) invalid();
      requiredManagedNullableString(citation, "document_title");
    } else if (type === "content_block_location") {
      requiredManagedNonnegativeInteger(citation, "document_index");
      const start = requiredManagedNonnegativeInteger(citation, "start_block_index");
      const end = requiredManagedNonnegativeInteger(citation, "end_block_index");
      if (end <= start) invalid();
      requiredManagedNullableString(citation, "document_title");
    } else if (type === "search_result_location") {
      requiredManagedNonnegativeInteger(citation, "search_result_index");
      const start = requiredManagedNonnegativeInteger(citation, "start_block_index");
      const end = requiredManagedNonnegativeInteger(citation, "end_block_index");
      if (end <= start) invalid();
      requiredManagedString(citation, "source");
      requiredManagedNullableString(citation, "title");
    } else if (type === "web_search_result_location") {
      requiredManagedString(citation, "encrypted_index");
      requiredManagedString(citation, "url");
      requiredManagedNullableString(citation, "title");
    } else {
      invalid();
    }
  }
}

function managedResultType(type: string, name: string): string {
  if (type === "mcp_tool_use") return "mcp_tool_result";
  if (name === "advisor") return "advisor_tool_result";
  if (name === "web_search") return "web_search_tool_result";
  if (name === "web_fetch") return "web_fetch_tool_result";
  if (name === "code_execution") return "code_execution_tool_result";
  if (name === "bash_code_execution") return "bash_code_execution_tool_result";
  if (name === "text_editor_code_execution") return "text_editor_code_execution_tool_result";
  if (name === "tool_search_tool_regex" || name === "tool_search_tool_bm25") return "tool_search_tool_result";
  invalid();
}

function validateManagedResultContent(type: string, content: WireJson | undefined): void {
  if (type === "mcp_tool_result") {
    if (content === undefined || typeof content === "string") return;
    if (!isWireJsonArray(content)) invalid();
    for (const item of content.items) {
      const block = object(item);
      rejectDuplicates(block, ["type", "text", ...NESTED_RESULT_OWNERSHIP_FIELDS]);
      rejectUnexpectedNestedResultOwnership(block);
      if (exactlyOne(block, "type") !== "text" || typeof exactlyOne(block, "text") !== "string") invalid();
    }
    return;
  }
  if (content === undefined) invalid();
  if (type === "web_search_tool_result") return validateWebSearchResult(content);
  if (type === "web_fetch_tool_result") return validateWebFetchResult(content);
  if (type === "advisor_tool_result") return validateAdvisorResult(content);
  if (type === "code_execution_tool_result") return validateCodeExecutionResult(content, false);
  if (type === "bash_code_execution_tool_result") return validateCodeExecutionResult(content, true);
  if (type === "text_editor_code_execution_tool_result") return validateTextEditorResult(content);
  if (type === "tool_search_tool_result") return validateToolSearchResult(content);
  invalid();
}

function rejectUnexpectedNestedResultOwnership(object: WireJsonObject): void {
  if (object.members.some((member) => NESTED_RESULT_OWNERSHIP_FIELDS.has(member.key))) invalid();
}

function validateWebSearchResult(value: WireJson): void {
  if (isWireJsonArray(value)) {
    for (const item of value.items) {
      const result = managedObject(item, new Set(["encrypted_content"]));
      if (exactlyOne(result, "type") !== "web_search_result") invalid();
      requiredManagedString(result, "encrypted_content");
      const encrypted = exactlyOne(result, "encrypted_content");
      if (typeof encrypted === "string" && isReasoningCarrier(encrypted)) invalid();
      requiredManagedString(result, "title");
      requiredManagedString(result, "url");
      optionalManagedString(result, "page_age", true);
    }
    return;
  }
  validateManagedError(value, "web_search_tool_result_error", [
    "invalid_tool_input", "unavailable", "max_uses_exceeded", "too_many_requests", "query_too_long", "request_too_large",
  ]);
}

function validateWebFetchResult(value: WireJson): void {
  const result = managedObject(value);
  const type = exactlyOne(result, "type");
  if (type === "web_fetch_result") {
    requiredManagedString(result, "url");
    optionalManagedString(result, "retrieved_at", true);
    validateDocumentBlock(object(exactlyOne(result, "content")), "user");
    return;
  }
  validateManagedError(value, "web_fetch_tool_result_error", [
    "invalid_tool_input", "url_too_long", "url_not_allowed", "url_not_in_prior_context", "url_not_accessible",
    "unsupported_content_type", "too_many_requests", "max_uses_exceeded", "unavailable",
  ]);
}

function validateAdvisorResult(value: WireJson): void {
  const result = managedObject(value, new Set(["encrypted_content"]));
  const type = exactlyOne(result, "type");
  if (type === "advisor_result") {
    requiredManagedString(result, "text");
    optionalManagedString(result, "stop_reason", true);
    return;
  }
  if (type === "advisor_redacted_result") {
    requiredManagedString(result, "encrypted_content");
    optionalManagedString(result, "stop_reason", true);
    return;
  }
  validateManagedError(value, "advisor_tool_result_error", [
    "max_uses_exceeded", "prompt_too_long", "too_many_requests", "overloaded", "unavailable",
    "execution_time_exceeded", "model_not_found",
  ]);
}

function validateCodeExecutionResult(value: WireJson, bash: boolean): void {
  const result = managedObject(value, new Set(["encrypted_stdout"]));
  const prefix = bash ? "bash_" : "";
  const type = exactlyOne(result, "type");
  if (type === `${prefix}code_execution_result`) {
    requiredManagedInteger(result, "return_code");
    requiredManagedString(result, "stdout", true);
    requiredManagedString(result, "stderr", true);
    validateExecutionOutputs(exactlyOne(result, "content"), `${prefix}code_execution_output`);
    return;
  }
  if (!bash && type === "encrypted_code_execution_result") {
    requiredManagedInteger(result, "return_code");
    requiredManagedString(result, "encrypted_stdout");
    requiredManagedString(result, "stderr", true);
    validateExecutionOutputs(exactlyOne(result, "content"), "code_execution_output");
    return;
  }
  validateManagedError(value, `${prefix}code_execution_tool_result_error`, bash
    ? ["invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded", "output_file_too_large"]
    : ["invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded"]);
}

function validateExecutionOutputs(value: WireJson, expectedType: string): void {
  if (!isWireJsonArray(value)) invalid();
  for (const item of value.items) {
    const output = managedObject(item);
    if (exactlyOne(output, "type") !== expectedType) invalid();
    requiredManagedString(output, "file_id");
  }
}

function validateTextEditorResult(value: WireJson): void {
  const result = managedObject(value);
  const type = exactlyOne(result, "type");
  if (type === "text_editor_code_execution_view_result") {
    requiredManagedString(result, "content", true);
    const fileType = exactlyOne(result, "file_type");
    if (fileType !== "text" && fileType !== "image" && fileType !== "pdf") invalid();
    optionalManagedInteger(result, "num_lines", true);
    optionalManagedInteger(result, "start_line", true);
    optionalManagedInteger(result, "total_lines", true);
    return;
  }
  if (type === "text_editor_code_execution_create_result") {
    if (typeof exactlyOne(result, "is_file_update") !== "boolean") invalid();
    return;
  }
  if (type === "text_editor_code_execution_str_replace_result") {
    const lines = optionalOne(result, "lines");
    if (lines !== undefined && lines !== null && (!isWireJsonArray(lines) || lines.items.some((item) => typeof item !== "string"))) invalid();
    for (const key of ["new_lines", "new_start", "old_lines", "old_start"]) optionalManagedInteger(result, key, true);
    return;
  }
  validateManagedError(value, "text_editor_code_execution_tool_result_error", [
    "invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded", "file_not_found",
  ], true);
}

function validateToolSearchResult(value: WireJson): void {
  const result = managedObject(value);
  const type = exactlyOne(result, "type");
  if (type === "tool_search_tool_search_result") {
    const references = exactlyOne(result, "tool_references");
    if (!isWireJsonArray(references)) invalid();
    for (const item of references.items) {
      const reference = managedObject(item);
      if (exactlyOne(reference, "type") !== "tool_reference") invalid();
      requiredManagedString(reference, "tool_name");
    }
    return;
  }
  validateManagedError(value, "tool_search_tool_result_error", [
    "invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded",
  ], true);
}

function validateManagedError(
  value: WireJson,
  expectedType: string,
  codes: readonly string[],
  errorMessage = false,
): void {
  const error = managedObject(value);
  if (exactlyOne(error, "type") !== expectedType) invalid();
  const code = exactlyOne(error, "error_code");
  if (typeof code !== "string" || !codes.includes(code)) invalid();
  if (errorMessage) optionalManagedString(error, "error_message", true);
}

function managedObject(value: WireJson, allowedOwnership: ReadonlySet<string> = new Set()): WireJsonObject {
  const result = object(value);
  rejectDuplicates(result, [...NESTED_RESULT_OWNERSHIP_FIELDS]);
  if (result.members.some((member) => NESTED_RESULT_OWNERSHIP_FIELDS.has(member.key) && !allowedOwnership.has(member.key))) invalid();
  return result;
}

function requiredManagedString(objectValue: WireJsonObject, key: string, allowEmpty = false): void {
  const value = exactlyOne(objectValue, key);
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) invalid();
}

function optionalManagedString(objectValue: WireJsonObject, key: string, nullable: boolean): void {
  const value = optionalOne(objectValue, key);
  if (value !== undefined && (!nullable || value !== null) && typeof value !== "string") invalid();
}

function requiredManagedInteger(objectValue: WireJsonObject, key: string): void {
  const value = exactlyOne(objectValue, key);
  if (!isWireJsonNumber(value) || !Number.isSafeInteger(Number(value.lexeme))) invalid();
}

function requiredManagedNonnegativeInteger(objectValue: WireJsonObject, key: string): number {
  const value = exactlyOne(objectValue, key);
  if (!isWireJsonNumber(value) || !Number.isSafeInteger(Number(value.lexeme)) || Number(value.lexeme) < 0) invalid();
  return Number(value.lexeme);
}

function requiredManagedNullableString(objectValue: WireJsonObject, key: string): void {
  const value = exactlyOne(objectValue, key);
  if (value !== null && typeof value !== "string") invalid();
}

function optionalManagedInteger(objectValue: WireJsonObject, key: string, nullable: boolean): void {
  const value = optionalOne(objectValue, key);
  if (value === undefined || (nullable && value === null)) return;
  if (!isWireJsonNumber(value) || !Number.isSafeInteger(Number(value.lexeme))) invalid();
}

function validateImageSource(value: WireJson): void {
  const source = object(value);
  const type = exactlyOne(source, "type");
  if (type === "base64") {
    rejectDuplicates(source, ["type", "media_type", "data", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(source, new Set(["data"]));
    const mediaType = exactlyOne(source, "media_type");
    const data = exactlyOne(source, "data");
    if (
      typeof mediaType !== "string"
      || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)
      || typeof data !== "string"
      || data.length === 0
      || !strictBase64(data)
    ) invalid();
    return;
  }
  if (type === "url") {
    rejectDuplicates(source, ["type", "url", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(source, new Set());
    const url = exactlyOne(source, "url");
    if (typeof url !== "string") invalid();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalid();
    } catch {
      invalid();
    }
    return;
  }
  if (type === "file") {
    rejectDuplicates(source, ["type", "file_id", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(source, new Set());
    const fileId = exactlyOne(source, "file_id");
    if (typeof fileId !== "string" || fileId.length === 0) invalid();
    return;
  }
  invalid();
}

function validateSystem(value: WireJson | undefined): void {
  if (value === undefined || typeof value === "string") return;
  if (!isWireJsonArray(value)) invalid();
  for (const item of value.items) {
    const block = object(item);
    rejectDuplicates(block, ["type", "text", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(block, new Set());
    if (exactlyOne(block, "type") !== "text" || typeof exactlyOne(block, "text") !== "string") invalid();
    validateCacheControl(optionalOne(block, "cache_control"));
  }
}

function validateThinkingConfig(value: WireJson | undefined): void {
  if (value === undefined) return;
  const config = object(value);
  rejectDuplicates(config, ["type", "budget_tokens", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(config, new Set());
  const type = exactlyOne(config, "type");
  if (type !== "disabled" && type !== "adaptive" && type !== "enabled") invalid();
  optionalPositiveInteger(config, "budget_tokens");
}

function validateTools(value: WireJson | undefined): NativeToolRegistry {
  const names = new Set<string>();
  const browserMembers = new Set<string>();
  const computerMembers = new Set<string>();
  const mcpToolsets = new Set<string>();
  if (value === undefined) return { names, browserMembers, computerMembers, mcpToolsets, hasTools: false };
  if (!isWireJsonArray(value)) invalid();
  for (const item of value.items) {
    const tool = object(item);
    rejectDuplicates(tool, ["name", "input_schema", ...OWNERSHIP_FIELDS]);
    rejectUnexpectedOwnership(tool, new Set());
    const type = optionalOne(tool, "type");
    if (type !== undefined && typeof type !== "string") invalid();
    if (type === "browser_toolset_20260801") {
      for (const name of BROWSER_TOOL_NAMES) browserMembers.add(name);
    } else if (type === "computer_toolset_20260801") {
      for (const name of COMPUTER_TOOL_NAMES) computerMembers.add(name);
    } else if (type === "mcp_toolset") {
      const serverName = exactlyOne(tool, "mcp_server_name");
      if (typeof serverName !== "string" || serverName.length === 0 || mcpToolsets.has(serverName)) invalid();
      mcpToolsets.add(serverName);
    } else if (type === undefined || type === "custom") {
      const name = exactlyOne(tool, "name");
      const schema = exactlyOne(tool, "input_schema");
      if (typeof name !== "string" || name.length === 0 || !isWireJsonObject(schema)) invalid();
      rejectNestedDuplicates(schema);
      if (names.has(name)) invalid();
      names.add(name);
      const description = optionalOne(tool, "description");
      if (description !== undefined && (typeof description !== "string" || description.length === 0)) invalid();
      const strict = optionalOne(tool, "strict");
      if (strict !== undefined && typeof strict !== "boolean") invalid();
    } else {
      const name = exactlyOne(tool, "name");
      if (typeof name !== "string" || name.length === 0 || names.has(name)) invalid();
      names.add(name);
    }
    validateCacheControl(optionalOne(tool, "cache_control"));
  }
  return { names, browserMembers, computerMembers, mcpToolsets, hasTools: value.items.length > 0 };
}

function validateToolChoice(value: WireJson | undefined, tools: NativeToolRegistry): void {
  if (value === undefined) return;
  const choice = object(value);
  rejectDuplicates(choice, ["type", "name", "disable_parallel_tool_use", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(choice, new Set());
  const type = exactlyOne(choice, "type");
  if (type !== "auto" && type !== "none" && type !== "any" && type !== "tool") invalid();
  const disabled = optionalOne(choice, "disable_parallel_tool_use");
  if (disabled !== undefined && typeof disabled !== "boolean") invalid();
  if ((type === "any" || type === "tool" || disabled !== undefined) && !tools.hasTools) invalid();
  if (type === "tool") {
    const name = exactlyOne(choice, "name");
    if (typeof name !== "string" || (
      !tools.names.has(name) && !tools.browserMembers.has(name) && !tools.computerMembers.has(name)
    )) invalid();
  }
}

function validateOutputConfig(value: WireJson | undefined): void {
  if (value === undefined) return;
  const config = object(value);
  rejectDuplicates(config, ["effort", "format", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(config, new Set());
  const effort = optionalOne(config, "effort");
  if (effort !== undefined && (typeof effort !== "string" || effort.length === 0)) invalid();
  const format = optionalOne(config, "format");
  if (format !== undefined) validateOutputFormat(format);
}

function validateOutputFormat(value: WireJson): void {
  const format = object(value);
  rejectDuplicates(format, ["type", "name", "description", "schema", "strict", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(format, new Set());
  const type = exactlyOne(format, "type");
  if (type !== "json_object" && type !== "json_schema") invalid();
  const name = optionalOne(format, "name");
  if (name !== undefined && (typeof name !== "string" || name.length === 0)) invalid();
  const description = optionalOne(format, "description");
  if (description !== undefined && (typeof description !== "string" || description.length === 0)) invalid();
  if (type === "json_schema") {
    const schema = exactlyOne(format, "schema");
    if (!isWireJsonObject(schema)) invalid();
    rejectNestedDuplicates(schema);
  }
  const strict = optionalOne(format, "strict");
  if (strict !== undefined && typeof strict !== "boolean") invalid();
}

function validateObjectCore(value: WireJson | undefined, known: readonly string[]): void {
  if (value === undefined) return;
  const objectValue = object(value);
  rejectDuplicates(objectValue, [...known, ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(objectValue, new Set());
  if (known.includes("user_id")) optionalString(objectValue, "user_id");
  if (known.includes("effort")) {
    const effort = optionalOne(objectValue, "effort");
    if (effort !== undefined && typeof effort !== "string") invalid();
    const format = optionalOne(objectValue, "format");
    if (format !== undefined && !isWireJsonObject(format)) invalid();
  }
}

function rejectUnexpectedOwnership(object: WireJsonObject, allowed: ReadonlySet<string>): void {
  if (object.members.some((member) => OWNERSHIP_FIELDS.has(member.key) && !allowed.has(member.key))) invalid();
}

function rejectDuplicates(object: WireJsonObject, sensitive: readonly string[]): void {
  const duplicates = new Set(duplicateMemberNames(object));
  if (duplicates.size > 0 || sensitive.some((key) => duplicates.has(key))) invalid();
}

function rejectSelectedDuplicates(object: WireJsonObject, sensitive: readonly string[]): void {
  const duplicates = new Set(duplicateMemberNames(object));
  if (sensitive.some((key) => duplicates.has(key))) invalid();
}

function exactlyOne(object: WireJsonObject, key: string): WireJson {
  const values = memberValues(object, key);
  if (values.length !== 1) invalid();
  return values[0] as WireJson;
}

function optionalOne(object: WireJsonObject, key: string): WireJson | undefined {
  const values = memberValues(object, key);
  if (values.length > 1) invalid();
  return values[0];
}

function optionalString(object: WireJsonObject, key: string): void {
  const value = optionalOne(object, key);
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) invalid();
}

function optionalBoolean(object: WireJsonObject, key: string): void {
  const value = optionalOne(object, key);
  if (value !== undefined && typeof value !== "boolean") invalid();
}

function optionalNumber(object: WireJsonObject, key: string, minimum: number, maximum: number): void {
  const value = optionalOne(object, key);
  if (value === undefined) return;
  if (!isWireJsonNumber(value)) invalid();
  const parsed = Number(value.lexeme);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) invalid();
}

function optionalPositiveInteger(object: WireJsonObject, key: string): void {
  const value = optionalOne(object, key);
  if (value !== undefined && (!isWireJsonNumber(value) || !Number.isSafeInteger(Number(value.lexeme)) || Number(value.lexeme) <= 0)) invalid();
}

function validateStringList(value: WireJson | undefined): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (value.length === 0) invalid();
    return;
  }
  if (!isWireJsonArray(value) || value.items.some((item) => typeof item !== "string" || item.length === 0)) invalid();
}

function validateCacheControl(value: WireJson | undefined): void {
  if (value === undefined || value === null) return;
  const cache = object(value);
  rejectDuplicates(cache, ["type", "ttl", ...OWNERSHIP_FIELDS]);
  rejectUnexpectedOwnership(cache, new Set());
  if (exactlyOne(cache, "type") !== "ephemeral") invalid();
  const ttl = optionalOne(cache, "ttl");
  if (ttl !== undefined && ttl !== "5m" && ttl !== "1h") invalid();
}

function rejectNestedDuplicates(value: WireJson): void {
  if (isWireJsonArray(value)) {
    for (const item of value.items) rejectNestedDuplicates(item);
    return;
  }
  if (!isWireJsonObject(value)) return;
  if (duplicateMemberNames(value).length > 0) invalid();
  for (const member of value.members) rejectNestedDuplicates(member.value);
}

function strictBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function validImageLocation(value: string): boolean {
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/u.exec(value);
  if (data !== null) return data[2] !== undefined && data[2].length > 0 && strictBase64(data[2]);
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function object(value: WireJson): WireJsonObject {
  if (!isWireJsonObject(value)) invalid();
  return value;
}

function rejectCarrierOutsideDocumentedSlots(value: WireJson, seen: Set<string>): void {
  if (!isWireJsonObject(value)) {
    rejectAnyCarrier(value);
    return;
  }
  for (const member of value.members) {
    if (member.key === "messages" && isWireJsonArray(member.value)) {
      for (const message of member.value.items) validateCarrierMessage(message, seen);
    } else {
      rejectAnyCarrier(member.value);
    }
  }
}

function validateCarrierMessage(value: WireJson, seen: Set<string>): void {
  if (!isWireJsonObject(value)) {
    rejectAnyCarrier(value);
    return;
  }
  const roles = memberValues(value, "role");
  const assistant = roles.length === 1 && roles[0] === "assistant";
  for (const member of value.members) {
    if (member.key === "content" && isWireJsonArray(member.value)) {
      for (const block of member.value.items) validateCarrierBlock(block, seen, assistant);
    } else {
      rejectAnyCarrier(member.value);
    }
  }
}

function validateCarrierBlock(value: WireJson, seen: Set<string>, assistant: boolean): void {
  if (!isWireJsonObject(value)) {
    rejectAnyCarrier(value);
    return;
  }
  const types = memberValues(value, "type");
  const type = types.length === 1 ? types[0] : undefined;
  for (const member of value.members) {
    const allowed = assistant && ((type === "thinking" && member.key === "signature")
      || (type === "redacted_thinking" && member.key === "data"));
    if (!allowed) {
      rejectAnyCarrier(member.value);
    } else if (typeof member.value === "string" && isReasoningCarrier(member.value)) {
      if (seen.has(member.value)) invalid();
      seen.add(member.value);
    }
  }
}

function rejectAnyCarrier(value: WireJson): void {
  if (typeof value === "string") {
    if (isReasoningCarrier(value)) invalid();
    return;
  }
  if (isWireJsonArray(value)) {
    for (const item of value.items) rejectAnyCarrier(item);
    return;
  }
  if (!isWireJsonObject(value)) return;
  for (const member of value.members) rejectAnyCarrier(member.value);
}

function invalid(): never {
  throw new GatewayFailureError({ kind: "invalid_request", source: "request", phase: "decode" });
}
