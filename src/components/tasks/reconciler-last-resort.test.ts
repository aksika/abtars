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
      reconciler.settleProjectLastResort(rootId);
      await flush();
      await flush();
      expect(historyStore.recentRuns(ENTRY.id, 10)).toHaveLength(1);
      expect(failed.filter(id => id === rootId)).toHaveLength(1);
    } finally {
      nerveBus.off("card:failed", onFailed);
    }
  });

  it("recovers claim -> queued/due -> retry wake to a single owner and promotes exactly once", async () => {
    const coordinator = new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "test-peer",
      startPort: async () => { /* a working Orc keeps its claim live */ },
    });
    reconciler.setOrcCoordinator(coordinator);
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

    reconciler.setOrcCoordinator(coordinator);
    reconciler.requestReconcile(rootId);
    await flush();

    // busy is ownership: no settlement, no second run, project untouched
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
    const { rootId } = await seedScheduledProject({ cardStatus: "queued" });
    // an authoring/continuation claim already owns the project
    const claim = coordinator.getStore().claimIntent(
      { projectCardId: rootId, intentKind: "contract_authoring", originKind: "local", cardSource: "task", sourcePeer: null },
      "test-peer",
      "test-instance",
    );
    expect(claim.kind).toBe("claimed");

    reconciler.setOrcCoordinator(coordinator);
    reconciler.requestReconcile(rootId);
    await flush();

    // the owner exists -> no new claim, only the promotion
    expect(new runStoreMod.OrcProjectRunStore().getLiveRuns()).toHaveLength(1);
    expect(kanban.kanbanGetCard(rootId)!.status).toBe("running");
  });
});
