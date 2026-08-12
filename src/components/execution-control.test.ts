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
});
