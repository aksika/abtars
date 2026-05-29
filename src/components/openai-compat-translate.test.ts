/**
 * #373 — Tests for OpenAI-compat translation + SSE helpers (pure functions).
 */

import { describe, it, expect } from "vitest";
import {
  flattenMessages,
  composePrompt,
  buildChatResponse,
  buildModelsList,
  extractSessionKey,
  extractBearerToken,
  openaiError,
  validateChatRequest,
  type OpenAIMessage,
} from "./openai-compat-translate.js";
import {
  deltaChunk,
  finishChunk,
  streamError,
  bufferedStreamBody,
  DONE_MARKER,
} from "./openai-compat-sse.js";

describe("#373 — flattenMessages", () => {
  it("picks the last user message as the prompt", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const flat = flattenMessages(messages);
    expect(flat.prompt).toBe("second");
  });

  it("concatenates system messages into clientSystem with blank-line separator", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Be concise." },
      { role: "user", content: "hi" },
    ];
    const flat = flattenMessages(messages);
    expect(flat.clientSystem).toBe("You are helpful.\n\nBe concise.");
    expect(flat.prompt).toBe("hi");
  });

  it("returns empty prompt if no user message", () => {
    const flat = flattenMessages([{ role: "system", content: "sys" }]);
    expect(flat.prompt).toBe("");
    expect(flat.clientSystem).toBe("sys");
  });

  it("returns all contents in order for injection scanning", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];
    const flat = flattenMessages(messages);
    expect(flat.allContents).toEqual(["sys", "u1", "a1", "u2"]);
  });

  it("handles null content fields (tool messages often have null)", () => {
    const messages: OpenAIMessage[] = [
      { role: "assistant", content: null, tool_calls: [{}] },
      { role: "user", content: "ok" },
    ];
    const flat = flattenMessages(messages);
    expect(flat.prompt).toBe("ok");
    expect(flat.allContents).toEqual(["", "ok"]);
  });

  it("ignores whitespace-only user messages when picking last user", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "real question" },
      { role: "user", content: "   " },
    ];
    const flat = flattenMessages(messages);
    expect(flat.prompt).toBe("real question");
  });
});

describe("#373 — composePrompt", () => {
  it("returns plain prompt when no clientSystem", () => {
    const result = composePrompt({ prompt: "hi", clientSystem: "", allContents: ["hi"] });
    expect(result).toBe("hi");
  });

  it("prepends clientSystem block when present", () => {
    const result = composePrompt({ prompt: "hi", clientSystem: "be nice", allContents: [] });
    expect(result).toBe("[CLIENT SYSTEM]\nbe nice\n[END CLIENT SYSTEM]\n\nhi");
  });
});

describe("#373 — buildChatResponse", () => {
  it("emits all required OpenAI fields", () => {
    const resp = buildChatResponse({ model: "kp/default", content: "reply" });
    expect(resp.id).toMatch(/^chatcmpl-/);
    expect(resp.object).toBe("chat.completion");
    expect(resp.created).toBeGreaterThan(0);
    expect(resp.model).toBe("kp/default");
    expect(resp.choices).toHaveLength(1);
    expect(resp.choices[0]!.message).toEqual({ role: "assistant", content: "reply" });
    expect(resp.choices[0]!.finish_reason).toBe("stop");
    expect(resp.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("honors finishReason override", () => {
    const resp = buildChatResponse({ model: "m", content: "truncated", finishReason: "length" });
    expect(resp.choices[0]!.finish_reason).toBe("length");
  });

  it("generates unique ids across calls", () => {
    const a = buildChatResponse({ model: "m", content: "x" });
    const b = buildChatResponse({ model: "m", content: "x" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("#373 — buildModelsList", () => {
  it("returns the expected model aliases", () => {
    const list = buildModelsList();
    expect(list.object).toBe("list");
    const ids = list.data.map(m => m.id);
    expect(ids).toContain("kp/default");
    expect(ids).toContain("kp");
    for (const m of list.data) {
      expect(m.object).toBe("model");
      expect(m.owned_by).toBe("kp");
      expect(m.created).toBeGreaterThan(0);
    }
  });
});

describe("#373 — extractSessionKey", () => {
  it("returns header value when present", () => {
    expect(extractSessionKey({ "x-session-id": "my-agent" })).toBe("my-agent");
  });

  it("returns 'default' when header absent", () => {
    expect(extractSessionKey({})).toBe("default");
  });

  it("returns 'default' for empty string", () => {
    expect(extractSessionKey({ "x-session-id": "" })).toBe("default");
  });

  it("returns 'default' for whitespace-only value", () => {
    expect(extractSessionKey({ "x-session-id": "   " })).toBe("default");
  });

  it("handles array-valued header (node http can send arrays)", () => {
    expect(extractSessionKey({ "x-session-id": ["librechat"] })).toBe("librechat");
  });

  it("trims surrounding whitespace", () => {
    expect(extractSessionKey({ "x-session-id": "  cursor  " })).toBe("cursor");
  });
});

describe("#373 — extractBearerToken", () => {
  it("extracts token from well-formed Bearer header", () => {
    expect(extractBearerToken({ "authorization": "Bearer abc123" })).toBe("abc123");
  });

  it("is case-insensitive on 'Bearer'", () => {
    expect(extractBearerToken({ "authorization": "bearer xyz" })).toBe("xyz");
    expect(extractBearerToken({ "authorization": "BEARER foo" })).toBe("foo");
  });

  it("returns null for missing header", () => {
    expect(extractBearerToken({})).toBeNull();
  });

  it("returns null for non-Bearer scheme", () => {
    expect(extractBearerToken({ "authorization": "Basic dXNlcjpwYXNz" })).toBeNull();
  });

  it("returns null for malformed header", () => {
    expect(extractBearerToken({ "authorization": "Bearer" })).toBeNull();
    expect(extractBearerToken({ "authorization": "" })).toBeNull();
  });

  it("trims trailing whitespace from token", () => {
    expect(extractBearerToken({ "authorization": "Bearer  secret-token  " })).toBe("secret-token");
  });
});

describe("#373 — openaiError", () => {
  it("builds a shaped error envelope", () => {
    const err = openaiError("Missing token", "authentication_error", "invalid_api_key");
    expect(err).toEqual({
      error: {
        message: "Missing token",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
  });

  it("omits code when not provided", () => {
    const err = openaiError("oops", "server_error");
    expect(err.error.code).toBeUndefined();
  });
});

// ── SSE formatter ────────────────────────────────────────────────────────────

describe("#373 — SSE deltaChunk", () => {
  it("emits a valid data: frame with newline terminator", () => {
    const out = deltaChunk("hello", { id: "chatcmpl-x", model: "kp/default", created: 100 });
    expect(out.startsWith("data: ")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    const json = JSON.parse(out.slice(6, -2));
    expect(json.id).toBe("chatcmpl-x");
    expect(json.object).toBe("chat.completion.chunk");
    expect(json.model).toBe("kp/default");
    expect(json.choices[0].delta).toEqual({ role: "assistant", content: "hello" });
    expect(json.choices[0].finish_reason).toBeNull();
  });
});

describe("#373 — SSE finishChunk", () => {
  it("emits empty delta + finish_reason", () => {
    const out = finishChunk({ id: "x", model: "m", created: 1, reason: "stop" });
    const json = JSON.parse(out.slice(6, -2));
    expect(json.choices[0].delta).toEqual({});
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("defaults reason to 'stop'", () => {
    const out = finishChunk({ id: "x", model: "m" });
    const json = JSON.parse(out.slice(6, -2));
    expect(json.choices[0].finish_reason).toBe("stop");
  });
});

describe("#373 — SSE streamError", () => {
  it("emits a data frame with error envelope", () => {
    const out = streamError("agent crashed");
    expect(out.startsWith("data: ")).toBe(true);
    const json = JSON.parse(out.slice(6, -2));
    expect(json.error.message).toBe("agent crashed");
    expect(json.error.type).toBe("server_error");
  });
});

describe("#373 — SSE DONE_MARKER", () => {
  it("matches the OpenAI spec exactly", () => {
    expect(DONE_MARKER).toBe("data: [DONE]\n\n");
  });
});

describe("#373 — validateChatRequest (untrusted-input narrowing)", () => {
  it("accepts well-formed request", () => {
    const result = validateChatRequest({
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("gpt-4");
    expect(result.value.messages).toHaveLength(1);
    expect(result.value.stream).toBe(true);
  });

  it("defaults model to 'kp/default' when missing", () => {
    const result = validateChatRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("kp/default");
  });

  it("rejects non-object body", () => {
    const r1 = validateChatRequest(null);
    const r2 = validateChatRequest("a string");
    const r3 = validateChatRequest([]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
  });

  it("rejects missing messages array", () => {
    const result = validateChatRequest({ model: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_messages");
  });

  it("rejects empty messages array", () => {
    const result = validateChatRequest({ messages: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_messages");
  });

  it("rejects message with invalid role", () => {
    const result = validateChatRequest({ messages: [{ role: 42, content: "hi" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_role");
    expect(result.message).toContain("[0]");
  });

  it("rejects message with object content (e.g. multimodal array not yet supported)", () => {
    const result = validateChatRequest({ messages: [{ role: "user", content: { type: "image" } }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_content");
  });

  it("allows null content (common for tool messages)", () => {
    const result = validateChatRequest({ messages: [{ role: "assistant", content: null, tool_calls: [{}] }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages[0]!.content).toBeNull();
    expect(result.value.messages[0]!.tool_calls).toEqual([{}]);
  });

  it("silently drops unknown fields (forward-compat)", () => {
    const result = validateChatRequest({
      messages: [{ role: "user", content: "hi" }],
      future_openai_field: "value",
      random_other: 123,
    });
    expect(result.ok).toBe(true);
  });

  it("ignores non-boolean stream field", () => {
    const result = validateChatRequest({
      messages: [{ role: "user", content: "hi" }],
      stream: "true", // string, not boolean
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stream).toBeUndefined(); // dropped
  });

  it("rejects at first bad message, reports index", () => {
    const result = validateChatRequest({
      messages: [
        { role: "user", content: "ok" },
        { role: "user", content: "also ok" },
        { role: 123, content: "bad role" }, // index 2
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("[2]");
  });
});

describe("#373 — SSE bufferedStreamBody", () => {
  it("emits delta + finish + DONE in order, all sharing the same id", () => {
    const body = bufferedStreamBody("full reply", { model: "kp/default" });

    // Split by the blank-line separator between SSE frames
    const frames = body.split("\n\n").filter(f => f.trim());
    expect(frames.length).toBe(3); // delta, finish, [DONE]

    const deltaJson = JSON.parse(frames[0]!.slice(6));
    const finishJson = JSON.parse(frames[1]!.slice(6));
    expect(frames[2]).toBe("data: [DONE]");

    expect(deltaJson.id).toBe(finishJson.id); // same chatcmpl id across chunks
    expect(deltaJson.choices[0].delta.content).toBe("full reply");
    expect(deltaJson.choices[0].finish_reason).toBeNull();
    expect(finishJson.choices[0].delta).toEqual({});
    expect(finishJson.choices[0].finish_reason).toBe("stop");
  });

  it("passes through reason override", () => {
    const body = bufferedStreamBody("clipped", { model: "m", reason: "length" });
    const finishJson = JSON.parse(body.split("\n\n")[1]!.slice(6));
    expect(finishJson.choices[0].finish_reason).toBe("length");
  });
});
