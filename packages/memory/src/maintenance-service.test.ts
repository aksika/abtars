import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "../../../src/tests/helpers.js";

describe("MaintenanceService — forget operations", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "maint-test-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize();
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertMessage(chatId: number, sessionId: string, content: string, ts = Date.now()): void {
    mm.getDb()!.prepare(
      "INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)",
    ).run(chatId, sessionId, content, ts);
  }

  function messageCount(chatId: number): number {
    return (mm.getDb()!.prepare("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?").get(chatId) as { cnt: number }).cnt;
  }

  // --- forgetSession ---

  it("forgetSession deletes all messages for a session", () => {
    insertMessage(1, "s1", "keep this");
    insertMessage(1, "s2", "delete this");
    insertMessage(1, "s2", "delete this too");

    const result = mm.maintenance.forgetSession(1, "s2");

    expect(result.messagesRemoved).toBe(2);
    expect(messageCount(1)).toBe(1);
  });

  it("forgetSession returns zero when session has no messages", () => {
    insertMessage(1, "s1", "only session");

    const result = mm.maintenance.forgetSession(1, "nonexistent");

    expect(result.messagesRemoved).toBe(0);
    expect(messageCount(1)).toBe(1);
  });

  it("forgetSession does not affect other chats", () => {
    insertMessage(1, "s1", "chat 1");
    insertMessage(2, "s1", "chat 2 same session name");

    const result = mm.maintenance.forgetSession(1, "s1");

    expect(result.messagesRemoved).toBe(1);
    expect(messageCount(2)).toBe(1);
  });

  // --- forgetRange ---

  it("forgetRange deletes messages within date range", () => {
    const base = Date.now();
    insertMessage(1, "s1", "before range", base - 5000);
    insertMessage(1, "s1", "in range 1", base - 3000);
    insertMessage(1, "s1", "in range 2", base - 2000);
    insertMessage(1, "s1", "after range", base);

    const result = mm.maintenance.forgetRange(1, new Date(base - 4000), new Date(base - 1000));

    expect(result.messagesRemoved).toBe(2);
    expect(messageCount(1)).toBe(2);
  });

  it("forgetRange returns zero when no messages in range", () => {
    insertMessage(1, "s1", "message", Date.now());

    const result = mm.maintenance.forgetRange(1, new Date(0), new Date(1000));

    expect(result.messagesRemoved).toBe(0);
  });

  // --- forgetTopic ---

  it("forgetTopic returns zero when no matches above threshold", async () => {
    insertMessage(1, "s1", "completely unrelated content");

    const result = await mm.maintenance.forgetTopic(1, "quantum", 0.99);

    expect(result.messagesRemoved).toBe(0);
  });

  // --- readCoreKnowledge ---

  it("readCoreKnowledge reads user_profile.md and agent_notes.md", () => {
    const coreDir = join(tmpDir, "core");
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, "user_profile.md"), "Name: Test User");
    writeFileSync(join(coreDir, "agent_notes.md"), "Prefers dark mode");

    const result = mm.readCoreKnowledge();

    expect(result).toContain("Test User");
    expect(result).toContain("dark mode");
  });

  it("readCoreKnowledge returns empty string when core dir missing", () => {
    expect(mm.readCoreKnowledge()).toBe("");
  });

  // --- getStats ---

  it("getStats returns correct counts", async () => {
    insertMessage(1, "s1", "hello");
    insertMessage(1, "s1", "world");
    await mm.editor.instantStore({
      chatId: 1, contentEn: "test fact", contentOriginal: "teszt", memoryType: "fact", emotionScore: 0,
    });

    const stats = mm.getStats();

    expect(stats).not.toBeNull();
    expect(stats!.totalMessages).toBe(2);
    expect(stats!.extractedMemories).toBe(1);
    expect(stats!.extractedByType["fact"]).toBe(1);
  });
});
