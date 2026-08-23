/**
 * orc-containment-smoke.test.ts — #1707 Task 7: end-to-end containment
 * journey through the REAL reconciler driver with a MOCKED provider start
 * port. Basic checks only (per spec): gates activate in order, one broken
 * card cannot create unbounded rows or starts, restarts cannot resurrect
 * state, and operator reset re-admits exactly one new attempt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectAcceptanceContractV1 } from "../components/project-acceptance/project-contract.js";

let TEST_HOME: string;
let kanban: typeof import("../components/tasks/kanban-board.js");
let reviewStoreMod: typeof import("../components/project-acceptance/project-review-store.js");
let reconciler: typeof import("../components/reconciler.js");
let stateStore: typeof import("../components/tasks/task-state-store.js");
let taskStore: typeof import("../components/tasks/task-store.js");
let runStoreMod: typeof import("../components/orc-project/orc-project-run-store.js");
let coordinatorMod: typeof import("../components/orc-project/orc-project-coordinator.js");

const ENTRY = {
  id: "smoke-task",
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

let activeHandle: import("../components/reconciler.js").ReconcilerHandle | null = null;
let wakeScheduler: import("../components/lifecycle-wake-scheduler.js").LifecycleWakeScheduler | null = null;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-containment-smoke-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("../components/tasks/kanban-board.js");
  reviewStoreMod = await import("../components/project-acceptance/project-review-store.js");
  reconciler = await import("../components/reconciler.js");
  stateStore = await import("../components/tasks/task-state-store.js");
  taskStore = await import("../components/tasks/task-store.js");
  runStoreMod = await import("../components/orc-project/orc-project-run-store.js");
  coordinatorMod = await import("../components/orc-project/orc-project-coordinator.js");
});

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  wakeScheduler?.stop();
  wakeScheduler = null;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 20));
}

function makeContract(projectCardId: number): ProjectAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: `ct_${projectCardId}`,
    digest: `dg_${projectCardId}`,
    project_card_id: projectCardId,
    goal: "work",
    criteria: [{ id: "c1", description: "done", required: true, evidence_expectation: "synthesis" }],
    required_outputs: [],
    constraints: [],
    limits: {},
    provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
  };
}

function seedLiveScheduledProject(): { rootId: number; runId: string } {
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
  const rootId = kanban.kanbanEnqueue("Smoke Project", "task", run.runId, { type: "O", goal: "work" });
  stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId: rootId });
  const rs = new reviewStoreMod.ProjectReviewStore();
  rs.insertContract(makeContract(rootId));
  rs.initializeSupervision(rootId, `ct_${rootId}`, "executing");
  kanban.kanbanRunning(rootId);
  return { rootId, runId: run.runId };
}

async function startGeneration(startPort: (spec: unknown) => Promise<void>): Promise<void> {
  const { LifecycleWakeScheduler } = await import("../components/lifecycle-wake-scheduler.js");
  const { SpinWorkerAdapter } = await import("../components/spin-worker-adapter.js");
  const { ReconcileQuarantineStore } = await import("../components/reconcile-quarantine-store.js");
  await activeHandle?.stop();
  activeHandle = null;
  wakeScheduler?.stop();
  wakeScheduler = new LifecycleWakeScheduler();
  activeHandle = await reconciler.startReconciler({
    generationId: `smoke-${Date.now()}`,
    coordinator: new coordinatorMod.OrcProjectCoordinator({ ownerPeer: "test-peer", startPort }),
    wakeScheduler,
    workerAdapter: new SpinWorkerAdapter(),
    piService: null,
    createPiAdapter: (() => ({})) as never,
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: () => {},
  } as never);
  await wakeScheduler.start();
}

describe("#1707 containment smoke (real driver, mocked provider)", () => {
  it("a failing provider cannot spin one card — gate order holds and reset admits exactly one new attempt", async () => {
    const { rootId, runId } = seedLiveScheduledProject();

    // Provider start port ALWAYS fails — the incident's provider-failure face.
    let providerStarts = 0;
    await startGeneration(async () => {
      providerStarts++;
      throw new Error("provider down");
    });

    // Hammer the reconciler: every wake goes through the durable gates.
    for (let i = 0; i < 25; i++) {
      reconciler.requestReconcile(rootId);
      await flush();
    }

    const store = new runStoreMod.OrcProjectRunStore();
    // Bounded outcome: exactly ONE automatic start ever reached the provider;
    // the terminal-execution-attempt fuse refuses everything after.
    expect(providerStarts).toBe(1);
    expect(store.getRunsForProject(rootId)).toHaveLength(1);

    // Fuse is open and visible to the operator surface.
    const trip = store.getFuseSnapshot().find(f => f.scope === `card:${rootId}`);
    expect(trip?.openedAt).toBeTruthy();
    expect(trip?.tripReason).toBe("terminal_execution_attempt");

    // Ordinary restart (fresh generation over same stores) does NOT clear it:
    await startGeneration(async () => { providerStarts++; });
    reconciler.requestReconcile(rootId);
    await flush();
    expect(providerStarts).toBe(1); // still one — restart resurrects nothing

    // Operator reset admits exactly ONE new attempt identity:
    store.resetProjectFuse(rootId);
    reconciler.requestReconcile(rootId);
    await flush();
    await flush();
    expect(providerStarts).toBe(2);
    const rows = store.getRunsForProject(rootId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it("a dead occurrence settles terminally through real wakes — zero rows, zero starts", async () => {
    const { rootId, runId } = seedLiveScheduledProject();
    kanban._kanbanExecForTest(`UPDATE task_runs SET finished_at = ?, outcome = 'failed' WHERE run_id = ?`, [Date.now(), runId]);

    let providerStarts = 0;
    await startGeneration(async () => { providerStarts++; });

    for (let i = 0; i < 10; i++) {
      reconciler.requestReconcile(rootId);
      await flush();
    }

    const store = new runStoreMod.OrcProjectRunStore();
    expect(providerStarts).toBe(0);
    expect(store.getRunsForProject(rootId)).toHaveLength(0);
    // Terminal evidence everywhere:
    expect(kanban.kanbanGetCard(rootId)!.status).toBe("failed");
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(rootId)!.state).toBe("blocked");

    // Post-settlement wakes stay quiet (idempotent):
    reconciler.requestReconcile(rootId);
    await flush();
    expect(providerStarts).toBe(0);
  });
});
