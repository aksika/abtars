import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import type { MemoryConfig } from "./memory-config.js";
import type { SessionState, MessageRecord } from "../types/index.js";
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

  it("initialize creates database", () => {
    expect(existsSync(join(tmpDir, "memory.db"))).toBe(true);
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

describe("MemoryManager — enforceDiskBudget", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget-"));
    manager = new MemoryManager(makeConfig(tmpDir, { diskBudgetBytes: 1024 }));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not throw when DB is under budget", async () => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget-under-"));
    const bigBudgetManager = new MemoryManager(
      makeConfig(tmpDir, { diskBudgetBytes: 100 * 1024 * 1024 }),
    );
    await bigBudgetManager.initialize();
    expect(() => bigBudgetManager.enforceDiskBudget()).not.toThrow();
    bigBudgetManager.close();
  });

  it("is a no-op when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(
      makeConfig(tmpDir, { memoryEnabled: false, diskBudgetBytes: 1 }),
    );
    await disabledManager.initialize();
    expect(() => disabledManager.enforceDiskBudget()).not.toThrow();
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

  it("stores raw content in DB and indexes in FTS", () => {
    const record = makeRecord({
      content: "distinctive_keyword_xyzzy",
      chatId: 42,
      sessionId: "s1",
      timestamp: Date.now(),
    });

    manager.recordMessage(record);

    // Verify DB has raw content
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT content FROM messages WHERE chat_id = 42").get() as { content: string };
    expect(row.content).toBe("distinctive_keyword_xyzzy");

    // Verify FTS index
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

  it("calls enforceDiskBudget every 100 writes", async () => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget100-"));
    manager = new MemoryManager(makeConfig(tmpDir, { diskBudgetBytes: 100 * 1024 * 1024 }));
    await manager.initialize();

    // Write 100 messages — should trigger enforcement without throwing
    for (let i = 0; i < 100; i++) {
      manager.recordMessage(
        makeRecord({
          content: `msg ${i}`,
          chatId: 1,
          sessionId: "s1",
          timestamp: 1000 + i,
        }),
      );
    }

    // Verify all 100 messages were recorded
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = 1").get() as { cnt: number };
    expect(row.cnt).toBe(100);
    db.close();
  });

  it("is no-op when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(makeConfig(tmpDir, { memoryEnabled: false }));
    await disabledManager.initialize();

    const record = makeRecord({ content: "should not be recorded", chatId: 77, sessionId: "s1" });
    disabledManager.recordMessage(record);

    // No DB entries should exist
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = 77").get() as { cnt: number };
    expect(row.cnt).toBe(0);
    db.close();

    disabledManager.close();
  });

  it("skips pure-whitespace messages", () => {
    const record = makeRecord({ content: "   ", chatId: 42, sessionId: "s1", timestamp: Date.now() });
    manager.recordMessage(record);

    // But DB should have no messages (empty after emoji strip)
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = 42").get() as { cnt: number };
    expect(row.cnt).toBe(0);
    db.close();
  });

  it("stores platform_message_id and updates emotion_score via updateEmotionByPlatformId", () => {
    const record = makeRecord({ content: "hello world", chatId: 1, sessionId: "s1", timestamp: Date.now(), platformMessageId: 999 });
    manager.recordMessage(record);

    // Verify platform_message_id stored
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT platform_message_id, emotion_score FROM messages WHERE chat_id = 1").get() as { platform_message_id: number; emotion_score: number };
    expect(row.platform_message_id).toBe(999);
    expect(row.emotion_score).toBe(0);
    db.close();

    // Update emotion score
    const updated = manager.updateEmotionByPlatformId(1, 999, 3);
    expect(updated).toBe(true);

    const db2 = initializeDatabase(join(tmpDir, "memory.db"));
    const row2 = db2.prepare("SELECT emotion_score FROM messages WHERE chat_id = 1 AND platform_message_id = 999").get() as { emotion_score: number };
    expect(row2.emotion_score).toBe(3);
    db2.close();
  });

  it("updateEmotionByPlatformId returns false when message not found", () => {
    const updated = manager.updateEmotionByPlatformId(1, 12345, 3);
    expect(updated).toBe(false);
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

    // No working directory consolidation file should exist
    const today = new Date().toISOString().slice(0, 10);
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(false);
  });

  it("triggers consolidation when contextPercent meets threshold", async () => {
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

    // A working directory consolidation file should have been created
    const today = new Date().toISOString().slice(0, 10);
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(true);
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

    // No working directory consolidation file should exist
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

  it("does nothing when no messages exist for session", async () => {
    // Call with a chatId/sessionId that has no messages
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

  it("returns messages from DB", () => {
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

  it("returns empty array when no messages exist", () => {
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

describe("MemoryManager — chat_backup", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-backup-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recordMessage inserts a row into chat_backup", () => {
    manager.recordMessage(
      makeRecord({ content: "backup test", chatId: 42, sessionId: "s1", timestamp: Date.now() }),
    );

    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db
      .prepare("SELECT content, chat_id FROM chat_backup WHERE chat_id = 42")
      .get() as { content: string; chat_id: number } | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.content).toBe("backup test");
  });

  it("pruneBackup deletes rows older than 7 days on initialize", async () => {
    // Insert old and recent rows directly
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const eightDaysAgo = Date.now() - 8 * 24 * 3_600_000;
    const oneDayAgo = Date.now() - 1 * 24 * 3_600_000;
    db.prepare("INSERT INTO chat_backup (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run(1, "s1", "user", "old message", eightDaysAgo);
    db.prepare("INSERT INTO chat_backup (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run(1, "s1", "user", "recent message", oneDayAgo);
    db.close();

    // Re-initialize triggers pruneBackup
    manager.close();
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();

    const db2 = initializeDatabase(join(tmpDir, "memory.db"));
    const rows = db2.prepare("SELECT content FROM chat_backup ORDER BY timestamp").all() as { content: string }[];
    db2.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("recent message");
  });

  it("pruneBackup keeps all rows when none are older than 7 days", async () => {
    manager.recordMessage(
      makeRecord({ content: "msg1", chatId: 1, timestamp: Date.now() - 3 * 24 * 3_600_000 }),
    );
    manager.recordMessage(
      makeRecord({ content: "msg2", chatId: 1, timestamp: Date.now() }),
    );

    // Re-initialize triggers pruneBackup
    manager.close();
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();

    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const count = db.prepare("SELECT COUNT(*) as cnt FROM chat_backup").get() as { cnt: number };
    db.close();

    expect(count.cnt).toBe(2);
  });
});
