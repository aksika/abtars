import { describe, expect, it } from "vitest";
import {
  memoryOperationKey,
  inboundExecutionKey,
  inboundMessageKey,
  assistantMessageKey,
  feedbackKey,
} from "./memory-operation-key.js";

describe("memoryOperationKey", () => {
  it("produces a deterministic key for the same identity", () => {
    const a = memoryOperationKey("inbound", ["discord", "ch1", "", "user1", "12345"]);
    const b = memoryOperationKey("inbound", ["discord", "ch1", "", "user1", "12345"]);
    expect(a).toBe(b);
  });

  it("produces different keys for different families with the same identity", () => {
    const inbound = memoryOperationKey("inbound", ["discord", "ch1", "", "user1", "12345"]);
    const feedback = memoryOperationKey("feedback", ["discord", "ch1", "", "user1", "12345"]);
    expect(inbound).not.toBe(feedback);
  });

  it("produces different keys for different identity components", () => {
    const a = memoryOperationKey("inbound", ["discord", "ch1", "", "user1", "1"]);
    const b = memoryOperationKey("inbound", ["discord", "ch2", "", "user1", "1"]);
    expect(a).not.toBe(b);
  });

  it("formats as abtars-mem-v1:<family>:<base64url>", () => {
    const key = memoryOperationKey("inbound", ["tg", "chat1", "", "user1", "100"]);
    expect(key).toMatch(/^abtars-mem-v1:inbound:[A-Za-z0-9_-]+$/);
  });

  it("stays within 128 chars", () => {
    const longId = "x".repeat(100);
    const key = memoryOperationKey("inbound", ["discord", "ch1", "", "user1", longId]);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("does not contain the raw identity string", () => {
    const key = memoryOperationKey("inbound", ["discord", "ch1", "", "user1", "secret-msg-id"]);
    expect(key).not.toContain("secret-msg-id");
    expect(key).not.toContain("discord");
    expect(key).not.toContain("ch1");
  });

  it("stays within 128 chars even with large identity components (SHA-256 output is fixed-size)", () => {
    const huge = Array(200).fill("x".repeat(100));
    const key = memoryOperationKey("inbound", huge);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("differentiates empty vs absent threadId", () => {
    const a = memoryOperationKey("inbound", ["tg", "ch1", "", "user1", "1"]);
    const b = memoryOperationKey("inbound", ["tg", "ch1", "threadA", "user1", "1"]);
    expect(a).not.toBe(b);
  });

  it("handles Unicode identity components", () => {
    const key = memoryOperationKey("inbound", ["tg", "チャンネル", "", "ユーザー", "42"]);
    expect(key).toMatch(/^abtars-mem-v1:inbound:/);
    expect(key.length).toBeLessThanOrEqual(128);
  });
});

describe("inboundMessageKey", () => {
  it("builds a deterministic key from platform identity", () => {
    const a = inboundMessageKey("telegram", "chat1", null, "user1", "123");
    const b = inboundMessageKey("telegram", "chat1", null, "user1", "123");
    expect(a).toBe(b);
  });

  it("differentiates cross-chat Telegram message IDs", () => {
    const chatA = inboundMessageKey("telegram", "chatA", null, "user1", "42");
    const chatB = inboundMessageKey("telegram", "chatB", null, "user1", "42");
    expect(chatA).not.toBe(chatB);
  });

  it("handles Discord snowflake as lossless string", () => {
    const snowflake = "123456789012345678"; // > Number.MAX_SAFE_INTEGER
    const key = inboundMessageKey("discord", "ch1", null, "user1", snowflake);
    expect(key).toMatch(/^abtars-mem-v1:inbound:/);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("includes threadId when present", () => {
    const withThread = inboundMessageKey("discord", "ch1", "thread1", "user1", "1");
    const without = inboundMessageKey("discord", "ch1", null, "user1", "1");
    expect(withThread).not.toBe(without);
  });

  it("throws for empty messageId", () => {
    expect(() => inboundMessageKey("discord", "ch1", null, "user1", "")).toThrow("non-empty");
  });

  it("throws for empty platform", () => {
    expect(() => inboundMessageKey("", "ch1", null, "user1", "1")).toThrow("non-empty");
  });

  it("throws for empty channelId", () => {
    expect(() => inboundMessageKey("discord", "", null, "user1", "1")).toThrow("non-empty");
  });

  it("throws for empty userId", () => {
    expect(() => inboundMessageKey("discord", "ch1", null, "", "1")).toThrow("non-empty");
  });

  it("allows empty threadId", () => {
    const key = inboundMessageKey("discord", "ch1", "", "user1", "1");
    const keyNull = inboundMessageKey("discord", "ch1", null, "user1", "1");
    expect(key).toBe(keyNull);
  });
});

describe("inboundExecutionKey", () => {
  it("keeps internal-source identity bounded and hashed", () => {
    const key = inboundExecutionKey("tui", "tui:local", null, "user1", `${"session-".repeat(200)}:123`);
    expect(key).toMatch(/^abtars-mem-v1:inbound:/);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).not.toContain("session-");
  });

  it("differentiates internal executions", () => {
    const a = inboundExecutionKey("irc", "server:#channel", null, "user1", "s1:100");
    const b = inboundExecutionKey("irc", "server:#channel", null, "user1", "s1:101");
    expect(a).not.toBe(b);
  });
});

describe("assistantMessageKey", () => {
  it("builds a deterministic key", () => {
    const a = assistantMessageKey("telegram", "chat1", null, "user1", "delivery-abc");
    const b = assistantMessageKey("telegram", "chat1", null, "user1", "delivery-abc");
    expect(a).toBe(b);
  });

  it("uses execution correlation when no delivery ID is available", () => {
    const execId = "exec-20260725-001";
    const key = assistantMessageKey("telegram", "chat1", null, "user1", execId);
    expect(typeof key).toBe("string");
  });

  it("throws for empty deliveredMessageId", () => {
    expect(() => assistantMessageKey("discord", "ch1", null, "user1", "")).toThrow("non-empty");
  });
});

describe("feedbackKey", () => {
  it("differentiates cite vs reject on same message", () => {
    const cite = feedbackKey("discord", "ch1", "user1", "msg1", 42, "cite");
    const reject = feedbackKey("discord", "ch1", "user1", "msg1", 42, "reject");
    expect(cite).not.toBe(reject);
  });

  it("differentiates across memory IDs", () => {
    const a = feedbackKey("discord", "ch1", "user1", "msg1", 1, "cite");
    const b = feedbackKey("discord", "ch1", "user1", "msg1", 2, "cite");
    expect(a).not.toBe(b);
  });

  it("replays the same reaction deterministically", () => {
    const a = feedbackKey("telegram", "chat1", "user1", "msg1", 7, "cite");
    const b = feedbackKey("telegram", "chat1", "user1", "msg1", 7, "cite");
    expect(a).toBe(b);
  });

  it("throws for empty messageId", () => {
    expect(() => feedbackKey("discord", "ch1", "user1", "", 1, "cite")).toThrow("non-empty");
  });

  it("throws for empty feedbackType", () => {
    expect(() => feedbackKey("discord", "ch1", "user1", "msg1", 1, "")).toThrow("non-empty");
  });
});
