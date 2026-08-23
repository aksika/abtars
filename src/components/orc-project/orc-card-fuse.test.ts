/**
 * orc-card-fuse.test.ts — #1707 Task 4: the same-card circuit breaker.
 * A deterministic storm proves one card cannot create unbounded run rows or
 * provider starts; the tripped fuse is durable across restarts and cleared
 * only by an explicit reset that leaves terminal history terminal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectAcceptanceContractV1 } from "../project-acceptance/project-contract.js";

let TEST_HOME: string;
let kanban: typeof import("../tasks/kanban-board.js");
let runStoreMod: typeof import("./orc-project-run-store.js");
let contractsMod: typeof import("./orc-project-contracts.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let stateStore: typeof import("../tasks/task-state-store.js");
let taskStore: typeof import("../tasks/task-store.js");

const ENTRY = {
  id: "fuse-task",
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
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-card-fuse-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("../tasks/kanban-board.js");
  runStoreMod = await import("./orc-project-run-store.js");
  contractsMod = await import("./orc-project-contracts.js");
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

function claim(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number): ReturnType<import("./orc-project-run-store.js").OrcProjectRunStore["claimIntent"]> {
  // No taskRunId bound: the windowed churn counters are under test here, not
  // the per-occurrence terminal-attempt rule.
  return store.claimIntent({
    projectCardId: cardId,
    intentKind: "project_execution",
    goal: "execute",
    originKind: "local",
    cardSource: "task",
    sourcePeer: null,
  }, "p", "inst");
}

describe("#1707 same-card circuit breaker", () => {
  it("a deterministic same-card storm creates bounded rows and then refuses — never thousands", async () => {
    const { rootId } = seedScheduledProject();

    const store = new runStoreMod.OrcProjectRunStore();
    let claimedCount = 0;
    for (let wake = 0; wake < 1000; wake++) {
      const result = claim(store, rootId);
      if (result.kind === "claimed") {
        claimedCount++;
        expect(store.release(result.context, "failed", "provider_failure")).toBe(true);
      } else if (result.kind === "not_actionable" && result.reason === "fuse_open") {
        // fuse holds for every later wake
      } else {
        throw new Error(`unexpected claim result at wake ${wake}: ${JSON.stringify(result)}`);
      }
    }

    // Exactly the policy limit of failed attempts ever landed; every one of
    // the 1000 wakes after that was refused by the durable fuse.
    expect(claimedCount).toBe(3);
    expect(store.getRunsForProject(rootId).length).toBeLessThanOrEqual(3);

    const trip = store.db.prepare(`SELECT opened_at, trip_reason FROM orc_fuse_state WHERE scope = ?`).get(`card:${rootId}`) as { opened_at: string; trip_reason: string };
    expect(trip.opened_at).toBeTruthy();
    expect(trip.trip_reason).toBe("failed_attempts:3");
  });

  it("the fuse survives an ordinary restart (fresh store over the same database)", async () => {
    const { rootId } = seedScheduledProject();

    const first = new runStoreMod.OrcProjectRunStore();
    for (let i = 0; i < 3; i++) {
      const r = claim(first, rootId);
      if (r.kind !== "claimed") throw new Error("expected claims to succeed pre-trip");
      first.release(r.context, "failed", "provider_failure");
    }
    expect(claim(first, rootId)).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });

    // "Restart": brand-new store instance over the same durable database.
    const restarted = new runStoreMod.OrcProjectRunStore();
    expect(restarted.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "execute",
      originKind: "local", cardSource: "task", sourcePeer: null,
    }, "p", "inst2")).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });
  });

  it("durable progress clears the consecutive-failure streak", async () => {
    const { rootId } = seedScheduledProject();
    const store = new runStoreMod.OrcProjectRunStore();

    // Two failures, one success, two failures: never 3 consecutive.
    const cycle = (outcome: "failed" | "completed"): void => {
      const r = claim(store, rootId);
      if (r.kind !== "claimed") throw new Error(`claim refused unexpectedly: ${JSON.stringify(r)}`);
      store.release(r.context, outcome);
    };
    cycle("failed");
    cycle("failed");
    cycle("completed");
    cycle("failed");
    cycle("failed");

    // Streak is clean (progress cleared it); a third failure trips, not before.
    const snapshot = store.getFuseSnapshot().find(f => f.scope === `card:${rootId}`);
    expect(snapshot?.openedAt ?? null).toBeNull();
    cycle("failed");
    expect(claim(store, rootId)).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });
  });

  it("reset clears only fuse state — terminal attempts stay terminal and need no reuse", async () => {
    const { rootId, runId } = seedScheduledProject();
    const store = new runStoreMod.OrcProjectRunStore();

    // Trip via execution hard rule.
    const r = store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "work",
      originKind: "local", cardSource: "task", sourcePeer: null, taskRunId: runId,
    }, "p", "inst");
    if (r.kind !== "claimed") throw new Error("claim failed");
    store.release(r.context, "failed", "provider_failure");

    store.resetProjectFuse(rootId);
    const snap = store.getFuseSnapshot().find(f => f.scope === `card:${rootId}`);
    expect(snap?.openedAt ?? null).toBeNull();
    expect(snap?.generation).toBeGreaterThan(0);

    // History untouched: the failed attempt row is still there and terminal.
    const rows = store.getRunsForProject(rootId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("released");
    expect(rows[0]!.outcome).toBe("failed");

    // The reset admits exactly one NEW attempt (new generation), not a reuse.
    const retry = store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "work",
      originKind: "local", cardSource: "task", sourcePeer: null, taskRunId: runId,
    }, "p", "inst");
    expect(["claimed", "idempotent"]).toContain(retry.kind);
  });

  it("concurrent wakes cannot bypass the fuse — total rows stay bounded", async () => {
    const { rootId } = seedScheduledProject();
    const store = new runStoreMod.OrcProjectRunStore();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve().then(() => claim(store, rootId))),
    );
    const claimed = results.filter(r => r.kind === "claimed");
    expect(claimed.length).toBeLessThanOrEqual(3 + 1); // window limit + in-flight winner
  });
});

describe("#1708 policy-controlled guardrails", () => {
  it("a lowered policy threshold trips on the next claim when durable history already meets it", async () => {
    const { rootId } = seedScheduledProject();
    let limit = 3;
    const store = new runStoreMod.OrcProjectRunStore(undefined, {
      guardrailsProvider: () => ({ ...contractsMod.DEFAULT_ORC_GUARDRAILS, sameCard: { ...contractsMod.DEFAULT_ORC_GUARDRAILS.sameCard, failedOrNoProgress: { max: limit, windowMinutes: 10 } } }),
    });

    // Two failures under the shipped default of 3: no fuse yet.
    for (let i = 0; i < 2; i++) {
      const r = claim(store, rootId);
      if (r.kind !== "claimed") throw new Error(`claim ${i} refused unexpectedly`);
      store.release(r.context, "failed", "provider_failure");
    }
    const third = claim(store, rootId);
    if (third.kind !== "claimed") throw new Error("third claim refused unexpectedly");
    expect(store.release(third.context, "failed", "provider_failure")).toBe(true);

    // Policy "reload" lowers the threshold to 2: the NEXT claim sees it and
    // the existing window counts already meet it.
    limit = 2;
    const afterReload = store.claimIntent({
      projectCardId: rootId, intentKind: "project_execution", goal: "execute",
      originKind: "local", cardSource: "task", sourcePeer: null,
    }, "p", "inst");
    expect(afterReload).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });
    const trip = store.getFuseSnapshot().find(f => f.scope === `card:${rootId}`);
    expect(trip?.openedAt).toBeTruthy();
  });

  it("a throwing provider falls back to shipped defaults instead of skipping the fuse", async () => {
    const { rootId } = seedScheduledProject();
    let shouldThrow = false;
    const store = new runStoreMod.OrcProjectRunStore(undefined, {
      guardrailsProvider: () => {
        if (shouldThrow) throw new Error("policy read failed");
        return contractsMod.DEFAULT_ORC_GUARDRAILS;
      },
    });

    for (let i = 0; i < 3; i++) {
      const r = claim(store, rootId);
      if (r.kind !== "claimed") throw new Error(`claim ${i} refused unexpectedly`);
      store.release(r.context, "failed", "provider_failure");
    }
    // Provider breaks AFTER the durable history exists: defaults still apply.
    shouldThrow = true;
    expect(claim(store, rootId)).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });
  });

  it("an already-open fuse stays open across a policy reload that raises thresholds", async () => {
    const { rootId } = seedScheduledProject();
    let max = 1;
    const store = new runStoreMod.OrcProjectRunStore(undefined, {
      guardrailsProvider: () => ({ ...contractsMod.DEFAULT_ORC_GUARDRAILS, sameCard: { ...contractsMod.DEFAULT_ORC_GUARDRAILS.sameCard, failedOrNoProgress: { max, windowMinutes: 10 } } }),
    });

    const r = claim(store, rootId);
    if (r.kind !== "claimed") throw new Error("claim refused unexpectedly");
    store.release(r.context, "failed", "provider_failure");
    expect(claim(store, rootId)).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });

    // A reload that raises the limit must NOT clear or bypass the open fuse.
    max = 3;
    expect(claim(store, rootId)).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });
    const row = store.db.prepare(`SELECT opened_at FROM orc_fuse_state WHERE scope = ?`).get(`card:${rootId}`) as { opened_at: string };
    expect(row.opened_at).toBeTruthy();
  });

  it("ordinary restart reconstructs from durable state and reads current effective policy", async () => {
    const { rootId } = seedScheduledProject();
    const first = new runStoreMod.OrcProjectRunStore(undefined, {
      guardrailsProvider: () => ({ ...contractsMod.DEFAULT_ORC_GUARDRAILS, sameCard: { ...contractsMod.DEFAULT_ORC_GUARDRAILS.sameCard, failedOrNoProgress: { max: 1, windowMinutes: 10 } } }),
    });
    const r = claim(first, rootId);
    if (r.kind !== "claimed") throw new Error("claim refused unexpectedly");
    first.release(r.context, "failed", "provider_failure");
    expect(claim(first, rootId)).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });

    // Fresh store (restart), default provider: the durable fuse still holds.
    const restarted = new runStoreMod.OrcProjectRunStore();
    expect(claim(restarted, rootId)).toMatchObject({ kind: "not_actionable", reason: "fuse_open" });
  });
});
