/**
 * reconciler-last-resort.test.ts — #1546 Task 4 focused real-store coverage:
 * the claim-before-promotion crash window, busy/foreign-claim non-settlement,
 * and exactly-once last-resort settlement when a reattached waiter also
 * settles. Uses the real kanban/project/supervision/task stores in a tmpdir;
 * only the Orc coordinator boundary is scripted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectAcceptanceContractV1 } from "../project-acceptance/project-contract.js";

let TEST_HOME: string;
let kanban: typeof import("./kanban-board.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let reconciler: typeof import("../reconciler.js");
let stateStore: typeof import("./task-state-store.js");
let taskStore: typeof import("./task-store.js");
let historyStore: typeof import("./task-history-store.js");
let settler: typeof import("./task-run-settler.js");
let runStoreMod: typeof import("../orc-project/orc-project-run-store.js");
let coordinatorMod: typeof import("../orc-project/orc-project-coordinator.js");
let failureMod: typeof import("./task-failure.js");


let activeHandle: import("../reconciler.js").ReconcilerHandle | null = null;
let wakeScheduler: import("../lifecycle-wake-scheduler.js").LifecycleWakeScheduler | null = null;

/** #1554: start a real generation over the tmpdir stores with a scripted coordinator. */
async function startGeneration(coordinator: unknown, piService: unknown = null): Promise<void> {
  const { LifecycleWakeScheduler } = await import("../lifecycle-wake-scheduler.js");
  const { SpinWorkerAdapter } = await import("../spin-worker-adapter.js");
  const { ReconcileQuarantineStore } = await import("../reconcile-quarantine-store.js");
  await activeHandle?.stop();
  activeHandle = null;
  wakeScheduler?.stop();
  wakeScheduler = new LifecycleWakeScheduler();
  activeHandle = await reconciler.startReconciler({
    generationId: `last-resort-${Date.now()}`,
    coordinator: coordinator as never,
    wakeScheduler,
    workerAdapter: new SpinWorkerAdapter(),
    piService: piService as never,
    createPiAdapter: (() => ({ kind: "pi", capacity: async () => ({ available: 0, max: 0 }), start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }), cancel: async () => ({ kind: "cancelled", attemptId: "" }), inspect: async () => ({ kind: "running", lifecycle: "running" }) })) as never,
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: () => {},
  } as never);
  await wakeScheduler.start();
}

const ENTRY = {
  id: "project-task",
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
  TEST_HOME = mkdtempSync(join(tmpdir(), "reconciler-last-resort-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  mkdirSync(join(TEST_HOME, "workspace"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("./kanban-board.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  reconciler = await import("../reconciler.js");
  stateStore = await import("./task-state-store.js");
  taskStore = await import("./task-store.js");
  historyStore = await import("./task-history-store.js");
  settler = await import("./task-run-settler.js");
  runStoreMod = await import("../orc-project/orc-project-run-store.js");
  coordinatorMod = await import("../orc-project/orc-project-coordinator.js");
  failureMod = await import("./task-failure.js");
});

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  wakeScheduler?.stop();
  wakeScheduler = null;
});

afterEach(() => {
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
    goal: "supervised work",
    criteria: [{ id: "c1", description: "goal met", required: true, evidence_expectation: "synthesis" }],
    required_outputs: [],
    constraints: [],
    limits: {},
    provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
  };
}

async function seedScheduledProject(opts: { cardStatus?: "running" | "queued"; retryMarker?: string | null; state?: string } = {}): Promise<{ rootId: number; run: import("./task-state-store.js").ActiveTaskRun }> {
  writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
  const entries = taskStore.readEntries();
  stateStore.initializeState(entries);
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
  const rootId = kanban.kanbanEnqueue("Scheduled Project", "task", run.runId, { type: "O", goal: "supervised work", maxAgents: 2 });
  stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId: rootId });
  const store = new reviewStoreMod.ProjectReviewStore();
  store.insertContract(makeContract(rootId));
  store.initializeSupervision(rootId, `ct_${rootId}`, (opts.state as never) ?? "executing");
  if (opts.cardStatus === "queued") {
    const marker = opts.retryMarker ?? new Date(Date.now() - 1000).toISOString();
    kanban._kanbanExecForTest(
      `UPDATE kanban_board SET status = 'queued', next_retry_at = ? WHERE id = ?`,
      [marker, rootId],
    );
  } else {
    kanban.kanbanRunning(rootId);
  }
  return { rootId, run };
}

describe("reconciler #1546 last-resort and claim ordering (real stores)", () => {
  it("settles exactly once when the driver freezes and a live waiter also settles — one history row, one state patch, one card event", async () => {
    const { rootId, run } = await seedScheduledProject();
    const entry = taskStore.readEntries()[0]!;

    // #1554: a running generation is required for the request façade.
    await startGeneration(new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "test-peer",
      startPort: async () => { /* working Orc */ },
    }));

    // the driver freezes the project and settles through the settler
    reconciler.settleProjectLastResort(rootId);
    await flush();
    // the reattached waiter observes the frozen terminal evidence and settles too
    const waiterResult = settler.settleRunOnce({
      entry,
      run,
      outcome: "failed",
      diagnostic: failureMod.makeTaskFailure("interruption", "restart_interrupted", "executing", "waiter observed terminal project", "none"),
      cardId: rootId,
    });

    expect(waiterResult).toBe("duplicate"); // append-once dedupes the second caller
    expect(historyStore.recentRuns(ENTRY.id, 10)).toHaveLength(1);
    expect(historyStore.recentRuns(ENTRY.id, 10)[0]!.outcome).toBe("failed");
    expect(stateStore.readState(ENTRY.id)!.activeRun).toBeUndefined();
    const card = kanban.kanbanGetCard(rootId)!;
    expect(card.status).toBe("failed");
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(rootId)!.state).toBe("blocked");
  });

  it("emits exactly one root terminal card event for the last-resort settlement", async () => {
    const { rootId, run } = await seedScheduledProject();
    const nerveBus = (await import("../nerve.js")).nerve;
    const failed: number[] = [];
    const onFailed = (cardId: number): void => { failed.push(cardId); };
    nerveBus.on("card:failed", onFailed);
    try {
      await startGeneration(new coordinatorMod.OrcProjectCoordinator({
        ownerPeer: "test-peer",
        startPort: async () => { /* working Orc */ },
      }));
      reconciler.settleProjectLastResort(rootId);
      await flush();
      await flush();
      expect(historyStore.recentRuns(ENTRY.id, 10)).toHaveLength(1);
      expect(failed.filter(id => id === rootId)).toHaveLength(1);
    } finally {
      nerveBus.off("card:failed", onFailed);
    }
  });

  it("fails the root when no active scheduled run matches the recovered card", async () => {
    writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), "[]");
    const rootId = kanban.kanbanEnqueue("Orphaned Scheduled Project", "task", "missing-run", {
      type: "O",
      goal: "supervised work",
      maxAgents: 2,
    });
    const store = new reviewStoreMod.ProjectReviewStore();
    store.insertContract(makeContract(rootId));
    store.initializeSupervision(rootId, `ct_${rootId}`, "executing");
    kanban.kanbanRunning(rootId);

    await startGeneration(new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "test-peer",
      startPort: async () => { /* working Orc */ },
    }));
    reconciler.settleProjectLastResort(rootId);
    await flush();

    expect(kanban.kanbanGetCard(rootId)!.status).toBe("failed");
    expect(store.getSupervision(rootId)!.state).toBe("blocked");
    expect(historyStore.recentRuns(ENTRY.id, 10)).toHaveLength(0);
  });

  it("recovers claim -> queued/due -> retry wake to a single owner and promotes exactly once", async () => {
    const coordinator = new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "test-peer",
      startPort: async () => { /* a working Orc keeps its claim live */ },
    });
    await startGeneration(coordinator);
    const { rootId } = await seedScheduledProject({ cardStatus: "queued" });
    const runStore = new runStoreMod.OrcProjectRunStore();

    // wake 1: queued due root with no owner -> one correlated claim, then promote
    reconciler.requestReconcile(rootId);
    await flush();
    expect(runStore.getLiveRuns()).toHaveLength(1);
    expect(kanban.kanbanGetCard(rootId)!.status).toBe("running");
    expect(kanban.kanbanGetCard(rootId)!.next_retry_at).toBeNull();

    // crash window: the card is re-queued with a due marker while the claim stays live
    kanban.kanbanRetryOrFail(rootId, "crash before card write");
    kanban._kanbanExecForTest(
      `UPDATE kanban_board SET next_retry_at = ? WHERE id = ?`,
      [new Date(Date.now() - 1000).toISOString(), rootId],
    );
    expect(kanban.kanbanGetCard(rootId)!.status).toBe("queued");
    reconciler.requestReconcile(rootId);
    await flush();

    // the next wake observes the already-owned claim and promotes — no second run
    expect(runStore.getLiveRuns()).toHaveLength(1);
    expect(kanban.kanbanGetCard(rootId)!.status).toBe("running");
    expect(kanban.kanbanGetCard(rootId)!.next_retry_at).toBeNull();
    expect(kanban.kanbanGetCard(rootId)!.retry_count).toBe(1);
  });

  it("never settles on a busy/foreign live row and never creates a second run", async () => {
    const coordinator = new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "test-peer",
      startPort: async () => { /* working Orc */ },
    });
    const { rootId } = await seedScheduledProject();
    // a foreign-instance live claim predates the driver; supervision advanced
    const seeded = coordinator.getStore().claimIntent(
      { projectCardId: rootId, intentKind: "contract_authoring", originKind: "local", cardSource: "task", sourcePeer: null },
      "other-peer",
      "other-instance",
    );
    expect(seeded.kind).toBe("claimed");
    const store = new reviewStoreMod.ProjectReviewStore();
    store.incrementGeneration(rootId); // generation advanced past the stale row

    // #1554: starting the generation runs coordinator boot recovery exactly
    // once — the stale foreign row is superseded, never settled.
    await startGeneration(coordinator);
    reconciler.requestReconcile(rootId);
    await flush();

    // the driver re-claims through its own coordinator; the stale run is
    // superseded, not settled: no history row, one live run, project untouched
    expect(new runStoreMod.OrcProjectRunStore().getLiveRuns()).toHaveLength(1);
    expect(kanban.kanbanGetCard(rootId)!.status).toBe("running");
    expect(store.getSupervision(rootId)!.state).toBe("executing");
    expect(historyStore.recentRuns(ENTRY.id, 10)).toHaveLength(0);
  });

  it("promotes a queued due root whose existing owner is a live matching claim", async () => {
    const coordinator = new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "test-peer",
      startPort: async () => { /* working Orc */ },
    });
    // #1554: the generation owns the coordinator; the driver's own authoring
    // claim on the admission wake is the live owner the promotion re-observes.
    await startGeneration(coordinator);
    const { rootId } = await seedScheduledProject({ cardStatus: "queued" });

    reconciler.requestReconcile(rootId);
    await flush();

    // the owner exists -> no new claim, only the promotion
    expect(new runStoreMod.OrcProjectRunStore().getLiveRuns()).toHaveLength(1);
    expect(kanban.kanbanGetCard(rootId)!.status).toBe("running");
  });
});
