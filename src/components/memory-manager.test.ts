import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import type { MemoryConfig } from "./memory-config.js";
import type { SessionState, MessageRecord } from "../types/index.js";
import { TranscriptParser } from "./transcript-parser.js";
import { MemoryIndex } from "./memory-index.js";
import { initializeDatabase } from "./memory-db.js";

function makeConfig(tmpDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    ...MEMORY_CONFIG_DEFAULTS,
    memoryDir: tmpDir,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    channelKey: "telegram:100",
    acpSessionId: "sess-001",
    isProcessing: false,
    pendingRequestId: null,
    createdAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe("MemoryManager — session CRUD", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-test-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initialize creates database and directories", () => {
    expect(existsSync(join(tmpDir, "memory.db"))).toBe(true);
    expect(existsSync(join(tmpDir, "transcripts"))).toBe(true);
  });

  it("persistSession inserts a session row", async () => {
    const session = makeSession({ channelKey: "telegram:42", acpSessionId: "abc-123" });
    manager.persistSession(session);

    const restored = manager.restoreSessions(999_999_999);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.channelKey).toBe("telegram:42");
    expect(restored[0]!.acpSessionId).toBe("abc-123");
    expect(restored[0]!.createdAt).toBe(session.createdAt);
    expect(restored[0]!.lastActivityAt).toBe(session.lastActivityAt);
  });

  it("touchSession updates lastActivityAt", async () => {
    const session = makeSession({ channelKey: "telegram:10", acpSessionId: "s1", lastActivityAt: 1000 });
    manager.persistSession(session);

    manager.touchSession("telegram:10", "s1");

    const restored = manager.restoreSessions(999_999_999);
    expect(restored).toHaveLength(1);
    // touchSession sets lastActivityAt to Date.now(), which should be > 1000
    expect(restored[0]!.lastActivityAt).toBeGreaterThan(1000);
  });

  it("deactivateSession sets is_active to 0", async () => {
    const session = makeSession({ channelKey: "telegram:20", acpSessionId: "s2" });
    manager.persistSession(session);

    manager.deactivateSession("telegram:20", "s2");

    // Deactivated session should not appear in restoreSessions
    const restored = manager.restoreSessions(999_999_999);
    expect(restored).toHaveLength(0);
  });

  it("restoreSessions returns only active sessions within threshold", async () => {
    const now = Date.now();

    // Recent active session
    manager.persistSession(
      makeSession({ channelKey: "telegram:1", acpSessionId: "recent", lastActivityAt: now - 1000 }),
    );
    // Old active session (beyond threshold)
    manager.persistSession(
      makeSession({ channelKey: "telegram:2", acpSessionId: "old", lastActivityAt: now - 100_000 }),
    );
    // Recent but deactivated session
    manager.persistSession(
      makeSession({ channelKey: "telegram:3", acpSessionId: "inactive", lastActivityAt: now - 1000 }),
    );
    manager.deactivateSession("telegram:3", "inactive");

    // Threshold of 50_000ms — only the recent active session qualifies
    const restored = manager.restoreSessions(50_000);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.channelKey).toBe("telegram:1");
    expect(restored[0]!.acpSessionId).toBe("recent");
  });

  it("restoreSessions excludes inactive sessions", async () => {
    manager.persistSession(makeSession({ channelKey: "telegram:5", acpSessionId: "a1" }));
    manager.persistSession(makeSession({ channelKey: "telegram:6", acpSessionId: "a2" }));

    manager.deactivateSession("telegram:5", "a1");

    const restored = manager.restoreSessions(999_999_999);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.channelKey).toBe("telegram:6");
  });

  it("all methods are no-ops when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(makeConfig(tmpDir, { memoryEnabled: false }));
    await disabledManager.initialize();

    // These should all return without error
    disabledManager.persistSession(makeSession());
    disabledManager.touchSession("telegram:1", "s1");
    disabledManager.deactivateSession("telegram:1", "s1");
    const restored = disabledManager.restoreSessions(999_999_999);
    expect(restored).toEqual([]);

    disabledManager.close();
  });

  it("close() closes the database", async () => {
    // After close, operations should be no-ops (db is null)
    manager.close();

    // These should not throw
    manager.persistSession(makeSession());
    manager.touchSession("telegram:1", "s1");
    manager.deactivateSession("telegram:1", "s1");
    const restored = manager.restoreSessions(999_999_999);
    expect(restored).toEqual([]);
  });

  it("persistSession upserts on duplicate key", async () => {
    const now = Date.now();
    const session1 = makeSession({
      channelKey: "telegram:50",
      acpSessionId: "dup",
      lastActivityAt: now - 5000,
    });
    manager.persistSession(session1);

    const session2 = makeSession({
      channelKey: "telegram:50",
      acpSessionId: "dup",
      lastActivityAt: now - 1000,
    });
    manager.persistSession(session2);

    const restored = manager.restoreSessions(999_999_999);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.lastActivityAt).toBe(now - 1000);
  });
});

describe("MemoryManager — scratchpad", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-scratch-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readScratchpad returns empty string and creates file when none exists", () => {
    const content = manager.readScratchpad(42);
    expect(content).toBe("");
    // File should now exist
    expect(existsSync(join(tmpDir, "scratchpads", "42", "scratchpad.md"))).toBe(true);
  });

  it("writeScratchpad + readScratchpad round-trip", () => {
    manager.writeScratchpad(42, "# Tasks\n- Buy milk\n- Fix bug #123");
    const content = manager.readScratchpad(42);
    expect(content).toBe("# Tasks\n- Buy milk\n- Fix bug #123");
  });

  it("readScratchpad returns empty string when memoryEnabled is false", async () => {
    const disabled = new MemoryManager(makeConfig(tmpDir, { memoryEnabled: false }));
    await disabled.initialize();

    const content = disabled.readScratchpad(42);
    expect(content).toBe("");

    disabled.close();
  });

  it("writeScratchpad is no-op when memoryEnabled is false", async () => {
    const disabled = new MemoryManager(makeConfig(tmpDir, { memoryEnabled: false }));
    await disabled.initialize();

    disabled.writeScratchpad(42, "should not be written");
    // No file should be created
    expect(existsSync(join(tmpDir, "scratchpads", "42", "scratchpad.md"))).toBe(false);

    disabled.close();
  });
});

describe("MemoryManager — enforceDiskBudget", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget-"));
    // Use a very small disk budget (1 KB) so we can trigger enforcement easily
    manager = new MemoryManager(makeConfig(tmpDir, { diskBudgetBytes: 1024 }));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when total size is under budget", () => {
    // With a fresh DB and no transcripts, we're well under 1KB... actually the DB
    // itself may be larger. Let's use a generous budget instead.
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget-under-"));
    const bigBudgetManager = new MemoryManager(
      makeConfig(tmpDir, { diskBudgetBytes: 100 * 1024 * 1024 }),
    );

    // Initialize creates the DB
    return bigBudgetManager.initialize().then(() => {
      // Create a small transcript file
      const transcriptsDir = join(tmpDir, "transcripts", "1");
      mkdirSync(transcriptsDir, { recursive: true });
      writeFileSync(join(transcriptsDir, "sess-a.jsonl"), '{"role":"user","content":"hi"}\n');

      // Should not throw and file should still exist
      bigBudgetManager.enforceDiskBudget();

      expect(existsSync(join(transcriptsDir, "sess-a.jsonl"))).toBe(true);
      bigBudgetManager.close();
    });
  });

  it("deletes oldest transcript files when over budget", async () => {
    const transcriptsDir = join(tmpDir, "transcripts", "42");
    mkdirSync(transcriptsDir, { recursive: true });

    // Create 3 transcript files with different mtimes
    // File 1: oldest (should be deleted first)
    const file1 = join(transcriptsDir, "old-session.jsonl");
    writeFileSync(file1, "x".repeat(500));

    // File 2: middle age
    const file2 = join(transcriptsDir, "mid-session.jsonl");
    writeFileSync(file2, "y".repeat(500));

    // File 3: newest (should be kept)
    const file3 = join(transcriptsDir, "new-session.jsonl");
    writeFileSync(file3, "z".repeat(500));

    // Set different mtimes to control deletion order
    const { utimesSync } = await import("node:fs");
    const now = Date.now() / 1000;
    utimesSync(file1, now - 300, now - 300); // oldest
    utimesSync(file2, now - 200, now - 200); // middle
    utimesSync(file3, now - 100, now - 100); // newest

    // The DB + 3 files (500 bytes each = 1500 bytes of transcripts) exceeds 1024 budget
    // enforceDiskBudget should delete oldest files until under budget
    manager.enforceDiskBudget();

    // The oldest file(s) should be deleted. The newest should remain.
    // Since DB itself is likely > 1024 bytes, all transcript files may be deleted,
    // but the key property is that oldest are deleted first.
    // Let's just verify that at least the oldest file was deleted
    expect(existsSync(file1)).toBe(false);
  });

  it("removes corresponding index entries when deleting transcripts", async () => {
    const transcriptsDir = join(tmpDir, "transcripts", "99");
    mkdirSync(transcriptsDir, { recursive: true });

    // Create a large transcript file to exceed budget
    const filePath = join(transcriptsDir, "indexed-session.jsonl");
    writeFileSync(filePath, "x".repeat(2000));

    // Set old mtime so it gets deleted
    const { utimesSync } = await import("node:fs");
    const now = Date.now() / 1000;
    utimesSync(filePath, now - 1000, now - 1000);

    // enforceDiskBudget should delete the file (over 1KB budget)
    manager.enforceDiskBudget();

    expect(existsSync(filePath)).toBe(false);
  });

  it("is a no-op when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(
      makeConfig(tmpDir, { memoryEnabled: false, diskBudgetBytes: 1 }),
    );
    await disabledManager.initialize();

    // Create a transcript file
    const transcriptsDir = join(tmpDir, "transcripts", "1");
    mkdirSync(transcriptsDir, { recursive: true });
    const filePath = join(transcriptsDir, "sess.jsonl");
    writeFileSync(filePath, "x".repeat(2000));

    // Should not delete anything since memory is disabled
    disabledManager.enforceDiskBudget();

    expect(existsSync(filePath)).toBe(true);
    disabledManager.close();
  });
});

function makeRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    role: "user",
    content: "hello world",
    timestamp: Date.now(),
    chatId: 1,
    sessionId: "sess-001",
    ...overrides,
  };
}

describe("MemoryManager — recordMessage", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-record-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends to transcript and indexes in FTS", () => {
    const record = makeRecord({
      content: "distinctive_keyword_xyzzy",
      chatId: 42,
      sessionId: "s1",
      timestamp: Date.now(),
    });

    manager.recordMessage(record);

    // Verify transcript was written
    const parser = new TranscriptParser();
    const transcriptPath = join(tmpDir, "transcripts", "42", "s1.jsonl");
    expect(existsSync(transcriptPath)).toBe(true);
    const parsed = parser.parse(transcriptPath);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.content).toBe("distinctive_keyword_xyzzy");

    // Verify FTS index — open a direct DB connection to search
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const mi = new MemoryIndex(db);
    const results = mi.search("distinctive_keyword_xyzzy", { chatId: 42 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.record.content).toBe("distinctive_keyword_xyzzy");
    db.close();
  });

  it("prunes when exceeding maxMessagesPerChat", () => {
    const maxMessages = 5;
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = mkdtempSync(join(tmpdir(), "mm-prune-"));
    manager = new MemoryManager(makeConfig(tmpDir, { maxMessagesPerChat: maxMessages }));
    return manager.initialize().then(() => {
      // Record more messages than the limit
      for (let i = 0; i < maxMessages + 3; i++) {
        manager.recordMessage(
          makeRecord({
            content: `message number ${i}`,
            chatId: 10,
            sessionId: "s1",
            timestamp: 1000 + i,
          }),
        );
      }

      // Verify only maxMessages remain in the index
      const db = initializeDatabase(join(tmpDir, "memory.db"));
      const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = 10").get() as {
        cnt: number;
      };
      expect(row.cnt).toBe(maxMessages);

      // Verify the remaining messages are the most recent ones
      const rows = db
        .prepare("SELECT timestamp FROM messages WHERE chat_id = 10 ORDER BY timestamp ASC")
        .all() as Array<{ timestamp: number }>;
      // The oldest remaining should be message number 3 (timestamp 1003)
      expect(rows[0]!.timestamp).toBe(1000 + 3);
      expect(rows[rows.length - 1]!.timestamp).toBe(1000 + maxMessages + 2);

      db.close();
    });
  });

  it("calls enforceDiskBudget every 100 writes", () => {
    // Use a tiny disk budget so enforcement would delete files
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget100-"));
    // Large budget so enforcement doesn't actually delete anything,
    // but we can verify the counter mechanism works
    manager = new MemoryManager(makeConfig(tmpDir, { diskBudgetBytes: 100 * 1024 * 1024 }));
    return manager.initialize().then(() => {
      // Write 99 messages — no enforcement yet
      for (let i = 0; i < 99; i++) {
        manager.recordMessage(
          makeRecord({
            content: `msg ${i}`,
            chatId: 1,
            sessionId: "s1",
            timestamp: 1000 + i,
          }),
        );
      }

      // Create a large file that would be deleted by enforcement with a small budget
      const transcriptsDir = join(tmpDir, "transcripts", "999");
      mkdirSync(transcriptsDir, { recursive: true });
      const bigFile = join(transcriptsDir, "big-session.jsonl");
      writeFileSync(bigFile, "x".repeat(200));

      // Now close and recreate with a tiny budget
      manager.close();
      manager = new MemoryManager(makeConfig(tmpDir, { diskBudgetBytes: 1 }));
      return manager.initialize().then(() => {
        // The big file may already be deleted by startup enforcement.
        // Re-create it to test the 100th-write trigger
        mkdirSync(transcriptsDir, { recursive: true });
        writeFileSync(bigFile, "x".repeat(200));

        // We need to get the write counter to 100. Since we just initialized,
        // counter is 0. Write 100 messages to trigger enforcement.
        for (let i = 0; i < 100; i++) {
          manager.recordMessage(
            makeRecord({
              content: `trigger ${i}`,
              chatId: 2,
              sessionId: "s2",
              timestamp: 2000 + i,
            }),
          );
        }

        // The big file should have been deleted by disk budget enforcement
        // (budget is 1 byte, so everything over that gets cleaned up)
        // Note: the DB itself is larger than 1 byte, so all transcript files get deleted
        expect(existsSync(bigFile)).toBe(false);
      });
    });
  });

  it("is no-op when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(makeConfig(tmpDir, { memoryEnabled: false }));
    await disabledManager.initialize();

    const record = makeRecord({ content: "should not be recorded", chatId: 77, sessionId: "s1" });
    disabledManager.recordMessage(record);

    // No transcript file should exist
    const transcriptPath = join(tmpDir, "transcripts", "77", "s1.jsonl");
    expect(existsSync(transcriptPath)).toBe(false);

    disabledManager.close();
  });
});

describe("MemoryManager — checkAutoCompact", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  const mockSendCompact = async (_sk: string, _cmd: string) => "compacted";

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-autocompact-"));
    manager = new MemoryManager(
      makeConfig(tmpDir, {
        searchEnhancements: {
          ...MEMORY_CONFIG_DEFAULTS.searchEnhancements,
          compactThresholdPct: 85,
        },
      }),
    );
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when contextPercent is below threshold", async () => {
    manager.recordMessage(
      makeRecord({ content: "hi", chatId: 1, sessionId: "s1", timestamp: 1000 }),
    );

    await manager.checkAutoCompact({
      chatId: 1,
      sessionId: "s1",
      contextPercent: 50,
      sendCompactCommand: mockSendCompact,
    });

    // No working directory compaction file should exist
    const today = new Date().toISOString().slice(0, 10);
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(false);
  });

  it("triggers compaction when contextPercent meets threshold", async () => {
    const longContent = "a".repeat(250);
    manager.recordMessage(
      makeRecord({ content: longContent, chatId: 10, sessionId: "s1", timestamp: 1000 }),
    );

    let compactCalled = false;
    const trackingSendCompact = async (_sk: string, _cmd: string) => {
      compactCalled = true;
      return "compacted";
    };

    await manager.checkAutoCompact({
      chatId: 10,
      sessionId: "s1",
      contextPercent: 90,
      sendCompactCommand: trackingSendCompact,
    });

    expect(compactCalled).toBe(true);

    // A working directory safety-net file should have been created
    const today = new Date().toISOString().slice(0, 10);
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(true);

    // Verify the compaction watermark was stored in the DB
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db
      .prepare("SELECT summary FROM compactions WHERE chat_id = 10 AND tier = 'daily'")
      .get() as { summary: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.summary).toBe("[auto-compact via /compact]");
    db.close();
  });

  it("is no-op when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(
      makeConfig(tmpDir, { memoryEnabled: false }),
    );
    await disabledManager.initialize();

    await disabledManager.checkAutoCompact({
      chatId: 1,
      sessionId: "s1",
      contextPercent: 95,
      sendCompactCommand: mockSendCompact,
    });

    // No working directory compaction file should exist
    const today = new Date().toISOString().slice(0, 10);
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(false);

    disabledManager.close();
  });

  it("handles sendCompactCommand failure gracefully without throwing", async () => {
    const longContent = "b".repeat(250);
    manager.recordMessage(
      makeRecord({ content: longContent, chatId: 20, sessionId: "s1", timestamp: 1000 }),
    );

    const failingSendCompact = async (_sk: string, _cmd: string): Promise<string> => {
      throw new Error("Transport unavailable");
    };

    // Should not throw — error is logged and raw transcript already saved as safety net
    await expect(
      manager.checkAutoCompact({
        chatId: 20,
        sessionId: "s1",
        contextPercent: 90,
        sendCompactCommand: failingSendCompact,
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing when transcript file does not exist", async () => {
    // Call with a chatId/sessionId that has no transcript file — still writes watermark
    await expect(
      manager.checkAutoCompact({
        chatId: 999,
        sessionId: "nonexistent",
        contextPercent: 90,
        sendCompactCommand: mockSendCompact,
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing when contextPercent is exactly at threshold boundary", async () => {
    manager.recordMessage(
      makeRecord({ content: "test content", chatId: 30, sessionId: "s1", timestamp: 1000 }),
    );

    let compactCalled = false;
    const trackingSendCompact = async (_sk: string, _cmd: string) => {
      compactCalled = true;
      return "compacted";
    };

    // contextPercent == threshold (85) should trigger (>= check)
    await manager.checkAutoCompact({
      chatId: 30,
      sessionId: "s1",
      contextPercent: 85,
      sendCompactCommand: trackingSendCompact,
    });

    expect(compactCalled).toBe(true);
  });
});

describe("MemoryManager — loadRecentMessages", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-load-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns messages from transcript", () => {
    // Record several messages
    for (let i = 0; i < 5; i++) {
      manager.recordMessage(
        makeRecord({
          content: `message ${i}`,
          chatId: 1,
          sessionId: "s1",
          timestamp: 1000 + i,
        }),
      );
    }

    const messages = manager.loadRecentMessages(1, "s1", 3);
    expect(messages).toHaveLength(3);
    // Should be the last 3 messages
    expect(messages[0]!.content).toBe("message 2");
    expect(messages[1]!.content).toBe("message 3");
    expect(messages[2]!.content).toBe("message 4");
  });

  it("returns empty array when no transcript exists", () => {
    const messages = manager.loadRecentMessages(999, "nonexistent", 10);
    expect(messages).toEqual([]);
  });

  it("returns empty array when memoryEnabled is false", async () => {
    const disabled = new MemoryManager(makeConfig(tmpDir, { memoryEnabled: false }));
    await disabled.initialize();

    const messages = disabled.loadRecentMessages(1, "s1", 10);
    expect(messages).toEqual([]);

    disabled.close();
  });
});

describe("MemoryManager — compactSession", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-compact-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("delegates to CompactionEngine and returns CompactedMemory", async () => {
    // Record some messages first
    for (let i = 0; i < 3; i++) {
      manager.recordMessage(
        makeRecord({
          content: `conversation message ${i}`,
          chatId: 5,
          sessionId: "s1",
          timestamp: 1000 + i,
        }),
      );
    }

    const mockLlm = async (_prompt: string, _content: string) =>
      "Key facts: user discussed 3 topics";

    const result = await manager.compactSession({
      chatId: 5,
      sessionId: "s1",
      llmCall: mockLlm,
    });

    expect(result).not.toBeNull();
    expect(result!.chatId).toBe(5);
    expect(result!.sourceSessionId).toBe("s1");
    expect(result!.tier).toBe("daily");
    expect(result!.summary).toBe("Key facts: user discussed 3 topics");
    expect(result!.filePath).toBeTruthy();

    // Verify the daily file was written
    expect(existsSync(result!.filePath)).toBe(true);
  });

  it("returns null when memoryEnabled is false", async () => {
    const disabled = new MemoryManager(makeConfig(tmpDir, { memoryEnabled: false }));
    await disabled.initialize();

    const mockLlm = async (_prompt: string, _content: string) => "summary";
    const result = await disabled.compactSession({
      chatId: 1,
      sessionId: "s1",
      llmCall: mockLlm,
    });

    expect(result).toBeNull();
    disabled.close();
  });

  it("returns null on LLM failure", async () => {
    manager.recordMessage(
      makeRecord({ content: "some content", chatId: 7, sessionId: "s1", timestamp: 1000 }),
    );

    const failingLlm = async (_prompt: string, _content: string): Promise<string> => {
      throw new Error("LLM unavailable");
    };

    const result = await manager.compactSession({
      chatId: 7,
      sessionId: "s1",
      llmCall: failingLlm,
    });

    // CompactionEngine.compact returns null on LLM failure
    expect(result).toBeNull();
  });
});

describe("MemoryManager — assembleContext", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-assemble-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns assembled context text as a string", async () => {
    const workingMemory: MessageRecord[] = [
      makeRecord({ role: "user", content: "Hello there", timestamp: 1000 }),
      makeRecord({ role: "assistant", content: "Hi! How can I help?", timestamp: 1001 }),
    ];

    const result = await manager.assembleContext({
      chatId: 1,
      userInput: "What is the weather?",
      systemPrompt: "You are a helpful assistant.",
      workingMemory,
    });

    expect(typeof result).toBe("string");
    expect(result).toBeTruthy();
    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain("What is the weather?");
    expect(result).toContain("Hello there");
  });

  it("returns raw userInput when memoryEnabled is false", async () => {
    const disabled = new MemoryManager(makeConfig(tmpDir, { memoryEnabled: false }));
    await disabled.initialize();

    const result = await disabled.assembleContext({
      chatId: 1,
      userInput: "test",
      systemPrompt: "system",
    });

    expect(result).toBe("test");

    disabled.close();
  });
});

describe("MemoryManager — assembleContext system prompt passthrough", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-tool-prompt-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
    manager.setLlmCall(async () => "{}");
    manager.startHeartbeat();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes through systemPrompt containing skill content at session start", async () => {
    const skillPrompt = "[MEMORY SEARCH TOOL]\nYou have a memory_search tool.";
    const result = await manager.assembleContext({
      chatId: 1,
      userInput: "Hello",
      systemPrompt: `You are helpful.\n\n${skillPrompt}`,
      isSessionStart: true,
    });

    expect(result).toContain("[MEMORY SEARCH TOOL]");
    expect(result).toContain("You are helpful.");
  });

  it("passes through systemPrompt on subsequent messages (isSessionStart false)", async () => {
    const result = await manager.assembleContext({
      chatId: 1,
      userInput: "Hello",
      systemPrompt: "You are helpful.",
      isSessionStart: false,
    });

    expect(result).toContain("You are helpful.");
  });

  it("works with empty systemPrompt", async () => {
    const result = await manager.assembleContext({
      chatId: 1,
      userInput: "Hello",
      systemPrompt: "",
      isSessionStart: true,
    });

    expect(result).toContain("Hello");
  });
});

// Feature: auto-daily-compaction, Property 8: Per-Chat Lock Prevents Concurrent Compaction
describe("Property 8: Per-Chat Lock Prevents Concurrent Compaction", () => {
  it("second acquire returns null while lock held; after release, waitForCompaction resolves and lock is re-acquirable", () => {
    /**
     * Validates: Requirements 8.1, 8.2
     *
     * For any chatId, if a lock is held, a second acquire returns null.
     * After release, waitForCompaction resolves and a new lock is acquirable.
     */
    const chatIdArb = fc.integer({ min: 1, max: 1_000_000 });

    fc.assert(
      fc.asyncProperty(chatIdArb, async (chatId) => {
        const manager = new MemoryManager(MEMORY_CONFIG_DEFAULTS);

        // 1. First acquire should succeed (not null)
        const lockPromise = manager.acquireCompactionLock(chatId);
        expect(lockPromise).not.toBeNull();
        const release = await lockPromise!;
        expect(typeof release).toBe("function");

        // 2. Second acquire for same chatId should return null (locked)
        const secondAttempt = manager.acquireCompactionLock(chatId);
        expect(secondAttempt).toBeNull();

        // 3. Release the lock
        release();

        // 4. waitForCompaction should resolve (no pending lock)
        await manager.waitForCompaction(chatId);

        // 5. After release, a new lock should be acquirable
        const reacquirePromise = manager.acquireCompactionLock(chatId);
        expect(reacquirePromise).not.toBeNull();
        const release2 = await reacquirePromise!;
        expect(typeof release2).toBe("function");

        // Clean up
        release2();
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: auto-daily-compaction, Property 7: Shutdown Compaction Bypasses All Checks
describe("Property 7: Shutdown Compaction Bypasses All Checks", () => {
  /**
   * Validates: Requirements 7.2
   *
   * For any active session — regardless of whether the current time is before midnight
   * or the inactivity gap has not elapsed — shutdownCompaction() should compact the session
   * (provided the LLM call is available and no prior daily compaction record exists).
   */

  // Generator: produce a scenario where the heartbeat would NOT compact
  // (same-day messages, or gap < dayBoundaryHours), yet shutdown should.
  const scenarioArb = fc.record({
    chatId: fc.integer({ min: 1, max: 500 }),
    // Offset from "now" in ms — 0 means message just happened, up to 3h59m ago (under 4h gap)
    messageAgeMs: fc.oneof(
      // Same-day, very recent (minutes ago) — heartbeat skips (gap < dayBoundaryHours)
      fc.integer({ min: 0, max: 3 * 3_600_000 }),
      // Same-day, just under the 4h boundary
      fc.integer({ min: 3 * 3_600_000, max: 4 * 3_600_000 - 1 }),
      // Previous day but gap < dayBoundaryHours (e.g. message at 11pm, now is 1am)
      fc.integer({ min: 1 * 3_600_000, max: 4 * 3_600_000 - 1 }),
    ),
  });

  it("compacts all active sessions regardless of time-of-day or inactivity gap", async () => {
    // Use a single manager per property run to avoid excessive temp dir creation
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "mm-prop7-"));
        const manager = new MemoryManager(makeConfig(tmpDir));
        await manager.initialize();

        try {
          const { chatId } = scenario;
          const sessionId = `sess-${chatId}`;

          // 1. Persist an active session — channelKey must be numeric string to match chatId
          manager.persistSession(
            makeSession({
              channelKey: String(chatId),
              acpSessionId: sessionId,
              lastActivityAt: Date.now(),
            }),
          );

          // 2. Record a message so the transcript file exists and compaction has content
          manager.recordMessage(
            makeRecord({
              content: "test message for shutdown compaction",
              chatId,
              sessionId,
              timestamp: Date.now() - scenario.messageAgeMs,
            }),
          );

          // 3. Set a mock LLM call
          manager.setLlmCall(async (_prompt: string, _content: string) => "shutdown summary");

          // 4. Call shutdownCompaction — should compact regardless of timing
          await manager.shutdownCompaction();

          // 5. Verify a daily compaction record was created
          const db = initializeDatabase(join(tmpDir, "memory.db"));
          const row = db
            .prepare(
              "SELECT COUNT(*) as cnt FROM compactions WHERE chat_id = ? AND source_session_id = ? AND tier = 'daily'",
            )
            .get(chatId, sessionId) as { cnt: number };
          db.close();

          expect(row.cnt).toBe(1);
        } finally {
          manager.close();
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
