import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * #1601 / #1597 regression proofs: real sqlite, two connections on ONE file.
 * An in-process mock cannot observe a lost update — which is why the
 * unlocked whole-file JSON rewrite survived until now. Each module instance
 * opens its own connection to the same kanban.db through its own
 * kanban-board singleton.
 */

let home: string;
let connA: typeof import("./task-state-store.js");
let connB: typeof import("./task-state-store.js");

async function loadStore(): Promise<typeof import("./task-state-store.js")> {
  vi.resetModules();
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  return import("./task-state-store.js");
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "task-state-cas-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  connA = await loadStore();
  connB = await loadStore();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function candidate(runId: string, deadlineAt = Date.now() + 60_000): Parameters<typeof connA.reserveRun>[1] {
  return {
    runId,
    groupId: `g:${runId}`,
    attempt: 1 as const,
    trigger: "schedule" as const,
    occurrenceAt: Date.now(),
    deadlineAt,
  };
}

describe("task-state CAS across processes #1601/#1597", () => {
  it("exactly one winner when two connections race reserveRun", () => {
    const a = connA.reserveRun("task", candidate("run-a"));
    expect(a.ok).toBe(true);

    // Connection B is a CLI-shaped second process: its insert hits the
    // partial unique index and loses atomically — the database, not an
    // application check, answers "already active".
    const b = connB.reserveRun("task", candidate("run-b"));
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error("unreachable");
    expect(b.active.runId).toBe("run-a");

    // A's reservation is untouched by the losing writer.
    expect(connA.readState("task")!.activeRun!.runId).toBe("run-a");
  });

  it("a CLI-shaped updateState on B does not erase A's live reservation (#1597)", () => {
    const a = connA.reserveRun("task", candidate("run-a"));
    expect(a.ok).toBe(true);

    // `abtars task add` writes { nextRunAt } from a separate process while
    // the bridge holds the reservation.
    connB.updateState("task", { nextRunAt: Date.now() + 3600_000 });

    const state = connA.readState("task")!;
    expect(state.nextRunAt).toBeGreaterThan(Date.now());
    expect(state.activeRun!.runId).toBe("run-a");
    expect(state.activeRun!.phase).toBe("reserved");
  });

  it("advanceRun: the stale writer loses against the live one", () => {
    const a = connA.reserveRun("task", candidate("run-a"));
    if (!a.ok) throw new Error("seed");
    expect(connA.advanceRun("task", "run-a", { phase: "queued" })).toBe("advanced");
    expect(connB.advanceRun("task", "run-a", { phase: "preflight" })).toBe("regression");
    const run = connA.readState("task")!.activeRun!;
    expect(run.phase).toBe("queued");
  });

  it("requestRunTerminal: the first request wins across connections", () => {
    const a = connA.reserveRun("task", candidate("run-a"));
    if (!a.ok) throw new Error("seed");
    const req = { kind: "cancelled" as const, requestedAt: Date.now(), reason: "operator" };
    expect(connA.requestRunTerminal("task", "run-a", req)).toBe("requested");
    // A deadline cannot replace the cancellation recorded by A.
    expect(connB.requestRunTerminal("task", "run-a", { kind: "deadline_exceeded", requestedAt: Date.now() + 1000, reason: "deadline" })).toBe("already_requested");
    expect(connA.readState("task")!.activeRun!.terminalRequest!.kind).toBe("cancelled");
  });

  it("settleActiveRun: exactly one winner, second settlement rejected", () => {
    const a = connA.reserveRun("task", candidate("run-a"));
    if (!a.ok) throw new Error("seed");

    expect(connA.settleActiveRun("task", "run-a", { lastFinishedAt: Date.now(), consecutiveFailures: 1 })).toBe(true);
    // Connection B settles the same run: CAS fails, its patch is NOT applied.
    expect(connB.settleActiveRun("task", "run-a", { lastFinishedAt: Date.now(), consecutiveFailures: 99 })).toBe(false);

    const state = connA.readState("task")!;
    expect(state.activeRun).toBeUndefined();
    expect(state.consecutiveFailures).toBe(1);
  });

  it("a settled run frees the task for a new reservation", () => {
    const a = connA.reserveRun("task", candidate("run-a"));
    if (!a.ok) throw new Error("seed");
    expect(connA.settleActiveRun("task", "run-a", {})).toBe(true);
    const b = connB.reserveRun("task", candidate("run-b"));
    expect(b.ok).toBe(true);
  });
});
