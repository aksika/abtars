import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ScheduledTask } from "./task-types.js";
import type { KanbanCard } from "./kanban-board.js";

let home: string;
let gate: typeof import("./scheduled-occurrence-gate.js");
let stateStore: typeof import("./task-state-store.js");
let taskStore: typeof import("./task-store.js");
let board: typeof import("./kanban-board.js");

const ENTRY: ScheduledTask = {
  id: "gate-task",
  kind: "agent",
  prompt: "work",
  agent: "task",
  interaction: { mode: "oneshot" },
  orchestration: { maxAgents: 1 },
  schedule: "* * * * *",
  enabled: true,
  priority: "medium",
  delivery: "silent",
};

function cardFor(runId: string, cardId: number): KanbanCard {
  return {
    id: cardId,
    title: "Scheduled Project",
    source: "task",
    source_id: runId,
    assignee: "local",
    priority: "MEDIUM",
    status: "running",
    type: "O",
    goal: "work",
    notes: null,
    result_summary: null,
    result_path: null,
    error: null,
    delivery_attempts: 0,
    approval: null,
    due_at: null,
    labels: null,
    parent_id: null,
    blocked_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    delivered_at: null,
    max_tokens: null,
    max_cost: null,
    tokens_used: null,
    delivery_mode: "deliver",
    chat_id: null,
    source_peer: null,
    delivery_claimed_at: null,
    delivery_result: null,
    delivery_receipt: null,
    delivery_ready: 1,
    max_agents: null,
    retry_count: 0,
    next_retry_at: null,
    progress: null,
  };
}

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "gate-test-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  gate = await import("./scheduled-occurrence-gate.js");
  stateStore = await import("./task-state-store.js");
  taskStore = await import("./task-store.js");
  board = await import("./kanban-board.js");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("scheduled-occurrence-gate four-state", () => {
  it("live matching run with valid definition is active", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const now = Date.now();
    stateStore.reserveRun(ENTRY.id, { runId: "run-active", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const cardId = board.kanbanEnqueue("P", "task", run.runId, { type: "O" });
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId });
    const card = board.kanbanGetCard(cardId)!;
    const inspection = gate.inspectScheduledOccurrence(card);
    expect(inspection.state).toBe("active");
    if (inspection.state === "active") {
      expect(inspection.occurrence.entry.id).toBe(ENTRY.id);
      expect(inspection.occurrence.run.runId).toBe(run.runId);
    }
    expect(gate.scheduledOccurrenceState(card)).toBe("active");
    expect(gate.findActiveScheduledOccurrence(card)?.run.runId).toBe(run.runId);
  });

  it("missing run is terminal", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const card = cardFor("missing-run", 999);
    // ensure no run with that id exists
    expect(gate.inspectScheduledOccurrence(card).state).toBe("terminal");
  });

  it("finished run is terminal", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const now = Date.now();
    stateStore.reserveRun(ENTRY.id, { runId: "run-fin", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const cardId = board.kanbanEnqueue("P", "task", run.runId, { type: "O" });
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId });
    stateStore.settleActiveRun(ENTRY.id, run.runId, {});
    const card = board.kanbanGetCard(cardId)!;
    expect(gate.inspectScheduledOccurrence(card).state).toBe("terminal");
  });

  it("mismatched cardId is terminal", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const now = Date.now();
    stateStore.reserveRun(ENTRY.id, { runId: "run-mismatch", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const cardId = board.kanbanEnqueue("P", "task", run.runId, { type: "O" });
    // bind run to different cardId
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId: cardId + 100 });
    const card = board.kanbanGetCard(cardId)!;
    expect(gate.inspectScheduledOccurrence(card).state).toBe("terminal");
  });

  it("terminal-requested run is terminal", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const now = Date.now();
    stateStore.reserveRun(ENTRY.id, { runId: "run-cancel", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const cardId = board.kanbanEnqueue("P", "task", run.runId, { type: "O" });
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId });
    stateStore.requestRunTerminal(ENTRY.id, run.runId, { kind: "cancelled", requestedAt: Date.now(), reason: "test" });
    const card = board.kanbanGetCard(cardId)!;
    expect(gate.inspectScheduledOccurrence(card).state).toBe("terminal");
  });

  it("live run with absent definition is unavailable definition_missing", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const now = Date.now();
    stateStore.reserveRun(ENTRY.id, { runId: "run-missing-def", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const cardId = board.kanbanEnqueue("P", "task", run.runId, { type: "O" });
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId });
    // overwrite catalog with different entry, so live run's taskId missing
    const other: ScheduledTask = { ...ENTRY, id: "other-task" };
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([other], null, 2));
    const card = board.kanbanGetCard(cardId)!;
    const inspection = gate.inspectScheduledOccurrence(card);
    expect(inspection.state).toBe("unavailable");
    if (inspection.state === "unavailable") expect(inspection.reason).toBe("definition_missing");
  });

  it("live run with partial catalog where definition is quarantined is unavailable definition_missing", () => {
    const invalid = { ...ENTRY, schedule: "BAD CRON" };
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const now = Date.now();
    stateStore.reserveRun(ENTRY.id, { runId: "run-partial", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const cardId = board.kanbanEnqueue("P", "task", run.runId, { type: "O" });
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId });
    // quarantined: same id but invalid
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([invalid], null, 2));
    const card = board.kanbanGetCard(cardId)!;
    const inspection = gate.inspectScheduledOccurrence(card);
    expect(inspection.state).toBe("unavailable");
  });

  it("live run with unavailable catalog is unavailable definition_unavailable", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const now = Date.now();
    stateStore.reserveRun(ENTRY.id, { runId: "run-unavail", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const cardId = board.kanbanEnqueue("P", "task", run.runId, { type: "O" });
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId });
    writeFileSync(join(home, "tasks", "tasks.json"), "INVALID JSON");
    const card = board.kanbanGetCard(cardId)!;
    const inspection = gate.inspectScheduledOccurrence(card);
    expect(inspection.state).toBe("unavailable");
    if (inspection.state === "unavailable") expect(inspection.reason).toBe("definition_unavailable");
  });

  it("non-scheduled card is not_scheduled", () => {
    const card: KanbanCard = {
      id: 1,
      title: "peer",
      source: "peer",
      source_id: "some-id",
      assignee: "local",
      priority: "MEDIUM",
      status: "running",
      type: "O",
      goal: null,
      notes: null,
      result_summary: null,
      result_path: null,
      error: null,
      delivery_attempts: 0,
      approval: null,
      due_at: null,
      labels: null,
      parent_id: null,
      blocked_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
      delivered_at: null,
      max_tokens: null,
      max_cost: null,
      tokens_used: null,
      delivery_mode: "deliver",
      chat_id: null,
      source_peer: "other",
      delivery_claimed_at: null,
      delivery_result: null,
      delivery_receipt: null,
      delivery_ready: 1,
      max_agents: null,
      retry_count: 0,
      next_retry_at: null,
      progress: null,
    };
    expect(gate.inspectScheduledOccurrence(card).state).toBe("not_scheduled");
    expect(gate.scheduledOccurrenceState(card)).toBe("not_scheduled");
  });

  it("findActiveScheduledOccurrence delegates to inspect and only returns for active", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    taskStore.readEntries();
    const now = Date.now();
    stateStore.reserveRun(ENTRY.id, { runId: "run-find", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const cardId = board.kanbanEnqueue("P", "task", run.runId, { type: "O" });
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId });
    const card = board.kanbanGetCard(cardId)!;
    expect(gate.findActiveScheduledOccurrence(card)?.run.runId).toBe(run.runId);
    // make unavailable
    writeFileSync(join(home, "tasks", "tasks.json"), "BAD");
    const card2 = board.kanbanGetCard(cardId)!;
    expect(gate.findActiveScheduledOccurrence(card2)).toBeUndefined();
  });
});
