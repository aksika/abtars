import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusBroadcaster } from "./status-broadcaster.js";
import type { StatusSnapshot } from "./dashboard-config.js";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal mock snapshot for testing. */
function makeSnapshot(overrides?: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    timestamp: new Date().toISOString(),
    uptimeMs: 1000,
    platforms: {
      telegram: { configured: true, running: false },
      discord: { configured: false, running: false },
    },
    transport: { type: "tmux", ready: true, contextPercent: 42 },
    memory: { enabled: false, stats: null },
    heartbeat: { running: false, intervalMs: 60000, taskNames: [] },
    ...overrides,
  };
}

/** Create a mock WebSocket that records sent messages. */
function mockWs(): WebSocket & { sent: string[] } {
  const emitter = new EventEmitter() as WebSocket & { sent: string[] };
  emitter.sent = [];
  emitter.readyState = WebSocket.OPEN;
  emitter.send = vi.fn((data: string) => {
    emitter.sent.push(data);
  }) as any;
  emitter.close = vi.fn() as any;
  return emitter;
}

/** Create a mock WebSocket whose send() throws (simulating a broken connection). */
function brokenWs(): WebSocket {
  const emitter = new EventEmitter() as WebSocket;
  emitter.readyState = WebSocket.OPEN;
  emitter.send = vi.fn(() => {
    throw new Error("write EPIPE");
  }) as any;
  emitter.close = vi.fn() as any;
  return emitter;
}

// ── StatusBroadcaster ───────────────────────────────────────────────────────

describe("StatusBroadcaster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends an immediate snapshot when a client is added", () => {
    const snapshot = makeSnapshot();
    const broadcaster = new StatusBroadcaster(() => snapshot, 5000);
    const ws = mockWs();

    broadcaster.addClient(ws);

    expect(ws.send).toHaveBeenCalledOnce();
    const json = ws.sent[0]!;
    expect(JSON.parse(json)).toEqual(snapshot);

    broadcaster.shutdown();
  });

  it("starts interval on first client and stops on last removal", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 5000);
    const s1 = mockWs();
    const s2 = mockWs();

    expect(broadcaster.isBroadcasting).toBe(false);

    broadcaster.addClient(s1);
    expect(broadcaster.isBroadcasting).toBe(true);

    broadcaster.addClient(s2);
    expect(broadcaster.isBroadcasting).toBe(true);

    broadcaster.removeClient(s1);
    expect(broadcaster.isBroadcasting).toBe(true);

    broadcaster.removeClient(s2);
    expect(broadcaster.isBroadcasting).toBe(false);
  });

  it("broadcasts to all clients on interval tick", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 1000);
    const s1 = mockWs();
    const s2 = mockWs();

    broadcaster.addClient(s1);
    broadcaster.addClient(s2);

    (s1.send as any).mockClear();
    (s2.send as any).mockClear();

    vi.advanceTimersByTime(1000);

    expect(s1.send).toHaveBeenCalledOnce();
    expect(s2.send).toHaveBeenCalledOnce();

    broadcaster.shutdown();
  });

  it("pushNow sends to all clients immediately", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 5000);
    const s1 = mockWs();
    const s2 = mockWs();

    broadcaster.addClient(s1);
    broadcaster.addClient(s2);

    (s1.send as any).mockClear();
    (s2.send as any).mockClear();

    broadcaster.pushNow();

    expect(s1.send).toHaveBeenCalledOnce();
    expect(s2.send).toHaveBeenCalledOnce();

    broadcaster.shutdown();
  });

  it("removes broken clients on broadcast and continues to others", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 1000);
    const good = mockWs();
    const willBreak = mockWs();

    broadcaster.addClient(good);
    broadcaster.addClient(willBreak);

    expect(broadcaster.clientCount).toBe(2);

    (good.send as any).mockClear();
    (willBreak.send as any).mockImplementation(() => { throw new Error("broken"); });

    vi.advanceTimersByTime(1000);

    expect(broadcaster.clientCount).toBe(1);
    expect(good.send).toHaveBeenCalledOnce();

    broadcaster.shutdown();
  });

  it("removes broken client on addClient immediate send", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 5000);
    const broken = brokenWs();

    broadcaster.addClient(broken);

    expect(broadcaster.clientCount).toBe(0);
    expect(broadcaster.isBroadcasting).toBe(false);
  });

  it("shutdown closes all sockets and clears clients", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 1000);
    const s1 = mockWs();
    const s2 = mockWs();

    broadcaster.addClient(s1);
    broadcaster.addClient(s2);

    broadcaster.shutdown();

    expect(s1.close).toHaveBeenCalledOnce();
    expect(s2.close).toHaveBeenCalledOnce();
    expect(broadcaster.clientCount).toBe(0);
    expect(broadcaster.isBroadcasting).toBe(false);
  });

  it("does not broadcast when no clients are connected", () => {
    const getStatus = vi.fn(() => makeSnapshot());
    const broadcaster = new StatusBroadcaster(getStatus, 1000);

    vi.advanceTimersByTime(5000);

    expect(getStatus).not.toHaveBeenCalled();

    broadcaster.shutdown();
  });

  it("clientCount tracks adds and removes correctly", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 5000);
    const s1 = mockWs();
    const s2 = mockWs();
    const s3 = mockWs();

    expect(broadcaster.clientCount).toBe(0);

    broadcaster.addClient(s1);
    expect(broadcaster.clientCount).toBe(1);

    broadcaster.addClient(s2);
    broadcaster.addClient(s3);
    expect(broadcaster.clientCount).toBe(3);

    broadcaster.removeClient(s2);
    expect(broadcaster.clientCount).toBe(2);

    broadcaster.removeClient(s1);
    broadcaster.removeClient(s3);
    expect(broadcaster.clientCount).toBe(0);

    broadcaster.shutdown();
  });

  it("removing a non-existent client is a no-op", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 5000);
    const s1 = mockWs();
    const unknown = mockWs();

    broadcaster.addClient(s1);
    broadcaster.removeClient(unknown);

    expect(broadcaster.clientCount).toBe(1);
    expect(broadcaster.isBroadcasting).toBe(true);

    broadcaster.shutdown();
  });

  it("stops interval when all clients are broken during broadcast", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 1000);
    const s1 = mockWs();
    const s2 = mockWs();
    broadcaster.addClient(s1);
    broadcaster.addClient(s2);

    (s1.send as any).mockImplementation(() => { throw new Error("broken"); });
    (s2.send as any).mockImplementation(() => { throw new Error("broken"); });

    vi.advanceTimersByTime(1000);

    expect(broadcaster.clientCount).toBe(0);
    expect(broadcaster.isBroadcasting).toBe(false);
  });

  it("skips clients with non-OPEN readyState during broadcast", () => {
    const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 1000);
    const open = mockWs();
    const closing = mockWs();

    broadcaster.addClient(open);
    broadcaster.addClient(closing);

    (open.send as any).mockClear();
    (closing.send as any).mockClear();
    (closing as any).readyState = WebSocket.CLOSING;

    vi.advanceTimersByTime(1000);

    expect(open.send).toHaveBeenCalledOnce();
    expect(closing.send).not.toHaveBeenCalled();

    broadcaster.shutdown();
  });
});

// Feature: kiro-professor-webui, Property 12: WebSocket client list consistency
import fc from "fast-check";

describe("StatusBroadcaster — Property 12: WebSocket client list consistency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("client count equals unique adds minus removes, broadcasting iff count > 0", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            op: fc.constantFrom("add", "remove"),
            clientId: fc.nat({ max: 10 }),
          }),
        ),
        (ops) => {
          const broadcaster = new StatusBroadcaster(() => makeSnapshot(), 5000);

          const sockets = new Map<number, WebSocket>();
          const getWs = (id: number): WebSocket => {
            if (!sockets.has(id)) {
              sockets.set(id, mockWs());
            }
            return sockets.get(id)!;
          };

          const tracked = new Set<number>();

          for (const { op, clientId } of ops) {
            const ws = getWs(clientId);
            if (op === "add") {
              broadcaster.addClient(ws);
              tracked.add(clientId);
            } else {
              broadcaster.removeClient(ws);
              tracked.delete(clientId);
            }
          }

          const expectedCount = tracked.size;

          expect(broadcaster.clientCount).toBe(expectedCount);
          expect(broadcaster.isBroadcasting).toBe(expectedCount > 0);

          broadcaster.shutdown();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// Feature: kiro-professor-webui, Property 4: Status snapshot completeness
import { buildStatusSnapshot } from "./dashboard-config.js";
import type { SubsystemRefs } from "./dashboard-config.js";

describe("buildStatusSnapshot — Property 4: Status snapshot completeness", () => {
  it("snapshot contains all required top-level fields with correct types for any subsystem state", () => {
    fc.assert(
      fc.property(
        fc.record({
          memoryEnabled: fc.boolean(),
          memoryThrows: fc.boolean(),
          heartbeatRunning: fc.boolean(),
          heartbeatConfigured: fc.boolean(),
          transportType: fc.constantFrom("tmux" as const, "acp" as const),
          transportReady: fc.boolean(),
          transportContextPercent: fc.oneof(
            fc.constant(undefined as number | undefined),
            fc.integer({ min: -1, max: 100 }),
          ),
          telegramConfigured: fc.boolean(),
          telegramRunning: fc.boolean(),
          discordConfigured: fc.boolean(),
          discordRunning: fc.boolean(),
          heartbeatIntervalMs: fc.nat({ max: 300_000 }),
          taskCount: fc.nat({ max: 5 }),
        }),
        (state) => {
          const refs: SubsystemRefs = {
            startedAt: Date.now() - 10_000,
            telegramPoller: state.telegramConfigured
              ? { running: state.telegramRunning }
              : null,
            discordPoller: state.discordConfigured
              ? { started: state.discordRunning }
              : null,
            transport: {
              type: state.transportType,
              isReady: state.transportReady,
              contextPercent: state.transportContextPercent,
            },
            memory: state.memoryEnabled
              ? {
                  getStats: state.memoryThrows
                    ? () => { throw new Error("db locked"); }
                    : () => ({
                        totalMessages: 10,
                        extractedMemories: 5,
                        extractedByType: { fact: 3, preference: 2 },
                        preservedKeywords: 1,
                        compactions: { daily: 1, weekly: 0, quarterly: 0 },
                        ingestedDocuments: 0,
                        dbSizeBytes: 4096,
                      }),
                }
              : null,
            heartbeat: state.heartbeatConfigured
              ? {
                  running: state.heartbeatRunning,
                  intervalMs: state.heartbeatIntervalMs,
                  tasks: Array.from({ length: state.taskCount }, (_, i) => ({
                    name: `task-${i}`,
                  })),
                }
              : null,
            chatId: 1,
          };

          const snapshot = buildStatusSnapshot(refs);

          expect(typeof snapshot.timestamp).toBe("string");
          expect(new Date(snapshot.timestamp).toISOString()).toBe(snapshot.timestamp);
          expect(typeof snapshot.uptimeMs).toBe("number");
          expect(snapshot.uptimeMs).toBeGreaterThanOrEqual(0);
          expect(snapshot.platforms).toBeDefined();
          expect(snapshot.transport).toBeDefined();
          expect(snapshot.memory).toBeDefined();
          expect(snapshot.heartbeat).toBeDefined();

          expect(snapshot.platforms.telegram.configured).toBe(state.telegramConfigured);
          expect(snapshot.platforms.discord.configured).toBe(state.discordConfigured);
          if (state.telegramConfigured) {
            expect(snapshot.platforms.telegram.running).toBe(state.telegramRunning);
          } else {
            expect(snapshot.platforms.telegram.running).toBe(false);
          }
          if (state.discordConfigured) {
            expect(snapshot.platforms.discord.running).toBe(state.discordRunning);
          } else {
            expect(snapshot.platforms.discord.running).toBe(false);
          }

          expect(snapshot.transport.type).toBe(state.transportType);
          expect(snapshot.transport.ready).toBe(state.transportReady);
          expect(typeof snapshot.transport.contextPercent).toBe("number");

          if (!state.memoryEnabled) {
            expect(snapshot.memory.enabled).toBe(false);
            expect(snapshot.memory.stats).toBeNull();
            expect(snapshot.memory.error).toBeUndefined();
          } else if (state.memoryThrows) {
            expect(snapshot.memory.enabled).toBe(true);
            expect(snapshot.memory.stats).toBeNull();
            expect(typeof snapshot.memory.error).toBe("string");
            expect(snapshot.memory.error!.length).toBeGreaterThan(0);
          } else {
            expect(snapshot.memory.enabled).toBe(true);
            expect(snapshot.memory.stats).not.toBeNull();
            expect(snapshot.memory.error).toBeUndefined();
          }

          expect(typeof snapshot.heartbeat.running).toBe("boolean");
          expect(typeof snapshot.heartbeat.intervalMs).toBe("number");
          expect(Array.isArray(snapshot.heartbeat.taskNames)).toBe(true);
          if (state.heartbeatConfigured) {
            expect(snapshot.heartbeat.running).toBe(state.heartbeatRunning);
            expect(snapshot.heartbeat.taskNames.length).toBe(state.taskCount);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
