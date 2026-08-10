import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ScheduledTask } from "./task-types.js";

let home: string;
let store: typeof import("./task-state-store.js");
let service: typeof import("./task-service.js");

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "task-service-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  store = await import("./task-state-store.js");
  service = await import("./task-service.js");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ENTRY: ScheduledTask = {
  id: "daily-ai",
  kind: "script",
  command: "report",
  schedule: "0 9 * * *",
  enabled: true,
  priority: "medium",
  delivery: "silent",
};

const COOLDOWN = 12 * 3600_000;

describe("autoResumeIfDue #1609 bounded cooldown recovery", () => {
  it("stays cooling_down before 12 hours and resumes exactly at the boundary", () => {
    const pausedAt = Date.now();
    store.updateState(ENTRY.id, { autoPaused: true, pausedAt, autoResumeCount: 0 });
    expect(service.autoResumeIfDue(ENTRY.id, [ENTRY], pausedAt + COOLDOWN - 1)).toBe("cooling_down");
    expect(service.autoResumeIfDue(ENTRY.id, [ENTRY], pausedAt + COOLDOWN)).toBe("resumed");
    const state = store.readState(ENTRY.id)!;
    expect(state.autoPaused).toBe(false);
    expect(state.pausedAt).toBeUndefined();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.consecutiveDeferrals).toBe(0);
    expect(state.autoResumeCount).toBe(1);
    expect(state.nextRunAt!).toBeGreaterThan(Date.now());
  });

  it("resumes into the next future occurrence without executing anything", () => {
    const pausedAt = Date.now() - COOLDOWN - 1;
    store.updateState(ENTRY.id, { autoPaused: true, pausedAt, autoResumeCount: 0, consecutiveFailures: 5 });
    expect(service.autoResumeIfDue(ENTRY.id, [ENTRY])).toBe("resumed");
    // The scheduler row has no active run — the resume only scheduled.
    expect(store.readState(ENTRY.id)!.activeRun).toBeUndefined();
  });

  it("allows three automatic resumes in one uninterrupted episode, then escalates", () => {
    let pausedAt = Date.now() - COOLDOWN - 1;
    let count = 0;
    for (let cycle = 1; cycle <= 4; cycle++) {
      store.updateState(ENTRY.id, { autoPaused: true, pausedAt, autoResumeCount: count });
      const result = service.autoResumeIfDue(ENTRY.id, [ENTRY], pausedAt + COOLDOWN + 1);
      if (cycle <= 3) {
        expect(result).toBe("resumed");
        count = store.readState(ENTRY.id)!.autoResumeCount;
        expect(count).toBe(cycle);
      } else {
        expect(result).toBe("cap_exhausted");
        expect(store.readState(ENTRY.id)!.autoPaused).toBe(true);
      }
      // A failed run keeps the episode alive; re-pause for the next cycle.
      store.updateState(ENTRY.id, {
        autoPaused: true,
        pausedAt: pausedAt + COOLDOWN + 2,
        autoResumeCount: count,
        consecutiveFailures: 1,
      });
      pausedAt = pausedAt + COOLDOWN + 2;
    }
  });

  it("manual resume is the non-counting escape hatch after cap exhaustion", () => {
    const pausedAt = Date.now() - COOLDOWN - 1;
    store.updateState(ENTRY.id, { autoPaused: true, pausedAt, autoResumeCount: 3 });
    expect(service.autoResumeIfDue(ENTRY.id, [ENTRY])).toBe("cap_exhausted");
    expect(service.resumeAutoPaused(ENTRY.id, [ENTRY])).toBe("resumed");
    const state = store.readState(ENTRY.id)!;
    expect(state.autoPaused).toBe(false);
    expect(state.autoResumeCount).toBe(3);
  });

  it("a manual pause on an already-paused task refreshes the cooldown", () => {
    const oldPausedAt = Date.now() - COOLDOWN - 60_000;
    store.updateState(ENTRY.id, { autoPaused: true, pausedAt: oldPausedAt, autoResumeCount: 0 });
    expect(service.pauseTask(ENTRY.id, [ENTRY])).toBe("paused");
    const state = store.readState(ENTRY.id)!;
    expect(state.pausedAt!).toBeGreaterThan(oldPausedAt);
    // The refreshed timestamp defeats the pending auto-resume.
    expect(service.autoResumeIfDue(ENTRY.id, [ENTRY], state.pausedAt! + COOLDOWN - 1)).toBe("cooling_down");
  });

  it("autoResumeIfDue reports not_paused for a runnable task and already_running with a live reservation", () => {
    store.updateState(ENTRY.id, { autoPaused: false, autoResumeCount: 0 });
    expect(service.autoResumeIfDue(ENTRY.id, [ENTRY])).toBe("not_paused");
    const reserved = store.reserveRun(ENTRY.id, {
      runId: "svc-run", groupId: "g", attempt: 1, trigger: "schedule",
      occurrenceAt: Date.now(), deadlineAt: Date.now() + 60_000,
    });
    expect(reserved.ok).toBe(true);
    store.updateState(ENTRY.id, { autoPaused: true, pausedAt: Date.now() - COOLDOWN - 1 });
    expect(service.autoResumeIfDue(ENTRY.id, [ENTRY])).toBe("already_running");
  });

  it("a successful run resets the episode count for the next failure episode", async () => {
    const pausedAt = Date.now() - COOLDOWN - 1;
    store.updateState(ENTRY.id, { autoPaused: true, pausedAt, autoResumeCount: 3 });
    expect(service.resumeAutoPaused(ENTRY.id, [ENTRY])).toBe("resumed");
    const reserved = store.reserveRun(ENTRY.id, {
      runId: "svc-ok", groupId: "g", attempt: 1, trigger: "schedule",
      occurrenceAt: Date.now(), deadlineAt: Date.now() + 60_000,
    });
    expect(reserved.ok).toBe(true);
    const { settleRunOnce } = await import("./task-run-settler.js");
    settleRunOnce({ entry: ENTRY, run: reserved.run, outcome: "success" });
    expect(store.readState(ENTRY.id)!.autoResumeCount).toBe(0);
  });
});
