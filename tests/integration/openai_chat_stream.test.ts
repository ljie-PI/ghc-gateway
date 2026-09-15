import { describe, expect, it } from "vitest";
import { parseOpenaiChatCompletionsSse } from "../../src/protocols/openai_chat_completions/native.js";
import { encodeOpenaiChatCompletionsDone, encodeOpenaiChatCompletionsSseChunk } from "../../src/protocols/openai_chat_completions/wire.js";
import { isWireJsonObject } from "../../src/serialization/wire_json.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("OpenAI Chat stream wire", () => {
  it("normalizes chunks and the successful Done terminal at every byte split", async () => {
    const upstream = [
      ": ignored\n",
      "id: 1\n",
      "event: message\n",
      "data: {\"id\":\"1\",\"choices\":[],\"usage\":{\"prompt_tokens\":1}}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    for (let split = 1; split <= encoder.encode(upstream).byteLength; split += 1) {
      const chunks: string[] = [];
      for await (const frame of parseOpenaiChatCompletionsSse(streamFromText(upstream, split))) {
        if (frame.kind === "chunk") {
          chunks.push(decoder.decode(encodeOpenaiChatCompletionsSseChunk(frame.chunk.payload)));
        } else if (frame.kind === "done") {
          chunks.push(decoder.decode(encodeOpenaiChatCompletionsDone()));
        }
      }
      expect(chunks.join(""), `split ${split}`).toBe(
        "data: {\"id\":\"1\",\"choices\":[],\"usage\":{\"prompt_tokens\":1}}\n\ndata: [DONE]\n\n",
      );
    }
  });

  it("preserves multibyte UTF-8 split across transport chunks", async () => {
    const frames = [];
    for await (const frame of parseOpenaiChatCompletionsSse(streamFromText("data: {\"choices\":[],\"text\":\"你好\"}\n\ndata: [DONE]\n\n", 1))) {
      frames.push(frame);
    }
    expect(frames).toHaveLength(2);
    if (frames[0]?.kind === "chunk" && isWireJsonObject(frames[0].chunk.payload)) {
      expect(frames[0].chunk.payload.members[1]?.value).toBe("你好");
    }
  });

  it("rejects invalid UTF-8 instead of rewriting it", async () => {
    await expect(async () => {
      for await (const _frame of parseOpenaiChatCompletionsSse(bytes([
        new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]),
      ]))) {
        void _frame;
      }
    }).rejects.toMatchObject({ code: "invalid_utf8" });
  });

  it("classifies root error objects as upstream error frames", async () => {
    const frames = [];
    for await (const frame of parseOpenaiChatCompletionsSse(streamFromText("data: {\"error\":{\"message\":\"secret\"}}\n\n", 8))) {
      frames.push(frame);
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe("error");
  });

  it("classifies malformed Chat chunks as upstream error frames", async () => {
    const frames = [];
    for await (const frame of parseOpenaiChatCompletionsSse(streamFromText("data: {\"id\":\"missing-choices\"}\n\n", 8))) {
      frames.push(frame);
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe("error");
  });

  it("requires a Done terminal", async () => {
    await expect(async () => {
      for await (const _frame of parseOpenaiChatCompletionsSse(streamFromText("data: {\"choices\":[]}\n\n", 2))) {
        void _frame;
      }
    }).rejects.toMatchObject({ code: "truncated" });
  });
});

async function* streamFromText(text: string, split: number): AsyncIterable<Uint8Array> {
  const data = encoder.encode(text);
  for (let index = 0; index < data.byteLength; index += split) {
    yield data.slice(index, index + split);
  }
}

async function* bytes(parts: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield part;
  }
}
