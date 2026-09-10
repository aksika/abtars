/**
 * orc-project-coordinator.test.ts — #1792 retirement follow-up.
 *
 * The supervised scheduling path (scheduleContractAuthoring,
 * scheduleProjectExecution, scheduleReview, scheduleRepairReview,
 * scheduleInputResume, scheduleOperatorTurn, scheduleProjectSalvage,
 * scheduleInternal + turn-spec/start-port helpers) is deleted: the workflow
 * runner dispatches all work now. Tests that only pinned those schedule
 * methods (origin derivation, caller-goal/promotion starts, review ordinal
 * escalation, omitted-goal default, start-port auto-release) are deleted
 * with them.
 *
 * Preserved through runner/store tests (not re-pinned here, per #1792):
 * admission, one-owner/CAS, occurrence-terminal, deduplication and
 * late-release protection are covered by
 * `src/components/orc-project/orc-workflow-runner.test.ts`,
 * `src/components/orc-project/orc-workflow-store.test.ts` and
 * `src/tests/e2e/orc-workflow.e2e.test.ts`.
 *
 * Retained here (live via spin.ts release path + reconciler boot recovery):
 * release, supersede (boot recovery), late-release/stale-context rejection,
 * ownership-released event ordering, failed-release classification, and the
 * bounded failure-code CAS. Claim setups that previously went through the
 * deleted schedule methods now use `store.claimIntent` directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { OrcInvocationContextV2 } from "./orc-project-contracts.js";

let TEST_HOME: string;
let CoordinatorType: typeof import("./orc-project-coordinator.js").OrcProjectCoordinator;
let classifyFailedRelease: typeof import("./orc-project-coordinator.js").classifyFailedRelease;

function cleanHome(dir: string): void {
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `orc-coordinator-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const mod = await import("./orc-project-coordinator.js");
  CoordinatorType = mod.OrcProjectCoordinator;
  classifyFailedRelease = mod.classifyFailedRelease;
});

afterAll(() => {
  cleanHome(TEST_HOME);
});

function ensureSupervisionTable(store: import("./orc-project-run-store.js").OrcProjectRunStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS project_supervision (
      project_card_id INTEGER PRIMARY KEY,
      contract_id TEXT,
      state TEXT NOT NULL DEFAULT 'executing',
      generation INTEGER NOT NULL DEFAULT 1,
      review_round INTEGER NOT NULL DEFAULT 0,
      repair_round INTEGER NOT NULL DEFAULT 0,
      active_review_case_id TEXT,
      accepted_decision_id TEXT,
      blocked_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_contracts (
      project_card_id INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS project_review_cases (
      project_card_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_input_requests (
      project_card_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
}

function seedProject(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number, state = "awaiting_contract"): void {
  store.db.prepare(`
    INSERT OR IGNORE INTO project_supervision (project_card_id, contract_id, state, generation, updated_at)
    VALUES (?, '', ?, 1, ?)
  `).run(cardId, state, new Date().toISOString());
  if (state === "executing") {
    store.db.prepare(`INSERT OR IGNORE INTO project_contracts (project_card_id) VALUES (?)`).run(cardId);
  }
}

interface Harness {
  coordinator: InstanceType<typeof CoordinatorType>;
  store: import("./orc-project-run-store.js").OrcProjectRunStore;
}

function makeHarness(): Harness {
  const coordinator = new CoordinatorType({
    ownerInstanceId: "inst_1",
  });
  ensureSupervisionTable(coordinator.getStore() as any);
  coordinator.getStore().db.exec(`DELETE FROM orc_project_runs`);
  coordinator.getStore().db.exec(`DELETE FROM orc_project_ownership_counters`);
  coordinator.getStore().db.exec(`DELETE FROM project_supervision`);
  coordinator.getStore().db.exec(`DELETE FROM project_contracts`);
  coordinator.getStore().db.exec(`DELETE FROM project_review_cases`);
  coordinator.getStore().db.exec(`DELETE FROM project_input_requests`);
  return {
    coordinator,
    store: coordinator.getStore() as any,
  };
}

/** Claim + promote an operator-turn run directly through the store.
 * #1792: `operator_turn` is the only surviving intent-policy row, so
 * release-path setups claim it — all release/supersede/event paths under
 * test are intent-agnostic. */
function claimOperatorTurn(h: Harness, cardId: number): OrcInvocationContextV2 {
  const claimed = h.store.claimIntent({
    projectCardId: cardId,
    intentKind: "operator_turn",
    goal: `test goal ${cardId}`,
    originKind: "local",
    cardSource: "agent",
    sourcePeer: null,
  }, "kp", "inst_1");
  if (claimed.kind !== "claimed") throw new Error(`claim failed for card ${cardId}: ${JSON.stringify(claimed)}`);
  expect(h.store.promoteRun(claimed.context.runId)).toBe(true);
  return claimed.context;
}

// ── #1628: ownership-released event ───────────────────────────────────────────

describe("OrcProjectCoordinator ownership-released event (#1628)", () => {
  it("publishes exactly one event per applied release, with correct fields", () => {
    const h = makeHarness();
    seedProject(h.store, 7);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    const off = h.coordinator.onOwnershipReleased((e) => events.push(e));

    const context = claimOperatorTurn(h, 7);

    expect(h.coordinator.releaseOwnedRun(context, "failed")).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 1,
      projectCardId: 7,
      runId: context.runId,
      intentKind: "operator_turn",
      outcome: "failed",
      started: false,
    });

    off();
    expect(h.coordinator.releaseOwnedRun(context, "completed")).toBe(false); // already released
    expect(events).toHaveLength(1); // lost CAS publishes nothing
  });

  it("publishes started=true for a run that reached the running bind", () => {
    const h = makeHarness();
    seedProject(h.store, 8);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const context = claimOperatorTurn(h, 8);
    const bind = h.store.bindExecution(context, "sess_8", "exec_8");
    expect(bind.ok).toBe(true);
    // spin rebuilds the session context with the bound session/execution IDs
    const boundContext = { ...context, sessionId: "sess_8", executionId: "exec_8" };

    expect(h.coordinator.releaseOwnedRun(boundContext, "completed")).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.started).toBe(true);
  });

  it("publishes through the boot-recovery supersede path and returns affected project IDs", () => {
    const h = makeHarness();
    seedProject(h.store, 9);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    // a live run owned by a foreign instance
    const foreign = h.store.claimIntent(
      { projectCardId: 9, intentKind: "operator_turn", goal: "foreign goal", originKind: "local", cardSource: "agent", sourcePeer: null },
      "other-peer", "other-instance",
    );
    expect(foreign.kind).toBe("claimed");

    const affected = h.coordinator.bootRecovery();
    expect(affected).toEqual([9]);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("stale");
    const row = h.store.getRun(foreign.kind === "claimed" ? foreign.context.runId : "");
    expect(row?.state).toBe("superseded");
  });

  it("a throwing listener is fail-isolated and never changes the release result", () => {
    const h = makeHarness();
    seedProject(h.store, 10);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased(() => { throw new Error("listener boom"); });
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const context = claimOperatorTurn(h, 10);

    expect(h.coordinator.releaseOwnedRun(context, "failed")).toBe(true);
    expect(events).toHaveLength(1); // the second listener still ran
  });
});

// ── #1671: failed-release classification ──────────────────────────────────────

describe("classifyFailedRelease (#1671)", () => {
  it("classifies a missing run as run_unknown", () => {
    const h = makeHarness();
    const failure = classifyFailedRelease(h.store, {
      version: 2,
      runId: "or_nope",
      intentKey: "contract:999:1",
      intentKind: "operator_turn",
      projectCardId: 999,
      projectGeneration: 1,
      ownershipGeneration: 1,
      ownerPeer: "kp",
      ownerInstanceId: "inst_1",
      origin: { kind: "local" },
    });
    expect(failure).toEqual({ kind: "run_unknown" });
  });

  it("classifies a released row as already_terminal idempotency", () => {
    const h = makeHarness();
    seedProject(h.store, 11);
    const context = claimOperatorTurn(h, 11);
    expect(h.coordinator.releaseOwnedRun(context, "completed")).toBe(true);

    const failure = classifyFailedRelease(h.store, context);
    expect(failure).toEqual({ kind: "already_terminal", state: "released" });
  });

  it("classifies a still-live row with a mismatched context as rejected_live with a typed reason", () => {
    const h = makeHarness();
    seedProject(h.store, 12);
    const context = claimOperatorTurn(h, 12);
    const bind = h.store.bindExecution(context, "sess_12", "exec_12");
    expect(bind.ok).toBe(true);

    // a stale context whose execution ID no longer matches the bound run
    const stale = { ...context, sessionId: "sess_12", executionId: "exec_OTHER" };
    expect(h.store.release(stale, "completed")).toBe(false);

    const failure = classifyFailedRelease(h.store, stale);
    expect(failure).toEqual({
      kind: "rejected_live",
      state: "running",
      reason: "execution_mismatch",
    });
    // the live row was not mutated by the failed release
    expect(h.store.getRun(context.runId)?.state).toBe("running");
  });

  it("classifies a superseded row as already_terminal and never releases it", () => {
    const h = makeHarness();
    seedProject(h.store, 13);
    const context = claimOperatorTurn(h, 13);
    expect(h.store.supersede(context.runId, "stale")).toBe(true);

    const failure = classifyFailedRelease(h.store, context);
    expect(failure).toEqual({ kind: "already_terminal", state: "superseded" });
    expect(h.store.getRun(context.runId)?.state).toBe("superseded");
  });
});

// ── #1671: global-progress regression (real SQLite) ───────────────────────────

describe("#1671 global progress (real SQLite)", () => {
  it("releases A before the ownership event and promotes B after a successful terminal", () => {
    const h = makeHarness();
    seedProject(h.store, 21);
    seedProject(h.store, 22);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    const observedAtEvent: string[] = [];
    h.coordinator.onOwnershipReleased((e) => {
      observedAtEvent.push(h.store.getRun(e.runId)?.state ?? "missing");
      events.push(e);
    });

    // claim A and B: A takes the global slot (dispatching), B stays scheduled
    const a = claimOperatorTurn(h, 21);
    const bClaimed = h.store.claimIntent({
      projectCardId: 22, intentKind: "operator_turn", goal: "test goal 22",
      originKind: "local", cardSource: "agent", sourcePeer: null,
    }, "kp", "inst_1");
    expect(bClaimed.kind).toBe("claimed");
    if (bClaimed.kind !== "claimed") return;
    expect(h.store.getRun(bClaimed.context.runId)?.state).toBe("scheduled");

    // bind A to a real session/execution
    const bind = h.store.bindExecution(a, "sess_21", "exec_21");
    expect(bind.ok).toBe(true);
    const boundContext = { ...a, sessionId: "sess_21", executionId: "exec_21" };

    // terminal release through the coordinator
    const released = h.coordinator.releaseOwnedRun(boundContext, "completed");
    expect(released).toBe(true);

    // A is durable-terminal BEFORE the ownership listener saw it
    expect(h.store.getRun(a.runId)?.state).toBe("released");
    expect(observedAtEvent).toEqual(["released"]);
    expect(events).toHaveLength(1);

    // B acquires the global slot after release
    expect(h.store.getRun(bClaimed.context.runId)?.state).toBe("scheduled");
    h.store.promoteRun(bClaimed.context.runId);
    expect(h.store.getRun(bClaimed.context.runId)?.state).toBe("dispatching");
  });

  it("promotes B after a failed terminal execution too", () => {
    const h = makeHarness();
    seedProject(h.store, 23);
    seedProject(h.store, 24);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const a = claimOperatorTurn(h, 23);
    const bClaimed = h.store.claimIntent({
      projectCardId: 24, intentKind: "operator_turn", goal: "test goal 24",
      originKind: "local", cardSource: "agent", sourcePeer: null,
    }, "kp", "inst_1");
    expect(bClaimed.kind).toBe("claimed");
    if (bClaimed.kind !== "claimed") return;

    const bind = h.store.bindExecution(a, "sess_23", "exec_23");
    expect(bind.ok).toBe(true);
    const boundContext = { ...a, sessionId: "sess_23", executionId: "exec_23" };

    expect(h.coordinator.releaseOwnedRun(boundContext, "failed")).toBe(true);
    expect(h.store.getRun(a.runId)?.state).toBe("released");
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("failed");

    h.store.promoteRun(bClaimed.context.runId);
    expect(h.store.getRun(bClaimed.context.runId)?.state).toBe("dispatching");
  });

  it("a stale live context can never release the row nor emit an ownership event", () => {
    const h = makeHarness();
    seedProject(h.store, 25);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const a = claimOperatorTurn(h, 25);
    const bind = h.store.bindExecution(a, "sess_25", "exec_25");
    expect(bind.ok).toBe(true);

    const stale = { ...a, sessionId: "sess_25", executionId: "exec_OTHER" };
    expect(h.coordinator.releaseOwnedRun(stale, "completed")).toBe(false);
    expect(h.store.getRun(a.runId)?.state).toBe("running");
    expect(events).toHaveLength(0);
  });
});

// ── #1673: terminal cleanup after a project generation advance (real SQLite) ──

describe("#1673 terminal cleanup after a project generation advance (real SQLite)", () => {
  it("releases its own run after supervision advances and lets the queued run take the global slot", () => {
    const h = makeHarness();
    seedProject(h.store, 31);
    seedProject(h.store, 32);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    const observedAtEvent: string[] = [];
    h.coordinator.onOwnershipReleased((e) => {
      observedAtEvent.push(h.store.getRun(e.runId)?.state ?? "missing");
      events.push(e);
    });

    // claim A and B: A takes the global slot (dispatching), B stays scheduled
    const a = claimOperatorTurn(h, 31);
    const bClaimed = h.store.claimIntent({
      projectCardId: 32, intentKind: "operator_turn", goal: "test goal 32",
      originKind: "local", cardSource: "agent", sourcePeer: null,
    }, "kp", "inst_1");
    expect(bClaimed.kind).toBe("claimed");
    if (bClaimed.kind !== "claimed") return;

    // bind A to a real session/execution
    const bind = h.store.bindExecution(a, "sess_31", "exec_31");
    expect(bind.ok).toBe(true);
    const boundContext = { ...a, sessionId: "sess_31", executionId: "exec_31" };

    // the turn's durable work advanced the project's supervision generation
    h.store.db.prepare("UPDATE project_supervision SET generation = 2 WHERE project_card_id = 31").run();

    // terminal release happens AFTER the advance — the normal turn ordering
    const released = h.coordinator.releaseOwnedRun(boundContext, "completed");
    expect(released).toBe(true);

    // the run row is durable-terminal with the caller's outcome preserved
    const row = h.store.getRun(a.runId);
    expect(row?.state).toBe("released");
    expect(row?.outcome).toBe("completed");
    expect(row?.released_at).not.toBeNull();
    expect(row?.project_generation).toBe(1);

    // durable terminal precedes the ownership event; exactly one event fires
    expect(observedAtEvent).toEqual(["released"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("completed");

    // B acquires the global slot once A's row no longer holds it
    expect(h.store.getRun(bClaimed.context.runId)?.state).toBe("scheduled");
    h.store.promoteRun(bClaimed.context.runId);
    expect(h.store.getRun(bClaimed.context.runId)?.state).toBe("dispatching");
  });

  it("still rejects foreign owner, session, and execution contexts after the advance", () => {
    const h = makeHarness();
    seedProject(h.store, 33);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const a = claimOperatorTurn(h, 33);
    const bind = h.store.bindExecution(a, "sess_33", "exec_33");
    expect(bind.ok).toBe(true);

    // the project's supervision generation advances past the run's
    h.store.db.prepare("UPDATE project_supervision SET generation = 2 WHERE project_card_id = 33").run();

    // every identity/ownership fence must still reject a mismatched context
    expect(h.coordinator.releaseOwnedRun({ ...a, ownerInstanceId: "inst_2" }, "completed")).toBe(false);
    expect(h.coordinator.releaseOwnedRun({ ...a, sessionId: "sess_33", executionId: "exec_OTHER" }, "completed")).toBe(false);
    expect(h.coordinator.releaseOwnedRun({ ...a, sessionId: "sess_OTHER", executionId: "exec_33" }, "completed")).toBe(false);
    expect(h.coordinator.releaseOwnedRun({ ...a, ownershipGeneration: a.ownershipGeneration + 1 }, "completed")).toBe(false);
    expect(h.coordinator.releaseOwnedRun({ ...a, projectGeneration: 2 }, "completed")).toBe(false);

    expect(h.store.getRun(a.runId)?.state).toBe("running");
    expect(events).toHaveLength(0);

    // the correct bound context still releases after the advance
    expect(h.coordinator.releaseOwnedRun({ ...a, sessionId: "sess_33", executionId: "exec_33" }, "completed")).toBe(true);
    expect(h.store.getRun(a.runId)?.state).toBe("released");
    expect(events).toHaveLength(1);
  });
});

// ── boot recovery supersession (live via reconciler) ──────────────────────────

describe("boot recovery supersession", () => {
  it("boot recovery never leaves a dispatching run without a starter", () => {
    const h = makeHarness();
    seedProject(h.store, 80);

    const context = claimOperatorTurn(h, 80);

    // Simulate a boot that interrupts the turn before it binds: the run is
    // dispatching with no session/execution.
    expect(h.store.getRun(context.runId)?.state).toBe("dispatching");
    expect(h.store.getRun(context.runId)?.session_id).toBeNull();

    const affected = h.coordinator.bootRecovery();
    expect(affected).toEqual([80]);

    // The impossible run was superseded; boot recovery promoted nothing, so
    // the global slot is free rather than held by an unstarted run.
    expect(h.store.getRun(context.runId)?.state).toBe("superseded");
    expect(h.store.getLiveRuns()).toHaveLength(0);
  });
});

describe("#1680 durable bounded run diagnostics (failure_code)", () => {
  it("the release CAS writes the bounded failure code and success always writes NULL", () => {
    const h = makeHarness();
    seedProject(h.store, 91);
    const claim = h.store.claimIntent({
      projectCardId: 91, intentKind: "operator_turn", goal: "test goal 91",
      originKind: "local", cardSource: "agent", sourcePeer: null,
    }, "kp", "inst_1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(h.store.promoteRun(claim.context.runId)).toBe(true);

    const failed = h.store.release({ ...claim.context, sessionId: "s_1", executionId: "e_1" }, "failed", "provider_failure");
    expect(failed).toBe(true);
    expect(h.store.getRun(claim.context.runId)?.failure_code).toBe("provider_failure");

    const claim2 = h.store.claimIntent({
      projectCardId: 91, intentKind: "operator_turn", goal: "test goal 91 retry",
      originKind: "local", cardSource: "agent", sourcePeer: null,
    }, "kp", "inst_1");
    expect(claim2.kind).toBe("claimed");
    if (claim2.kind !== "claimed") return;
    expect(h.store.promoteRun(claim2.context.runId)).toBe(true);
    const completed = h.store.release({ ...claim2.context, sessionId: "s_2", executionId: "e_2" }, "completed");
    expect(completed).toBe(true);
    const row = h.store.getRun(claim2.context.runId);
    expect(row?.outcome).toBe("completed");
    expect(row?.failure_code).toBeNull();
  });

  it("a failed release without a stated reason defaults to provider_failure", () => {
    const h = makeHarness();
    seedProject(h.store, 92);
    const claim = h.store.claimIntent({
      projectCardId: 92, intentKind: "operator_turn", goal: "test goal 92",
      originKind: "local", cardSource: "agent", sourcePeer: null,
    }, "kp", "inst_1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(h.store.promoteRun(claim.context.runId)).toBe(true);
    expect(h.store.release({ ...claim.context, sessionId: "s_3", executionId: "e_3" }, "failed")).toBe(true);
    expect(h.store.getRun(claim.context.runId)?.failure_code).toBe("provider_failure");
  });
});
