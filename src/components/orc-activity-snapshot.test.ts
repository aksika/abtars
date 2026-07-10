import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildOrcActivitySnapshot } from "./orc-activity-snapshot.js";
import * as Kanban from "./tasks/kanban-board.js";
import type { ManagedSession } from "./spin-types.js";

/** Create a minimal ManagedSession fixture */
function orcSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "1749563282_O_01",
    userId: "master",
    platform: "background",
    chatId: 0,
    delivery: "simple",
    active: false,
    status: "ready",
    idleTimeoutMs: Infinity,
    lastActiveAt: Date.now(),
    messageCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    log: [],
    shortIndex: 1,
    busy: false,
    queue: [],
    fullMode: false,
    pendingStart: false,
    seen: false,
    compacting: false,
    ctxWarned: false,
    compactFailures: 0,
    primingTerms: [],
    completions: [],
    instructionQueue: [],
    ...overrides,
  } as ManagedSession;
}

const SESSIONS = new Map<string, ManagedSession>();

describe("buildOrcActivitySnapshot", () => {
  it("returns base snapshot for idle Orc with no root", () => {
    const s = orcSession({ busy: false, activeExecutionId: undefined, activeRootCardId: undefined });
    const snap = buildOrcActivitySnapshot(s, SESSIONS, 5);
    expect(snap.sessionId).toBe(s.id);
    expect(snap.executionId).toBeUndefined();
    expect(snap.busy).toBe(false);
    expect(snap.root).toBeUndefined();
    expect(snap.activeChildren).toEqual([]);
    expect(snap.recentDirectChildren).toEqual([]);
  });

  it("includes root card when present", () => {
    const rootId = Kanban.kanbanEnqueue("test project", "test", undefined, { priority: "HIGH" });
    const s = orcSession({ busy: true, activeExecutionId: "e1", activeRootCardId: rootId });

    const snap = buildOrcActivitySnapshot(s, SESSIONS, 10);
    expect(snap.root).toBeDefined();
    expect(snap.root!.title).toBe("test project");
    expect(snap.root!.status).toBe("queued");
    expect(snap.busy).toBe(true);
    expect(snap.executionId).toBe("e1");
  });

  it("handles missing root card gracefully", () => {
    const s = orcSession({ activeRootCardId: 99999 });
    const snap = buildOrcActivitySnapshot(s, SESSIONS, 1);
    expect(snap.root).toBeDefined();
    expect(snap.root!.title).toBe("(unknown)");
  });

  it("includes active children", () => {
    const rootId = Kanban.kanbanEnqueue("project", "test");
    Kanban.kanbanRunning(rootId);
    Kanban.kanbanEnqueue("child1", "test", undefined, { parent_id: rootId });
    Kanban.kanbanEnqueue("child2", "test", undefined, { parent_id: rootId });

    const s = orcSession({ busy: true, activeExecutionId: "e1", activeRootCardId: rootId });
    const snap = buildOrcActivitySnapshot(s, SESSIONS, 1);
    expect(snap.root).toBeDefined();
    expect(snap.activeChildren.length).toBe(2);
    expect(snap.activeChildren.every(c => c.status === "queued")).toBe(true);
  });

  it("includes recent direct children with terminal states", () => {
    const rootId = Kanban.kanbanEnqueue("project", "test");
    Kanban.kanbanRunning(rootId);
    const childId = Kanban.kanbanEnqueue("done-child", "test", undefined, { parent_id: rootId });
    Kanban.kanbanComplete(childId, null, "all done");

    const s = orcSession({ busy: false, activeRootCardId: rootId });
    const snap = buildOrcActivitySnapshot(s, SESSIONS, 2);
    expect(snap.recentDirectChildren.length).toBeGreaterThanOrEqual(1);
    expect(snap.recentDirectChildren[0].status).toBe("done");
  });

  it("never throws on malformed input", () => {
    const bad = { id: "bad" } as ManagedSession;
    expect(() => buildOrcActivitySnapshot(bad, SESSIONS, 0)).not.toThrow();
  });
});
