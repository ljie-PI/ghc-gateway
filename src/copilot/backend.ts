import type { BoundAccount } from "../accounts/account_directory.js";
import type { AccountId } from "../accounts/credential_store.js";
import { copilotHeaders } from "./identity.js";
import { parseChatSse } from "./chat_sse.js";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamFrame,
} from "../protocols/chat_completions/types.js";
import type {
  MessagesUpstreamRequest,
  NativeResponsesUpstreamRequest,
  UpstreamByteResponse,
  UpstreamByteStream,
} from "./upstream_types.js";

export interface CopilotTarget {
  readonly endpoint: string;
  readonly token: string;
}

export interface BoundCopilot {
  readonly accountId: AccountId;
  readonly target: Readonly<CopilotTarget>;
  completeChat(request: Readonly<ChatRequest>): Promise<ChatResponse>;
  openChatStream(request: Readonly<ChatRequest>): Promise<UpstreamByteStream>;
  completeResponses(request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteResponse>;
  openResponsesStream(request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteStream>;
  completeMessages(request: Readonly<MessagesUpstreamRequest>): Promise<UpstreamByteResponse>;
  openMessagesStream(request: Readonly<MessagesUpstreamRequest>): Promise<UpstreamByteStream>;
}

export interface CopilotBackend {
  bind(account: Readonly<BoundAccount>, signal: AbortSignal): Promise<BoundCopilot>;
  close(): Promise<void>;
  forceClose(): void;
}

export async function* iterateChatFrames(stream: UpstreamByteStream): AsyncGenerator<ChatStreamFrame> {
  yield* parseChatSse(stream.bytes);
}

export function outboundHeaders(token: string, extra?: Headers): Headers {
  const headers = new Headers(copilotHeaders());
  headers.set("authorization", `Bearer ${token}`);
  if (extra !== undefined) {
    extra.forEach((value, key) => {
      const name = key.toLowerCase();
      if (
        name === "authorization"
        || name === "copilot-integration-id"
        || name === "editor-version"
        || name === "editor-plugin-version"
        || name === "user-agent"
        || name === "x-github-api-version"
      ) {
        return;
      }
      headers.set(key, value);
    });
  }
  return headers;
}
