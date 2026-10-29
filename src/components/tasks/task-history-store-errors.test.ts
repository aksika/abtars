/**
 * task-history-store-errors.test.ts — #1568: a storage outage must never look
 * like an already-recorded terminal event. The store resolves
 * `requireTaskDatabase()` per call; when the shared database is unavailable,
 * every history operation must propagate the error instead of returning
 * `[]`/`undefined`/`null`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./kanban-board.js", () => ({
  requireTaskDatabase: vi.fn(() => {
    throw new Error("db unavailable");
  }),
}));

describe("task history store database-unavailable semantics", () => {
  it("appendRunOnce propagates the storage error instead of returning null", async () => {
    const store = await import("./task-history-store.js");
    expect(() => store.appendRunOnce({
      runId: "fail-run", taskId: "t", kind: "script", trigger: "schedule",
      startedAt: 1, finishedAt: 2, outcome: "success",
    })).toThrow(/db unavailable/);
  });

  it("appendRun propagates the storage error instead of returning the run ID", async () => {
    const store = await import("./task-history-store.js");
    expect(() => store.appendRun({
      runId: "fail-run", taskId: "t", kind: "script", trigger: "schedule",
      startedAt: 1, finishedAt: 2, outcome: "success",
    })).toThrow(/db unavailable/);
  });

  it("reads propagate the storage error instead of returning empty results", async () => {
    const store = await import("./task-history-store.js");
    expect(() => store.recentRuns("t", 5)).toThrow(/db unavailable/);
    expect(() => store.todaySuccessCount("t")).toThrow(/db unavailable/);
    expect(() => store.hasRun("r")).toThrow(/db unavailable/);
    expect(() => store.getRun("r")).toThrow(/db unavailable/);
    expect(() => store.latestOutcomeByTask()).toThrow(/db unavailable/);
  });
});
