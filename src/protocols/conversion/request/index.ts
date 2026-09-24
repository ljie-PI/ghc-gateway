import { type InferenceProtocol } from "../types.js";
import { decodeChatRequest, encodeChatRequest } from "./chat.js";
import { decodeMessagesRequest, encodeMessagesRequest } from "./messages.js";
import { decodeResponsesRequest, encodeResponsesRequest } from "./responses.js";
import { type ProtocolRequestCodec } from "./types.js";

export type { ProtocolRequestCodec } from "./types.js";

export const CHAT_REQUEST_CODEC: ProtocolRequestCodec = {
  protocol: "chat",
  decode: (body, carriers) => decodeChatRequest(body, carriers),
  encode: (request, context) => encodeChatRequest(request, context),
};

export const MESSAGES_REQUEST_CODEC: ProtocolRequestCodec = {
  protocol: "messages",
  decode: (body, carriers) => decodeMessagesRequest(body, carriers),
  encode: (request, context) => encodeMessagesRequest(request, context),
};

export const RESPONSES_REQUEST_CODEC: ProtocolRequestCodec = {
  protocol: "responses",
  decode: (body, carriers) => decodeResponsesRequest(body, carriers),
  encode: (request, context) => encodeResponsesRequest(request, context),
};

export const PROTOCOL_REQUEST_CODECS: Readonly<Record<InferenceProtocol, ProtocolRequestCodec>> = {
  chat: CHAT_REQUEST_CODEC,
  messages: MESSAGES_REQUEST_CODEC,
  responses: RESPONSES_REQUEST_CODEC,
};
