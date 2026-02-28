import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS, type MemoryConfig } from "./memory-config.js";
import type { MessageRecord } from "../types/index.js";

function makeConfig(tmpDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir, ...overrides };
}

function makeRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    role: "user",
    content: "hello",
    timestamp: Date.now(),
    chatId: 1,
    sessionId: "s1",
    ...overrides,
  };
}

describe("Memory system — end-to-end smoke test", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-mem-"));
    mm = new MemoryManager(makeConfig(tmpDir));
    await mm.initialize();
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full lifecycle: record → search → compact → restore → context → budget", async () => {
    const chatId = 42;
    const sess1 = "sess-alpha";
    const sess2 = "sess-beta";

    // 1. Record messages across two sessions
    for (let i = 0; i < 5; i++) {
      mm.recordMessage(makeRecord({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `session1 message ${i} about quantum physics`,
        chatId,
        sessionId: sess1,
        timestamp: 1000 + i,
      }));
    }
    for (let i = 0; i < 5; i++) {
      mm.recordMessage(makeRecord({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `session2 message ${i} about machine learning`,
        chatId,
        sessionId: sess2,
        timestamp: 2000 + i,
      }));
    }

    // 2. Search for a keyword — verify results
    const searchResults = await mm.search("quantum", { chatId });
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults[0]!.record.content).toContain("quantum");

    const mlResults = await mm.search("machine learning", { chatId });
    expect(mlResults.length).toBeGreaterThanOrEqual(1);

    // 3. Compact session 1 — verify daily .md file
    const mockLlm = async (_prompt: string, _content: string) =>
      "User discussed quantum physics across 5 messages.";
    const compacted = await mm.compactSession({ chatId, sessionId: sess1, llmCall: mockLlm });
    expect(compacted).not.toBeNull();
    expect(compacted!.tier).toBe("daily");
    expect(existsSync(compacted!.filePath)).toBe(true);

    // Compaction should be searchable
    const compactionSearch = await mm.search("quantum physics", { chatId });
    expect(compactionSearch.length).toBeGreaterThanOrEqual(1);

    // 4. Load recent messages from session 2 — verify count
    const recent = mm.loadRecentMessages(chatId, sess2, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.content).toContain("session2 message 2");
    expect(recent[2]!.content).toContain("session2 message 4");

    // 5. Assemble context — verify tiers present
    const workingMemory = [
      makeRecord({ role: "user", content: "Tell me about physics", timestamp: 9000 }),
      makeRecord({ role: "assistant", content: "Physics is fascinating", timestamp: 9001 }),
    ];
    const ctx = await mm.assembleContext({
      chatId,
      userInput: "What did we discuss about quantum?",
      systemPrompt: "You are a helpful assistant.",
      workingMemory,
    });
    expect(ctx.text).toContain("[SYSTEM]");
    expect(ctx.text).toContain("[INPUT]");
    expect(ctx.text).toContain("What did we discuss about quantum?");
    expect(ctx.usage.soul).toBeGreaterThan(0);
    expect(ctx.usage.input).toBeGreaterThan(0);
    expect(ctx.usage.total).toBe(
      ctx.usage.soul + ctx.usage.scratchpad + ctx.usage.recalled +
      ctx.usage.working + ctx.usage.input,
    );

    // 6. Scratchpad round-trip
    mm.writeScratchpad(chatId, "# TODO\n- Review quantum notes");
    const pad = mm.readScratchpad(chatId);
    expect(pad).toBe("# TODO\n- Review quantum notes");

    // 7. Session persistence round-trip
    mm.persistSession({
      channelKey: `telegram:${chatId}`,
      acpSessionId: sess1,
      isProcessing: false,
      pendingRequestId: null,
      createdAt: 1000,
      lastActivityAt: Date.now(),
    });
    const restored = mm.restoreSessions(999_999_999);
    expect(restored.length).toBeGreaterThanOrEqual(1);
    expect(restored.find((s) => s.channelKey === `telegram:${chatId}`)).toBeDefined();

    // 8. Close and reinitialize — verify data survives
    mm.close();
    mm = new MemoryManager(makeConfig(tmpDir));
    await mm.initialize();

    const restoredAfterRestart = mm.restoreSessions(999_999_999);
    expect(restoredAfterRestart.length).toBeGreaterThanOrEqual(1);

    const searchAfterRestart = await mm.search("quantum", { chatId });
    expect(searchAfterRestart.length).toBeGreaterThanOrEqual(1);
  });

  it("disk budget enforcement deletes oldest transcripts", async () => {
    // Use a tiny budget
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-budget-"));
    mm = new MemoryManager(makeConfig(tmpDir, { diskBudgetBytes: 1 }));
    await mm.initialize();

    // Record enough messages to create transcript files
    for (let i = 0; i < 10; i++) {
      mm.recordMessage(makeRecord({
        content: `budget test message ${i} with some padding text to increase file size`,
        chatId: 1,
        sessionId: "s1",
        timestamp: 1000 + i,
      }));
    }

    // Force budget enforcement
    mm.enforceDiskBudget();

    // Transcript file should be deleted (budget is 1 byte, DB alone exceeds it)
    const transcriptPath = join(tmpDir, "transcripts", "1", "s1.jsonl");
    expect(existsSync(transcriptPath)).toBe(false);
  });

  it("auto-compaction triggers when transcript exceeds threshold", async () => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-autocompact-"));
    mm = new MemoryManager(makeConfig(tmpDir, { autoCompactThreshold: 50 }));
    await mm.initialize();

    // Record a message with enough content to exceed 50 tokens (200+ chars)
    mm.recordMessage(makeRecord({
      content: "x".repeat(250),
      chatId: 10,
      sessionId: "s1",
      timestamp: 1000,
    }));

    const mockLlm = async () => "Auto-compacted summary of session.";
    await mm.checkAutoCompact({ chatId: 10, sessionId: "s1", llmCall: mockLlm });

    // Daily compaction file should exist
    const dailyDir = join(tmpDir, "memory", "daily", "10");
    expect(existsSync(dailyDir)).toBe(true);
  });
});
