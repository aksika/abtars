/**
 * execution-control.test.ts — #1638/#1648: the Spin-owned legacy drain must
 * skip Pi cards entirely (never dispatch, never fail them); standalone Pi
 * cards are started only by the Reconciler Pi lane.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let kanbanMod: typeof import("./tasks/kanban-board.js");
let createExecutionSupervisor: typeof import("./execution-control.js").createExecutionSupervisor;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `exec-control-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanbanMod = await import("./tasks/kanban-board.js");
  createExecutionSupervisor = (await import("./execution-control.js")).createExecutionSupervisor;
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("createExecutionSupervisor — legacy drain ownership (#1638/#1648)", () => {
  it("skips a queued Pi card without dispatching or failing it", async () => {
    const sup = createExecutionSupervisor({ maxConcurrent: {} });
    const dispatch = vi.fn();
    const cardId = kanbanMod.kanbanEnqueue("pi task", "pi", undefined, { type: "pi", goal: "pi task" });
    expect(cardId).toBeGreaterThan(0);

    sup.drainLegacyQueued(dispatch as never);

    expect(dispatch).not.toHaveBeenCalled();
    const card = kanbanMod.kanbanGetCard(cardId) as { status: string } | undefined;
    expect(card?.status).toBe("queued");
  });

  it("still dispatches a valid unsupervised non-Pi card", async () => {
    const sup = createExecutionSupervisor({ maxConcurrent: { T: 5 } });
    const dispatch = vi.fn();
    const cardId = kanbanMod.kanbanEnqueue("talk", "task", undefined, { type: "T", goal: "talk" });
    expect(cardId).toBeGreaterThan(0);

    sup.drainLegacyQueued(dispatch as never);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ cardId, type: "T" }));
  });

  it("#1750 skips an ownerless O root by identity while still dispatching a W child", async () => {    const sup = createExecutionSupervisor({ maxConcurrent: {} });
    const dispatch = vi.fn();
    // #1750 shape: a bare type=O root with no parent and no project_supervision
    // row (the row is written later when the Reconciler adopts the project).
    const oRoot = kanbanMod.kanbanEnqueue("o root", "agent", undefined, { type: "O", goal: "o root" });
    const wChild = kanbanMod.kanbanEnqueue("w child", "agent", undefined, { type: "W", parent_id: oRoot, goal: "w child" });
    expect(oRoot).toBeGreaterThan(0);
    expect(wChild).toBeGreaterThan(0);

    sup.drainLegacyQueued(dispatch as never);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ cardId: wChild, type: "W" }));
    const oCard = kanbanMod.kanbanGetCard(oRoot) as { status: string } | undefined;
    expect(oCard?.status).toBe("queued");
  });
});

describe("createExecutionSupervisor — owned occupancy (#1778)", () => {
  it("a stale generation's close never frees its successor's slot", () => {
    const sup = createExecutionSupervisor({ maxConcurrent: { W: 5 } });
    const oldCtrl = sup.open({ executionRef: "a_old:1", attemptId: "a_old", generation: 1, cardId: 7001, type: "W" });
    expect(sup.admit("W", 7001, "a_old:1")).toBe(true);
    sup.bindSession("a_old:1", "session-old");

    // The successor admits the same card while the predecessor still holds it.
    const newCtrl = sup.open({ executionRef: "a_new:2", attemptId: "a_new", generation: 2, cardId: 7001, type: "W" });
    expect(sup.admit("W", 7001, "a_new:2")).toBe(true);
    sup.bindSession("a_new:2", "session-new");
    void oldCtrl;
    void newCtrl;

    // The stale predecessor closes late: the successor's slot must survive.
    expect(sup.close("a_old:1", "failed")).toBe(true);
    expect(sup.runningCount("W")).toBe(1);

    // The live successor closes: the slot frees exactly once.
    expect(sup.close("a_new:2", "completed")).toBe(true);
    expect(sup.runningCount("W")).toBe(0);
  });

  it("close releases an already-terminal bound control without touching unowned slots", () => {
    const sup = createExecutionSupervisor({ maxConcurrent: { T: 5 } });
    sup.open({ executionRef: "run_1", cardId: 7002, type: "T" });
    expect(sup.admit("T", 7002, "run_1")).toBe(true);
    sup.bindSession("run_1", "session-t");
    // A deadline won before completion terminalized the control early.
    expect(sup.close("run_1", "timed_out")).toBe(true);
    expect(sup.runningCount("T")).toBe(0);
    // A second close is a terminal no-op that still leaves occupancy empty.
    expect(sup.close("run_1", "timed_out")).toBe(false);
    expect(sup.runningCount("T")).toBe(0);
  });

  it("close after remove is a no-op that releases nothing", () => {
    const sup = createExecutionSupervisor({ maxConcurrent: { W: 5 } });
    sup.open({ executionRef: "a_gone:1", attemptId: "a_gone", generation: 1, cardId: 7003, type: "W" });
    expect(sup.admit("W", 7003, "a_gone:1")).toBe(true);
    sup.bindSession("a_gone:1", "session-gone");
    expect(sup.remove("a_gone:1")).toBe(true);
    expect(sup.close("a_gone:1", "failed")).toBe(false);
    // The slot is still held: only the bound owner may release it, and the
    // binding is gone — occupancy converges through the live driver, never
    // through a removed handle.
    expect(sup.runningCount("W")).toBe(1);
  });
});

describe("createExecutionSupervisor — capacity-release subscription (#1801)", () => {
  it("release notifies once after the mutation with the updated active set", () => {
    const sup = createExecutionSupervisor({ maxConcurrent: { W: 5 } });
    expect(sup.admit("W", 8001, "r1:1")).toBe(true);
    expect(sup.runningCount("W")).toBe(1);
    const seen: Array<{ type: string; countAtNotify: number }> = [];
    const unsub = sup.subscribeCapacityReleased((type) => {
      seen.push({ type, countAtNotify: sup.runningCount("W") });
    });
    sup.release("W", 8001);
    // Notified after deletion: the slot is already free when the listener runs.
    expect(seen).toEqual([{ type: "W", countAtNotify: 0 }]);
    unsub();
    // Unsubscribed: further releases notify nothing.
    expect(sup.admit("W", 8002, "r2:1")).toBe(true);
    sup.release("W", 8002);
    expect(seen).toHaveLength(1);
  });

  it("admit, duplicate release, stale-owner release, and clear notify nothing", () => {
    const sup = createExecutionSupervisor({ maxConcurrent: { W: 5 } });
    const seen: string[] = [];
    sup.subscribeCapacityReleased((type) => seen.push(type));
    // Admit is not a release.
    expect(sup.admit("W", 8101, "o1:1")).toBe(true);
    expect(seen).toHaveLength(0);
    // Duplicate release: second delete is a no-op.
    sup.release("W", 8101);
    expect(seen).toEqual(["W"]);
    sup.release("W", 8101);
    expect(seen).toHaveLength(1);
    // Stale-owner release via close: successor holds the slot.
    expect(sup.admit("W", 8102, "old:1")).toBe(true);
    sup.open({ executionRef: "old:1", cardId: 8102, type: "W" });
    sup.bindSession("old:1", "s-old");
    expect(sup.admit("W", 8102, "new:2")).toBe(true);
    sup.open({ executionRef: "new:2", cardId: 8102, type: "W" });
    sup.bindSession("new:2", "s-new");
    const before = seen.length;
    sup.close("old:1", "failed");
    expect(seen).toHaveLength(before);
    expect(sup.runningCount("W")).toBe(1);
    // Shutdown clear notifies nothing.
    sup.clear();
    expect(seen).toHaveLength(before);
  });

  it("close delegates to the owned release exactly once (no double-notify)", () => {
    const sup = createExecutionSupervisor({ maxConcurrent: { W: 5 } });
    sup.open({ executionRef: "c1:1", attemptId: "c1", generation: 1, cardId: 8201, type: "W" });
    expect(sup.admit("W", 8201, "c1:1")).toBe(true);
    sup.bindSession("c1:1", "s-c1");
    let calls = 0;
    sup.subscribeCapacityReleased(() => calls += 1);
    expect(sup.close("c1:1", "completed")).toBe(true);
    expect(calls).toBe(1);
    // Second close is a terminal no-op with no further notification.
    expect(sup.close("c1:1", "completed")).toBe(false);
    expect(calls).toBe(1);
  });

  it("listener exceptions are contained and cannot interrupt cleanup", () => {
    const sup = createExecutionSupervisor({ maxConcurrent: { W: 5 } });
    expect(sup.admit("W", 8301, "e1:1")).toBe(true);
    sup.subscribeCapacityReleased(() => {
      throw new Error("listener boom");
    });
    const second: string[] = [];
    sup.subscribeCapacityReleased((type) => second.push(type));
    // Must not throw; the slot still frees and the second listener still runs.
    sup.release("W", 8301);
    expect(sup.runningCount("W")).toBe(0);
    expect(second).toEqual(["W"]);
  });
});
