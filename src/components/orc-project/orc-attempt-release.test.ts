/**
 * orc-attempt-release.test.ts — #1707 Task 2: durable attempt outcomes tied to
 * the owning task occurrence, wake-only ownership-release semantics, and the
 * attempt-outcome classification vocabulary. Real stores in a tmpdir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectAcceptanceContractV1 } from "../project-acceptance/project-contract.js";

let TEST_HOME: string;
let kanban: typeof import("../tasks/kanban-board.js");
let runStoreMod: typeof import("./orc-project-run-store.js");
let coordinatorMod: typeof import("./orc-project-coordinator.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let stateStore: typeof import("../tasks/task-state-store.js");
let taskStore: typeof import("../tasks/task-store.js");

const ENTRY = {
  id: "release-task",
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
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-attempt-release-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("../tasks/kanban-board.js");
  runStoreMod = await import("./orc-project-run-store.js");
  coordinatorMod = await import("./orc-project-coordinator.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  stateStore = await import("../tasks/task-state-store.js");
  taskStore = await import("../tasks/task-store.js");
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
    goal: "work",
    criteria: [{ id: "c1", description: "done", required: true, evidence_expectation: "synthesis" }],
    required_outputs: [],
    constraints: [],
    limits: {},
    provenance: { requested_by: "t", authored_by: "orc", created_at: new Date().toISOString() },
  };
}

/** Full live fixture: task catalog + active occurrence + executing supervised root. */
function seedScheduledProject(): { rootId: number; runId: string } {
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
  const rootId = kanban.kanbanEnqueue("Scheduled Project", "task", run.runId, { type: "O", goal: "work" });
  stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId: rootId });
  const reviewStore = new reviewStoreMod.ProjectReviewStore();
  reviewStore.insertContract(makeContract(rootId));
  reviewStore.initializeSupervision(rootId, `ct_${rootId}`, "executing");
  kanban.kanbanRunning(rootId);
  return { rootId, runId: run.runId };
}

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 20));
}

describe("#1707 attempt outcome classification", () => {
  it("classifies in-flight, progress, failure, no-progress, and superseded rows", () => {
    const store = new runStoreMod.OrcProjectRunStore();
    const classify = store.classifyAttemptOutcome.bind(store);
    expect(classify({ state: "running", outcome: null, started_at: "t" })).toBe("in_flight");
    expect(classify({ state: "dispatching", outcome: null, started_at: null })).toBe("in_flight");
    expect(classify({ state: "released", outcome: "completed", started_at: "t" })).toBe("progress");
    expect(classify({ state: "released", outcome: "failed", started_at: "t" })).toBe("failed");
    expect(classify({ state: "released", outcome: "failed", started_at: null })).toBe("failed");
    expect(classify({ state: "released", outcome: "cancelled", started_at: null })).toBe("no_progress");
    expect(classify({ state: "released", outcome: "cancelled", started_at: "t" })).toBe("no_progress");
    expect(classify({ state: "superseded", outcome: "stale", started_at: null })).toBe("superseded");
  });
});

describe("#1707 attempt identity and release semantics", () => {
  it("persists task_run_id on the claimed attempt for a scheduled root", () => {
    const { rootId, runId } = seedScheduledProject();
    const store = new runStoreMod.OrcProjectRunStore();
    const claimed = store.claimIntent({
      projectCardId: rootId,
      intentKind: "project_execution",
      goal: "attempt work",
      originKind: "local",
      cardSource: "task",
      sourcePeer: null,
      taskRunId: runId,
    }, "p", "inst");
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") return;
    expect(store.getRun(claimed.context.runId)!.task_run_id).toBe(runId);
  });

  it("never reuses a terminal attempt — old context is rejected after release", async () => {
    const { rootId, runId } = seedScheduledProject();
    const coordinator = new coordinatorMod.OrcProjectCoordinator({ ownerPeer: "p", startPort: async () => {} });
    const claimed = coordinator.getStore().claimIntent({
      projectCardId: rootId,
      intentKind: "project_execution",
      goal: "attempt work",
      originKind: "local",
      cardSource: "task",
      sourcePeer: null,
      taskRunId: runId,
    }, "p", "inst");
    if (claimed.kind !== "claimed") throw new Error(`claim failed: ${JSON.stringify(claimed)}`);

    expect(coordinator.getStore().release(claimed.context, "failed", "provider_failure")).toBe(true);
    // Same-attempt retry through the durable fence is impossible:
    expect(coordinator.getStore().validateCurrentContext(claimed.context)).toMatchObject({ ok: false, reason: "run_released" });
    expect(coordinator.getStore().release(claimed.context, "failed", "provider_failure")).toBe(false);
  });

  it("a released failed attempt cannot synchronously re-claim — the card fuse demands an operator reset", async () => {
    const { rootId, runId } = seedScheduledProject();
    const coordinator = new coordinatorMod.OrcProjectCoordinator({ ownerPeer: "p", startPort: async () => {} });
    const store = coordinator.getStore();
    const first = store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "attempt work",
      originKind: "local", cardSource: "task", sourcePeer: null, taskRunId: runId,
    }, "p", "inst");
    if (first.kind !== "claimed") throw new Error("first claim failed");
    expect(store.release(first.context, "failed", "provider_failure")).toBe(true);

    // A terminal execution attempt is final for automatic retries:
    expect(store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "attempt work",
      originKind: "local", cardSource: "task", sourcePeer: null, taskRunId: runId,
    }, "p", "inst")).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });

    // Operator reset clears the fuse; the retry gets a NEW attempt identity.
    store.resetProjectFuse(rootId);
    const second = store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "attempt work",
      originKind: "local", cardSource: "task", sourcePeer: null, taskRunId: runId,
    }, "p", "inst");
    if (second.kind !== "claimed") throw new Error(`post-reset claim: ${second.kind}`);
    expect(second.context.ownershipGeneration).toBe(first.context.ownershipGeneration + 1);
    expect(second.context.runId).not.toBe(first.context.runId);
  });

  it("release events fire only after the CAS lands and never authorize a same-attempt retry", async () => {
    const { rootId, runId } = seedScheduledProject();
    const coordinator = new coordinatorMod.OrcProjectCoordinator({ ownerPeer: "p", startPort: async () => {} });
    const store = coordinator.getStore();
    const claimed = store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "attempt work",
      originKind: "local", cardSource: "task", sourcePeer: null, taskRunId: runId,
    }, "p", "inst");
    if (claimed.kind !== "claimed") throw new Error("claim failed");

    const events: string[] = [];
    coordinator.onOwnershipReleased((event) => {
      events.push(event.runId);
      // Inside the wake: the row is already terminal (CAS before publish) and
      // a same-attempt release is a no-op — the wake cannot re-own or re-fail.
      expect(store.getRun(event.runId)!.state).toBe("released");
      expect(store.release(claimed.context, "failed", "provider_failure")).toBe(false);
    });

    expect(coordinator.releaseOwnedRun(claimed.context, "failed", "provider_failure")).toBe(true);
    expect(events).toEqual([claimed.context.runId]);
  });

  it("stale release events after restart are harmless — unknown/terminal rows publish nothing", async () => {
    const { rootId, runId } = seedScheduledProject();
    const coordinator = new coordinatorMod.OrcProjectCoordinator({ ownerPeer: "p", startPort: async () => {} });
    const store = coordinator.getStore();
    const claimed = store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "attempt work",
      originKind: "local", cardSource: "task", sourcePeer: null, taskRunId: runId,
    }, "p", "inst");
    if (claimed.kind !== "claimed") throw new Error("claim failed");
    store.release(claimed.context, "failed", "provider_failure");

    const events: unknown[] = [];
    coordinator.onOwnershipReleased((e) => events.push(e));
    // Late duplicate release (e.g. replayed after restart): lost CAS, no event.
    expect(coordinator.releaseOwnedRun(claimed.context, "failed", "provider_failure")).toBe(false);
    // Unknown run: no event either.
    expect(coordinator.releaseOwnedRun({ ...claimed.context, runId: `${rootId}_nope` }, "failed", "provider_failure")).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("a provider start failure auto-releases wake-only with the stable failure code", async () => {
    const { rootId } = seedScheduledProject();
    const coordinator = new coordinatorMod.OrcProjectCoordinator({
      ownerPeer: "p",
      startPort: async () => { throw new Error("provider down"); },
    });
    const store = coordinator.getStore();

    const events: string[] = [];
    coordinator.onOwnershipReleased((e) => events.push(e.runId));
    const result = coordinator.scheduleProjectExecution(rootId, "goal");
    expect(result.kind === "claimed" || result.kind === "idempotent").toBe(true);
    await flush();

    if (result.kind !== "claimed" && result.kind !== "idempotent") return;
    const row = store.getRun(result.context.runId)!;
    expect(row.state).toBe("released");
    expect(row.failure_code).toBe("start_port_rejected");
    expect(row.started_at).toBeNull();
    expect(events).toEqual([row.id]);
  });

  it("durable progress clears the card's failure streak marker", async () => {
    const { rootId, runId } = seedScheduledProject();
    const store = new runStoreMod.OrcProjectRunStore();
    const claimed = store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "attempt work",
      originKind: "local", cardSource: "task", sourcePeer: null, taskRunId: runId,
    }, "p", "inst");
    if (claimed.kind !== "claimed") throw new Error("claim failed");
    store.release(claimed.context, "completed");

    const fuse = store.db.prepare(`SELECT cleared_at FROM orc_fuse_state WHERE scope = ?`).get(`card:${rootId}`) as { cleared_at: string };
    expect(typeof fuse.cleared_at).toBe("string");
  });
});
