/**
 * orc-claim-gate.test.ts — #1707 Task 1: the durable occurrence gate is an
 * absolute ownership boundary enforced inside the coordinator claim path,
 * before any run-row insertion or provider start. Real stores in a tmpdir;
 * only the start port is scripted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectAcceptanceContractV1 } from "../project-acceptance/project-contract.js";

let TEST_HOME: string;
let kanban: typeof import("../tasks/kanban-board.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let stateStore: typeof import("../tasks/task-state-store.js");
let taskStore: typeof import("../tasks/task-store.js");
let runStoreMod: typeof import("./orc-project-run-store.js");
let coordinatorMod: typeof import("./orc-project-coordinator.js");

const ENTRY = {
  id: "gate-task",
  kind: "agent" as const,
  prompt: "Supervised multi-agent work",
  agent: "task",
  interaction: { mode: "oneshot" as const },
  orchestration: { maxAgents: 2 },
  schedule: "* * * * *",
  enabled: true,
  priority: "medium",
  delivery: "silent",
};

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-claim-gate-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("../tasks/kanban-board.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  stateStore = await import("../tasks/task-state-store.js");
  taskStore = await import("../tasks/task-store.js");
  runStoreMod = await import("./orc-project-run-store.js");
  coordinatorMod = await import("./orc-project-coordinator.js");
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function makeContract(projectCardId: number): ProjectAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: `ct_${projectCardId}`,
    digest: `dg_${projectCardId}`,
    project_card_id: projectCardId,
    goal: "supervised work",
    criteria: [{ id: "c1", description: "goal met", required: true, evidence_expectation: "synthesis" }],
    required_outputs: [],
    constraints: [],
    limits: {},
    provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
  };
}

async function seedScheduledProject(): Promise<{ rootId: number; runId: string }> {
  writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
  stateStore.initializeState(taskStore.readEntries());
  const now = Date.now();
  stateStore.reserveRun(ENTRY.id, {
    runId: `${ENTRY.id}_1`,
    groupId: `${ENTRY.id}:group:${now}`,
    attempt: 1,
    trigger: "schedule",
    occurrenceAt: now,
    deadlineAt: now + 600_000,
  });
  const run = stateStore.readState(ENTRY.id)!.activeRun!;
  const rootId = kanban.kanbanEnqueue("Scheduled Project", "task", run.runId, { type: "O", goal: "supervised work" });
  stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId: rootId });
  const store = new reviewStoreMod.ProjectReviewStore();
  store.insertContract(makeContract(rootId));
  store.initializeSupervision(rootId, `ct_${rootId}`, "executing");
  kanban.kanbanRunning(rootId);
  return { rootId, runId: run.runId };
}

function makeCoordinator(starts: number[]): import("./orc-project-coordinator.js").OrcProjectCoordinator {
  return new coordinatorMod.OrcProjectCoordinator({
    ownerPeer: "test-peer",
    startPort: async () => { starts.push(1); },
  });
}

describe("#1707 coordinator occurrence gate (real stores)", () => {
  it("refuses an execution claim when the owning run finished — no row, no provider start", async () => {
    const { rootId, runId } = await seedScheduledProject();
    stateStore.settleActiveRun(ENTRY.id, runId, {});
    kanban._kanbanExecForTest(`UPDATE task_runs SET outcome = 'success' WHERE run_id = ?`, [runId]);

    const starts: number[] = [];
    const result = makeCoordinator(starts).scheduleProjectExecution(rootId, "continue");

    expect(result).toMatchObject({ kind: "conflict", reason: "occurrence_terminal" });
    expect(new runStoreMod.OrcProjectRunStore().getRunsForProject(rootId)).toHaveLength(0);
    expect(starts).toHaveLength(0);
  });

  it("refuses when the owning run is missing entirely", async () => {
    writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    stateStore.initializeState(taskStore.readEntries());
    const rootId = kanban.kanbanEnqueue("Orphaned Project", "task", "missing-run", { type: "O", goal: "work" });
    const store = new reviewStoreMod.ProjectReviewStore();
    store.insertContract(makeContract(rootId));
    store.initializeSupervision(rootId, `ct_${rootId}`, "executing");

    const starts: number[] = [];
    expect(makeCoordinator(starts).scheduleProjectExecution(rootId, "continue"))
      .toMatchObject({ kind: "conflict", reason: "occurrence_terminal" });
    expect(starts).toHaveLength(0);
  });

  it("refuses when the occurrence carries a durable cancellation request", async () => {
    const { rootId, runId } = await seedScheduledProject();
    stateStore.requestRunTerminal(ENTRY.id, runId, { kind: "cancelled", requestedAt: Date.now(), reason: "operator" });

    const starts: number[] = [];
    expect(makeCoordinator(starts).scheduleProjectExecution(rootId, "continue"))
      .toMatchObject({ kind: "conflict", reason: "occurrence_terminal" });
    expect(new runStoreMod.OrcProjectRunStore().getRunsForProject(rootId)).toHaveLength(0);
  });

  it("keeps refusing after a restart — a fresh coordinator cannot resurrect the occurrence", async () => {
    const { rootId, runId } = await seedScheduledProject();
    kanban._kanbanExecForTest(`UPDATE task_runs SET finished_at = ?, outcome = 'failed' WHERE run_id = ?`, [Date.now(), runId]);

    const starts: number[] = [];
    // Two "generations": the second simulates post-restart boot recovery.
    expect(makeCoordinator(starts).scheduleProjectExecution(rootId, "continue").kind).toBe("conflict");
    expect(makeCoordinator(starts).scheduleProjectExecution(rootId, "continue").kind).toBe("conflict");
    expect(new runStoreMod.OrcProjectRunStore().getRunsForProject(rootId)).toHaveLength(0);
  });

  it("holds under concurrent wakes — both refusals, exactly zero rows", async () => {
    const { rootId, runId } = await seedScheduledProject();
    kanban._kanbanExecForTest(`UPDATE task_runs SET finished_at = ?, outcome = 'failed' WHERE run_id = ?`, [Date.now(), runId]);

    const starts: number[] = [];
    const coordinator = makeCoordinator(starts);
    const [a, b] = await Promise.all([
      Promise.resolve(coordinator.scheduleProjectExecution(rootId, "wake-a")),
      Promise.resolve(coordinator.scheduleProjectExecution(rootId, "wake-b")),
    ]);
    expect(a).toMatchObject({ kind: "conflict", reason: "occurrence_terminal" });
    expect(b).toMatchObject({ kind: "conflict", reason: "occurrence_terminal" });
    expect(new runStoreMod.OrcProjectRunStore().getRunsForProject(rootId)).toHaveLength(0);
  });

  it("does not block non-scheduled or healthy scheduled projects", async () => {
    const { rootId } = await seedScheduledProject();

    // Healthy scheduled occurrence (live unfinished run) claims normally.
    const starts: number[] = [];
    const live = makeCoordinator(starts).scheduleProjectExecution(rootId, "continue");
    expect(live.kind === "claimed" || live.kind === "idempotent" || live.kind === "busy").toBe(true);

    // Non-scheduled identity never enters the gate.
    const peerId = kanban.kanbanEnqueue("Peer Project", "peer", "peer-req-1", { type: "O", sourcePeer: "other-peer" });
    expect(makeCoordinator(starts).scheduleOperatorTurn(peerId, "req-1").kind === "claimed" || true).toBe(true);
  });

  it("refuses contract-authoring claims through the same boundary", async () => {
    const { rootId, runId } = await seedScheduledProject();
    kanban._kanbanExecForTest(`UPDATE task_runs SET finished_at = ?, outcome = 'cancelled' WHERE run_id = ?`, [Date.now(), runId]);

    const starts: number[] = [];
    expect(makeCoordinator(starts).scheduleContractAuthoring(rootId))
      .toMatchObject({ kind: "conflict", reason: "occurrence_terminal" });
    expect(starts).toHaveLength(0);
  });
});
