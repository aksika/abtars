/**
 * due-sources.test.ts — #1539: lifecycle wake scheduler due sources for
 * scheduled runs. The retry-wake case is the red-first evidence from the
 * spec: a supervised worker card in retry backoff must dispatch when its
 * `next_retry_at` becomes due with NO unrelated nerve/card event, and with
 * the tier-3 heartbeat safety scan not running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { LifecycleWakeScheduler } from "../lifecycle-wake-scheduler.js";

let TEST_HOME: string;
let kanban: typeof import("./kanban-board.js");
let stateStore: typeof import("./task-state-store.js");
let taskStore: typeof import("./task-store.js");
let dueSources: typeof import("./due-sources.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "due-sources-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  mkdirSync(join(TEST_HOME, "workspace"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("./kanban-board.js");
  stateStore = await import("./task-state-store.js");
  taskStore = await import("./task-store.js");
  dueSources = await import("./due-sources.js");
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("kanban-retry due source #1539", () => {
  it("dispatches a retrying card when next_retry_at becomes due — no nerve event, no heartbeat safety scan", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new LifecycleWakeScheduler();
      const dispatchRequests: number[] = [];
      scheduler.register(dueSources.createKanbanRetrySource((cardId) => { dispatchRequests.push(cardId); }));

      const parent = kanban.kanbanEnqueue("Parent", "task", "p-run");
      const cardId = kanban.kanbanEnqueue("Retry Me", "task", "run-1", { type: "W", parent_id: parent });
      expect(kanban.kanbanRetryOrFail(cardId, "transient failure")).toBe("retrying");
      const card = kanban.kanbanGetCard(cardId)!;
      expect(card.status).toBe("queued");
      const retryAt = new Date(card.next_retry_at!).getTime();
      expect(retryAt).toBeGreaterThan(Date.now());

      // Boot: scan + arm the earliest future retry date.
      await scheduler.start();
      expect(dispatchRequests).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);

      // No unrelated event fires the card: only the due time can.
      await vi.advanceTimersByTimeAsync(Math.max(1, retryAt - Date.now() - 1));
      expect(dispatchRequests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(dispatchRequests).toEqual([cardId]);
      expect(vi.getTimerCount()).toBe(0);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists only queued cards with a future retry date for arming", async () => {
    const c1 = kanban.kanbanEnqueue("A", "task", "r1");
    const c2 = kanban.kanbanEnqueue("B", "task", "r2");
    kanban.kanbanRetryOrFail(c1, "x");
    kanban.kanbanRunning(c2);
    const items = dueSources.createKanbanRetrySource(() => {}).listDueItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.key).toBe(`kanban:${c1}`);
  });

  it("drains unsupervised due retry cards through the dispatch path", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new LifecycleWakeScheduler();
      const supervisedWakes: number[] = [];
      const drains: number[] = [];
      scheduler.register(dueSources.createKanbanRetrySource((cardId) => { supervisedWakes.push(cardId); }, () => { drains.push(1); }));

      const parent = kanban.kanbanEnqueue("Parent", "task", "p-run");
      const supervised = kanban.kanbanEnqueue("S", "task", "r-s", { type: "W", parent_id: parent });
      const unsupervised = kanban.kanbanEnqueue("U", "task", "r-u", { type: "W" });
      kanban.kanbanRetryOrFail(supervised, "x");
      kanban.kanbanRetryOrFail(unsupervised, "y");
      const retryAt = new Date(kanban.kanbanGetCard(supervised)!.next_retry_at!).getTime();
      await scheduler.start();
      expect(supervisedWakes).toHaveLength(0);
      expect(drains).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(Math.max(1, retryAt - Date.now() - 1));
      expect(supervisedWakes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(supervisedWakes).toEqual([supervised]);
      expect(drains).toEqual([1]);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("task-admission due source #1539", () => {
  it("wakes a future retry exactly at its durable retryAt without any unrelated event", async () => {
    vi.useFakeTimers();
    try {
      const entry = {
        id: "admit-task",
        kind: "agent",
        prompt: "p",
        agent: "task",
        interaction: { mode: "oneshot" },
        orchestration: { maxAgents: 1 },
        schedule: "* * * * *",
        enabled: true,
        priority: "medium",
        delivery: "announce",
        chatId: "1",
      };
      writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify([entry], null, 2));
      const entries = taskStore.readEntries();
      stateStore.initializeState(entries);
      // A one-shot retry in the future — the only due item.
      const retryAt = Date.now() + 20_000;
      stateStore.updateState(entry.id, { nextRunAt: retryAt, retrying: true, retryGroupId: "g", retryAttempt: 1 });

      const scheduler = new LifecycleWakeScheduler();
      const ticks: number[] = [];
      scheduler.register(dueSources.createTaskAdmissionSource((now) => { ticks.push(now); }));
      await scheduler.start();
      expect(ticks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(ticks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(ticks).toHaveLength(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips disabled and already-running tasks in its due items", async () => {
    const disabled = { id: "off", kind: "agent", prompt: "p", agent: "task", interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 }, schedule: "* * * * *", enabled: false, priority: "medium", delivery: "announce", chatId: "1" };
    const running = { id: "busy", kind: "agent", prompt: "p", agent: "task", interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 }, schedule: "* * * * *", enabled: true, priority: "medium", delivery: "announce", chatId: "1" };
    writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify([disabled, running], null, 2));
    stateStore.initializeState(taskStore.readEntries());
    const now = Date.now();
    stateStore.updateState("off", { nextRunAt: now + 1000 });
    stateStore.reserveRun("busy", { runId: "b-1", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 60_000 });
    const items = dueSources.createTaskAdmissionSource(() => {}).listDueItems();
    expect(items).toHaveLength(0);
  });
});
