import { describe, it, expect } from "vitest";
import {
  parsePeerChatRequest,
  parsePeerChatResponse,
} from "./peer-chat.js";

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    session_id: "sess_abc123",
    messages: [{ role: "user", content: "hello" }],
    deadline_at: Date.now() + 60_000,
    ...overrides,
  };
}

describe("parsePeerChatRequest (#1786)", () => {
  it("accepts a valid request", () => {
    const r = parsePeerChatRequest(validRequest());
    expect(r.ok).toBe(true);
  });

  it("accepts assistant history ending in user", () => {
    const r = parsePeerChatRequest(validRequest({
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects wrong version", () => {
    expect(parsePeerChatRequest(validRequest({ version: 2 })).ok).toBe(false);
  });

  it("rejects bad session_id", () => {
    expect(parsePeerChatRequest(validRequest({ session_id: "" })).ok).toBe(false);
    expect(parsePeerChatRequest(validRequest({ session_id: "has space" })).ok).toBe(false);
    expect(parsePeerChatRequest(validRequest({ session_id: "x".repeat(129) })).ok).toBe(false);
  });

  it("rejects empty and oversized message lists", () => {
    expect(parsePeerChatRequest(validRequest({ messages: [] })).ok).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ role: "user", content: `m${i}` }));
    expect(parsePeerChatRequest(validRequest({ messages: many })).ok).toBe(false);
  });

  it("rejects bad roles, empty content, and non-user-final turns", () => {
    expect(parsePeerChatRequest(validRequest({ messages: [{ role: "system", content: "x" }] })).ok).toBe(false);
    expect(parsePeerChatRequest(validRequest({ messages: [{ role: "user", content: "" }] })).ok).toBe(false);
    expect(parsePeerChatRequest(validRequest({
      messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
    })).ok).toBe(false);
  });

  it("rejects invalid deadline_at", () => {
    expect(parsePeerChatRequest(validRequest({ deadline_at: -1 })).ok).toBe(false);
    expect(parsePeerChatRequest(validRequest({ deadline_at: "soon" })).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(parsePeerChatRequest(null).ok).toBe(false);
    expect(parsePeerChatRequest("chat").ok).toBe(false);
  });
});

describe("parsePeerChatResponse (#1786)", () => {
  it("accepts a valid response", () => {
    expect(parsePeerChatResponse({ version: 1, text: "hi" }).ok).toBe(true);
  });

  it("rejects empty/oversized text", () => {
    expect(parsePeerChatResponse({ version: 1, text: "" }).ok).toBe(false);
    expect(parsePeerChatResponse({ version: 1, text: "x".repeat(65_537) }).ok).toBe(false);
    expect(parsePeerChatResponse({ version: 1 }).ok).toBe(false);
  });
});
