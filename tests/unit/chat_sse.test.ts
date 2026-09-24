import { describe, expect, it } from "vitest";
import { parseOpenaiChatCompletionsSse } from "../../src/protocols/openai_chat_completions/native.js";
import { isWireJsonObject } from "../../src/serialization/wire_json.js";

async function* splitBytes(text: string, size: number): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let index = 0; index < bytes.byteLength; index += size) {
    yield bytes.slice(index, index + size);
  }
}

describe("Chat SSE", () => {
  it("parses chunk, multi-data, comments, and [DONE] at every 1-byte split", async () => {
    const body = [
      ": comment\n",
      "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[]}\n\n",
      "data: {\"choices\":[],\"a\":1}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const frames = [];
    for await (const frame of parseOpenaiChatCompletionsSse(splitBytes(body, 1))) {
      frames.push(frame);
    }
    expect(frames.map((frame) => frame.kind)).toEqual(["chunk", "chunk", "done"]);
    if (frames[1]?.kind === "chunk" && isWireJsonObject(frames[1].chunk.payload)) {
      expect(frames[1].chunk.payload.members[1]?.key).toBe("a");
    }
  });

  it("accepts CRLF and BOM and ignores post-DONE data", async () => {
    const body = "\uFEFFdata: {\"choices\":[],\"ok\":true}\r\n\r\ndata: [DONE]\r\n\r\ndata: {\"choices\":[],\"no\":1}\r\n\r\n";
    const frames = [];
    for await (const frame of parseOpenaiChatCompletionsSse(splitBytes(body, 2))) {
      frames.push(frame);
    }
    expect(frames.map((frame) => frame.kind)).toEqual(["chunk", "done"]);
  });

  it("throws on truncated EOF without [DONE]", async () => {
    await expect(async () => {
      for await (const _frame of parseOpenaiChatCompletionsSse(splitBytes("data: {\"choices\":[],\"ok\":true}\n\n", 1))) {
        void _frame;
      }
    }).rejects.toMatchObject({ code: "truncated" });
  });
});
