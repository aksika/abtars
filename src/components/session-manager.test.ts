import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { MemoryManager } from "./memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS, type MemoryConfig } from "./memory-config.js";
import type { AcpClient } from "./acp-client.js";

function makeConfig(tmpDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir, ...overrides };
}

let sessionCounter = 0;
function makeMockAcpClient(): AcpClient {
  return {
    createSession: vi.fn(async () => `acp-sess-${++sessionCounter}`),
    cancelSession: vi.fn(async () => {}),
  } as unknown as AcpClient;
}

describe("SessionManager + MemoryManager integration", () => {
  let tmpDir: string;
  let memory: MemoryManager;
  let acpClient: AcpClient;
  let sm: SessionManager;

  beforeEach(async () => {
    sessionCounter = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "sm-int-"));
    memory = new MemoryManager(makeConfig(tmpDir));
    await memory.initialize();
    acpClient = makeMockAcpClient();
    sm = new SessionManager(acpClient, "/tmp/work", memory);
  });

  afterEach(() => {
    memory.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getOrCreateSession persists session to memory", async () => {
    const session = await sm.getOrCreateSession(42);
    expect(session.channelKey).toBe(42);
    expect(session.acpSessionId).toBe("acp-sess-1");

    // Session should be in SQLite
    const restored = memory.restoreSessions(999_999_999);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.channelKey).toBe(42);
    expect(restored[0]!.acpSessionId).toBe("acp-sess-1");
  });

  it("getOrCreateSession touches existing session in memory", async () => {
    const session = await sm.getOrCreateSession(10);
    const firstActivity = session.lastActivityAt;

    // Wait a tick so timestamp differs
    await new Promise((r) => setTimeout(r, 10));
    await sm.getOrCreateSession(10);

    const restored = memory.restoreSessions(999_999_999);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.lastActivityAt).toBeGreaterThan(firstActivity);
  });

  it("resetSession deactivates session in memory", async () => {
    await sm.getOrCreateSession(20);
    await sm.resetSession(20);

    // Old session should be deactivated, new one should be active
    const restored = memory.restoreSessions(999_999_999);
    // The new session from resetSession should be persisted
    expect(restored).toHaveLength(1);
    expect(restored[0]!.acpSessionId).toBe("acp-sess-2"); // new session
  });

  it("restoreFromMemory loads sessions from SQLite", async () => {
    // Create sessions with first SessionManager
    await sm.getOrCreateSession(100);
    await sm.getOrCreateSession(200);

    // Create a new SessionManager (simulating restart)
    const sm2 = new SessionManager(acpClient, "/tmp/work", memory);
    const count = await sm2.restoreFromMemory();

    expect(count).toBe(2);
    // Both sessions should be accessible
    expect(sm2.getSession(100)).toBeDefined();
    expect(sm2.getSession(200)).toBeDefined();
    // They get new ACP session IDs (since ACP backend is fresh)
    expect(sm2.getSession(100)!.acpSessionId).toBe("acp-sess-3");
    expect(sm2.getSession(200)!.acpSessionId).toBe("acp-sess-4");
  });

  it("restoreFromMemory skips stale sessions", async () => {
    // Persist a session with old lastActivityAt
    memory.persistSession({
      channelKey: "telegram:300",
      acpSessionId: "old-sess",
      isProcessing: false,
      pendingRequestId: null,
      createdAt: Date.now() - 48 * 3600_000,
      lastActivityAt: Date.now() - 48 * 3600_000, // 48h ago
    });

    const sm2 = new SessionManager(acpClient, "/tmp/work", memory);
    const count = await sm2.restoreFromMemory();

    // 24h threshold in restoreFromMemory — 48h old session should be skipped
    expect(count).toBe(0);
  });

  it("works without memory (null memory)", async () => {
    const smNoMem = new SessionManager(acpClient, "/tmp/work");
    const session = await smNoMem.getOrCreateSession(50);
    expect(session.channelKey).toBe(50);

    await smNoMem.resetSession(50);
    const count = await smNoMem.restoreFromMemory();
    expect(count).toBe(0);
  });

  it("handleCrash creates new session and persists it", async () => {
    await sm.getOrCreateSession(60);
    const msg = await sm.handleCrash(60);

    expect(msg).toContain("new session");
    const session = sm.getSession(60);
    expect(session).toBeDefined();

    const restored = memory.restoreSessions(999_999_999);
    // Should have the new session persisted
    const match = restored.find((s) => s.channelKey === 60);
    expect(match).toBeDefined();
  });
});
