import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { OrcInvocationContextV2, OrcTurnSpec } from "./orc-project-contracts.js";
import { authorizePeerEgress } from "./orc-project-context.js";

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

function seedReviewCase(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number): void {
  store.db.prepare(`INSERT INTO project_review_cases (project_card_id, status) VALUES (?, 'open')`).run(cardId);
}

function seedInputRequest(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number): void {
  store.db.prepare(`INSERT INTO project_input_requests (project_card_id, status) VALUES (?, 'pending')`).run(cardId);
}

interface Harness {
  coordinator: InstanceType<typeof CoordinatorType>;
  store: import("./orc-project-run-store.js").OrcProjectRunStore;
  starts: Array<{ spec: OrcTurnSpec }>;
  setRootIdentity: (id: { source: string; sourcePeer: string | null }) => void;
}

function makeHarness(): Harness {
  const starts: Array<{ spec: OrcTurnSpec }> = [];
  let rootIdentity = { source: "agent", sourcePeer: null };
  const coordinator = new CoordinatorType({
    ownerPeer: "kp",
    ownerInstanceId: "inst_1",
    getRootIdentity: () => rootIdentity,
    startPort: async (spec: OrcTurnSpec) => { starts.push({ spec }); },
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
    starts,
    setRootIdentity: (id) => { rootIdentity = id; },
  };
}

describe("OrcProjectCoordinator origin derivation (#1618)", () => {

  it("admits a peer root with the authenticated source peer", () => {
    const h = makeHarness();
    h.setRootIdentity({ source: "peer", sourcePeer: "molty" });
    seedProject(h.store, 1);

    const result = h.coordinator.scheduleContractAuthoring(1);
    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") return;
    expect(result.context.origin.kind).toBe("peer");
    expect(result.context.origin.peer).toBe("molty");

    const row = h.store.db.prepare(`SELECT origin_kind, origin_peer FROM orc_project_runs WHERE project_card_id = 1`).get() as any;
    expect(row.origin_kind).toBe("peer");
    expect(row.origin_peer).toBe("molty");

    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]!.spec.context.origin.kind).toBe("peer");
    expect(h.starts[0]!.spec.context.origin.peer).toBe("molty");
  });

  it("fails closed on a peer root without an authenticated source peer", () => {
    const h = makeHarness();
    h.setRootIdentity({ source: "peer", sourcePeer: null });
    seedProject(h.store, 1);

    const result = h.coordinator.scheduleContractAuthoring(1);
    expect(result).toEqual({ kind: "conflict", reason: "origin_invalid" });
    const rows = h.store.db.prepare(`SELECT COUNT(*) as cnt FROM orc_project_runs`).get() as any;
    expect(rows.cnt).toBe(0);
    expect(h.starts).toHaveLength(0);
  });

  it("keeps local roots local across every intent kind", () => {
    const h = makeHarness();
    h.setRootIdentity({ source: "task", sourcePeer: null });
    seedProject(h.store, 1);
    seedProject(h.store, 2, "executing");
    seedReviewCase(h.store, 2);
    seedProject(h.store, 3, "repair_planned");
    seedProject(h.store, 4, "needs_input");
    seedInputRequest(h.store, 4);
    seedProject(h.store, 5);

    const c1 = h.coordinator.scheduleContractAuthoring(1);
    expect(c1.kind).toBe("claimed");
    if (c1.kind === "claimed") h.store.release(c1.context, "completed");
    const c2 = h.coordinator.scheduleReview(2, 1, "rc_2");
    expect(c2.kind).toBe("claimed");
    if (c2.kind === "claimed") h.store.release(c2.context, "completed");
    const c3 = h.coordinator.scheduleRepairReview(3, 1);
    expect(c3.kind).toBe("claimed");
    if (c3.kind === "claimed") h.store.release(c3.context, "completed");
    const c4 = h.coordinator.scheduleInputResume(4, 1, 2);
    expect(c4.kind).toBe("claimed");
    if (c4.kind === "claimed") h.store.release(c4.context, "completed");
    const c5 = h.coordinator.scheduleOperatorTurn(5, "op_5");
    expect(c5.kind).toBe("claimed");
    if (c5.kind === "claimed") h.store.release(c5.context, "completed");

    const rows = h.store.db.prepare(`SELECT project_card_id, intent_kind, origin_kind, origin_peer FROM orc_project_runs`).all() as any[];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.origin_kind).toBe("local");
      expect(row.origin_peer).toBeNull();
    }
  });

  it("duplicate wakes create one live run (idempotent claim)", () => {
    const h = makeHarness();
    h.setRootIdentity({ source: "peer", sourcePeer: "molty" });
    seedProject(h.store, 1);

    const first = h.coordinator.scheduleContractAuthoring(1);
    const second = h.coordinator.scheduleContractAuthoring(1);
    expect(first.kind).toBe("claimed");
    expect(second.kind).toBe("idempotent");

    const rows = h.store.db.prepare(`SELECT COUNT(*) as cnt FROM orc_project_runs WHERE project_card_id = 1`).get() as any;
    expect(rows.cnt).toBe(1);
  });

  it("preserves the caller goal and rejects phase-invalid intent claims", () => {
    const h = makeHarness();
    seedProject(h.store, 1);

    const authoring = h.coordinator.scheduleContractAuthoring(1, "machine-derived scheduled goal");
    expect(authoring.kind).toBe("claimed");
    if (authoring.kind !== "claimed") return;
    expect(h.store.getRun(authoring.context.runId)?.goal).toBe("machine-derived scheduled goal");
    expect(h.starts[0]!.spec.goal).toBe("machine-derived scheduled goal");

    expect(h.store.release(authoring.context, "completed")).toBe(true);
    expect(h.coordinator.scheduleProjectExecution(1, "too early").kind).toBe("not_actionable");

    seedProject(h.store, 2, "executing");
    expect(h.coordinator.scheduleContractAuthoring(2).kind).toBe("not_actionable");
    seedReviewCase(h.store, 2);
    expect(h.coordinator.scheduleProjectExecution(2, "higher owner exists").kind).toBe("not_actionable");
  });

  it("does not complete a turn after its exact run has been released", () => {
    const h = makeHarness();
    seedProject(h.store, 3);
    const claim = h.coordinator.scheduleContractAuthoring(3);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    h.store.db.prepare(`INSERT INTO project_contracts (project_card_id) VALUES (3)`).run();
    h.store.db.prepare(`UPDATE project_supervision SET state = 'executing' WHERE project_card_id = 3`).run();
    const control = h.starts[0]!.spec.turnControl;
    expect(h.store.release(claim.context, "completed")).toBe(true);
    expect(control.complete({ kind: "intent_satisfied", code: "contract_defined" })).toBe(false);
  });

  it("blocks peer-origin egress through the Orc context (no-relay)", () => {
    const h = makeHarness();
    h.setRootIdentity({ source: "peer", sourcePeer: "molty" });
    seedProject(h.store, 1);

    const result = h.coordinator.scheduleContractAuthoring(1);
    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") return;

    const peerCtx = result.context;
    const peerEgress = authorizePeerEgress({ orcContext: peerCtx }, h.store as any);
    expect(peerEgress.allowed).toBe(false);
    if (!peerEgress.allowed) expect(peerEgress.reason).toBe("peer_relay_blocked");
    // consume the global Orc slot before the next claim
    h.store.release(peerCtx, "completed");

    h.setRootIdentity({ source: "task", sourcePeer: null });
    seedProject(h.store, 2);
    const localResult = h.coordinator.scheduleContractAuthoring(2);
    expect(localResult.kind).toBe("claimed");
    if (localResult.kind !== "claimed") return;
    const localEgress = authorizePeerEgress({ orcContext: localResult.context }, h.store as any);
    expect(localEgress.allowed).toBe(true);
  });
});

// ── #1628: ownership-released event ───────────────────────────────────────────

describe("OrcProjectCoordinator ownership-released event (#1628)", () => {
  it("publishes exactly one event per applied release, with correct fields", () => {
    const h = makeHarness();
    seedProject(h.store, 7);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    const off = h.coordinator.onOwnershipReleased((e) => events.push(e));

    const claim = h.coordinator.scheduleContractAuthoring(7);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    expect(h.coordinator.releaseOwnedRun(claim.context, "failed")).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 1,
      projectCardId: 7,
      runId: claim.context.runId,
      intentKind: "contract_authoring",
      outcome: "failed",
      started: false,
    });

    off();
    expect(h.coordinator.releaseOwnedRun(claim.context, "completed")).toBe(false); // already released
    expect(events).toHaveLength(1); // lost CAS publishes nothing
  });

  it("publishes started=true for a run that reached the running bind", () => {
    const h = makeHarness();
    seedProject(h.store, 8);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const claim = h.coordinator.scheduleContractAuthoring(8);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    const bind = h.store.bindExecution(claim.context, "sess_8", "exec_8");
    expect(bind.ok).toBe(true);
    // spin rebuilds the session context with the bound session/execution IDs
    const boundContext = { ...claim.context, sessionId: "sess_8", executionId: "exec_8" };

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
      { projectCardId: 9, intentKind: "contract_authoring", goal: "foreign goal", originKind: "local", cardSource: "agent", sourcePeer: null },
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

    const claim = h.coordinator.scheduleContractAuthoring(10);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    expect(h.coordinator.releaseOwnedRun(claim.context, "failed")).toBe(true);
    expect(events).toHaveLength(1); // the second listener still ran
  });
});

// ── #1671: failed-release classification ──────────────────────────────────────

describe("classifyFailedRelease (#1671)", () => {
  it("classifies a missing run as run_unknown", () => {
    const h = makeHarness();
    const failure = classifyFailedRelease(h.store, {
      version: 1,
      runId: "or_nope",
      intentKey: "contract:999:1",
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
    const claim = h.coordinator.scheduleContractAuthoring(11);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(h.coordinator.releaseOwnedRun(claim.context, "completed")).toBe(true);

    const failure = classifyFailedRelease(h.store, claim.context);
    expect(failure).toEqual({ kind: "already_terminal", state: "released" });
  });

  it("classifies a still-live row with a mismatched context as rejected_live with a typed reason", () => {
    const h = makeHarness();
    seedProject(h.store, 12);
    const claim = h.coordinator.scheduleContractAuthoring(12);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    const bind = h.store.bindExecution(claim.context, "sess_12", "exec_12");
    expect(bind.ok).toBe(true);

    // a stale context whose execution ID no longer matches the bound run
    const stale = { ...claim.context, sessionId: "sess_12", executionId: "exec_OTHER" };
    expect(h.store.release(stale, "completed")).toBe(false);

    const failure = classifyFailedRelease(h.store, stale);
    expect(failure).toEqual({
      kind: "rejected_live",
      state: "running",
      reason: "execution_mismatch",
    });
    // the live row was not mutated by the failed release
    expect(h.store.getRun(claim.context.runId)?.state).toBe("running");
  });

  it("classifies a superseded row as already_terminal and never releases it", () => {
    const h = makeHarness();
    seedProject(h.store, 13);
    const claim = h.coordinator.scheduleContractAuthoring(13);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(h.store.supersede(claim.context.runId, "stale")).toBe(true);

    const failure = classifyFailedRelease(h.store, claim.context);
    expect(failure).toEqual({ kind: "already_terminal", state: "superseded" });
    expect(h.store.getRun(claim.context.runId)?.state).toBe("superseded");
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
    const a = h.coordinator.scheduleContractAuthoring(21);
    expect(a.kind).toBe("claimed");
    const b = h.coordinator.scheduleContractAuthoring(22);
    expect(b.kind).toBe("claimed");
    expect(h.starts).toHaveLength(1); // only A was promoted
    if (a.kind !== "claimed" || b.kind !== "claimed") return;

    // bind A to a real session/execution
    const bind = h.store.bindExecution(a.context, "sess_21", "exec_21");
    expect(bind.ok).toBe(true);
    const boundContext = { ...a.context, sessionId: "sess_21", executionId: "exec_21" };

    // terminal release through the coordinator
    const released = h.coordinator.releaseOwnedRun(boundContext, "completed");
    expect(released).toBe(true);

    // A is durable-terminal BEFORE the ownership listener saw it
    expect(h.store.getRun(a.context.runId)?.state).toBe("released");
    expect(observedAtEvent).toEqual(["released"]);
    expect(events).toHaveLength(1);

    // B acquires the global slot after release
    expect(h.store.getRun(b.context.runId)?.state).toBe("scheduled");
    h.store.promoteRun(b.context.runId);
    expect(h.store.getRun(b.context.runId)?.state).toBe("dispatching");
  });

  it("promotes B after a failed terminal execution too", () => {
    const h = makeHarness();
    seedProject(h.store, 23);
    seedProject(h.store, 24);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const a = h.coordinator.scheduleContractAuthoring(23);
    const b = h.coordinator.scheduleContractAuthoring(24);
    expect(a.kind).toBe("claimed");
    expect(b.kind).toBe("claimed");
    if (a.kind !== "claimed" || b.kind !== "claimed") return;

    const bind = h.store.bindExecution(a.context, "sess_23", "exec_23");
    expect(bind.ok).toBe(true);
    const boundContext = { ...a.context, sessionId: "sess_23", executionId: "exec_23" };

    expect(h.coordinator.releaseOwnedRun(boundContext, "failed")).toBe(true);
    expect(h.store.getRun(a.context.runId)?.state).toBe("released");
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("failed");

    h.store.promoteRun(b.context.runId);
    expect(h.store.getRun(b.context.runId)?.state).toBe("dispatching");
  });

  it("a stale live context can never release the row nor emit an ownership event", () => {
    const h = makeHarness();
    seedProject(h.store, 25);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const a = h.coordinator.scheduleContractAuthoring(25);
    expect(a.kind).toBe("claimed");
    if (a.kind !== "claimed") return;
    const bind = h.store.bindExecution(a.context, "sess_25", "exec_25");
    expect(bind.ok).toBe(true);

    const stale = { ...a.context, sessionId: "sess_25", executionId: "exec_OTHER" };
    expect(h.coordinator.releaseOwnedRun(stale, "completed")).toBe(false);
    expect(h.store.getRun(a.context.runId)?.state).toBe("running");
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
    const a = h.coordinator.scheduleContractAuthoring(31);
    expect(a.kind).toBe("claimed");
    const b = h.coordinator.scheduleContractAuthoring(32);
    expect(b.kind).toBe("claimed");
    expect(h.starts).toHaveLength(1); // only A was promoted
    if (a.kind !== "claimed" || b.kind !== "claimed") return;

    // bind A to a real session/execution
    const bind = h.store.bindExecution(a.context, "sess_31", "exec_31");
    expect(bind.ok).toBe(true);
    const boundContext = { ...a.context, sessionId: "sess_31", executionId: "exec_31" };

    // the turn's durable work advanced the project's supervision generation
    h.store.db.prepare("UPDATE project_supervision SET generation = 2 WHERE project_card_id = 31").run();

    // terminal release happens AFTER the advance — the normal turn ordering
    const released = h.coordinator.releaseOwnedRun(boundContext, "completed");
    expect(released).toBe(true);

    // the run row is durable-terminal with the caller's outcome preserved
    const row = h.store.getRun(a.context.runId);
    expect(row?.state).toBe("released");
    expect(row?.outcome).toBe("completed");
    expect(row?.released_at).not.toBeNull();
    expect(row?.project_generation).toBe(1);

    // durable terminal precedes the ownership event; exactly one event fires
    expect(observedAtEvent).toEqual(["released"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("completed");

    // B acquires the global slot once A's row no longer holds it
    expect(h.store.getRun(b.context.runId)?.state).toBe("scheduled");
    h.store.promoteRun(b.context.runId);
    expect(h.store.getRun(b.context.runId)?.state).toBe("dispatching");
  });

  it("still rejects foreign owner, session, and execution contexts after the advance", () => {
    const h = makeHarness();
    seedProject(h.store, 33);
    const events: import("./orc-project-contracts.js").OrcOwnershipReleasedV1[] = [];
    h.coordinator.onOwnershipReleased((e) => events.push(e));

    const a = h.coordinator.scheduleContractAuthoring(33);
    expect(a.kind).toBe("claimed");
    if (a.kind !== "claimed") return;
    const bind = h.store.bindExecution(a.context, "sess_33", "exec_33");
    expect(bind.ok).toBe(true);

    // the project's supervision generation advances past the run's
    h.store.db.prepare("UPDATE project_supervision SET generation = 2 WHERE project_card_id = 33").run();

    // every identity/ownership fence must still reject a mismatched context
    expect(h.coordinator.releaseOwnedRun({ ...a.context, ownerInstanceId: "inst_2" }, "completed")).toBe(false);
    expect(h.coordinator.releaseOwnedRun({ ...a.context, sessionId: "sess_33", executionId: "exec_OTHER" }, "completed")).toBe(false);
    expect(h.coordinator.releaseOwnedRun({ ...a.context, sessionId: "sess_OTHER", executionId: "exec_33" }, "completed")).toBe(false);
    expect(h.coordinator.releaseOwnedRun({ ...a.context, ownershipGeneration: a.context.ownershipGeneration + 1 }, "completed")).toBe(false);
    expect(h.coordinator.releaseOwnedRun({ ...a.context, projectGeneration: 2 }, "completed")).toBe(false);

    expect(h.store.getRun(a.context.runId)?.state).toBe("running");
    expect(events).toHaveLength(0);

    // the correct bound context still releases after the advance
    expect(h.coordinator.releaseOwnedRun({ ...a.context, sessionId: "sess_33", executionId: "exec_33" }, "completed")).toBe(true);
    expect(h.store.getRun(a.context.runId)?.state).toBe("released");
    expect(events).toHaveLength(1);
  });
});

// ── #1675: a run is only promoted by the caller that starts it ────────────────

describe("#1675 a run is only promoted by the caller that starts it", () => {
  it("never promotes another project's queued run with the claiming project's goal", () => {
    const h = makeHarness();
    seedProject(h.store, 40); // holds the global slot
    seedProject(h.store, 41); // queued behind the slot
    seedProject(h.store, 42, "executing"); // fresh claimant

    const slot = h.coordinator.scheduleContractAuthoring(40);
    expect(slot.kind).toBe("claimed");
    if (slot.kind !== "claimed") return;
    const queued = h.coordinator.scheduleContractAuthoring(41);
    expect(queued.kind).toBe("claimed");
    expect(h.starts).toHaveLength(1); // only the slot holder started

    // Free the slot through the production ownership path so a subsequent
    // claim could (wrongly) promote the queued run of another project.
    const bind = h.store.bindExecution(slot.context, "sess_40", "exec_40");
    expect(bind.ok).toBe(true);
    expect(h.coordinator.releaseOwnedRun({ ...slot.context, sessionId: "sess_40", executionId: "exec_40" }, "completed")).toBe(true);
    expect(h.store.getRun(queued.kind === "claimed" ? queued.context.runId : "")?.state).toBe("scheduled");

    const goal42 = "DEFINE-42-MARKER-GOAL";
    const claim42 = h.coordinator.scheduleProjectExecution(42, goal42);
    expect(claim42.kind).toBe("claimed");

    // #1675: a fresh claim on 42 must promote 42's own run — never 41's
    // queued run — and never bind 42's goal to 41's context.
    const wrongPairing = h.starts.find((s) => s.spec.context.projectCardId === 41 && s.spec.goal === goal42);
    expect(wrongPairing).toBeUndefined();
  });

  it("starts the run created for the first claimant's goal with its persisted goal, never a later caller's goal", () => {
    const h = makeHarness();
    seedProject(h.store, 40); // holds the global slot
    seedProject(h.store, 51, "executing");

    const slot = h.coordinator.scheduleContractAuthoring(40);
    expect(slot.kind).toBe("claimed");
    if (slot.kind !== "claimed") return;

    // G1 claims project 51 first — the run is created for G1 but stays queued.
    const g1 = h.coordinator.scheduleProjectExecution(51, "G1-OWNER-GOAL");
    expect(g1.kind).toBe("claimed");
    if (g1.kind !== "claimed") return;
    const g1RunId = g1.context.runId;
    expect(h.starts.some((s) => s.spec.context.runId === g1RunId)).toBe(false);

    // A later project_execution wake with a different goal G2 — same intent
    // key — is idempotent against G1's run.
    const g2 = h.coordinator.scheduleProjectExecution(51, "G2-LATER-GOAL");
    expect(g2.kind).toBe("idempotent");
    expect(h.starts.some((s) => s.spec.context.runId === g1RunId)).toBe(false);

    // Free the global slot through the production ownership path.
    const bind = h.store.bindExecution(slot.context, "sess_40", "exec_40");
    expect(bind.ok).toBe(true);
    expect(h.coordinator.releaseOwnedRun({ ...slot.context, sessionId: "sess_40", executionId: "exec_40" }, "completed")).toBe(true);
    expect(h.store.getRun(g1RunId)?.state).toBe("scheduled");

    // The project's own wake re-enters scheduleX; the idempotent claim promotes
    // the queued run — with the persisted first-claimant goal, never G2.
    const wake = h.coordinator.scheduleProjectExecution(51, "G2-LATER-GOAL");
    expect(wake.kind).toBe("idempotent");

    const started = h.starts.find((s) => s.spec.context.runId === g1RunId);
    expect(started).toBeDefined();
    expect(started!.spec.goal).toBe("G1-OWNER-GOAL");
  });

  it("a freed slot reaches a queued run through the production wake path", () => {
    const h = makeHarness();
    seedProject(h.store, 60);
    seedProject(h.store, 61, "executing");

    const a = h.coordinator.scheduleContractAuthoring(60);
    expect(a.kind).toBe("claimed");
    if (a.kind !== "claimed") return;

    const goal61 = "QUEUED-61-GOAL";
    const b = h.coordinator.scheduleProjectExecution(61, goal61);
    expect(b.kind).toBe("claimed");
    if (b.kind !== "claimed") return;
    expect(h.starts).toHaveLength(1);
    expect(h.store.getRun(b.context.runId)?.state).toBe("scheduled");

    // Bind + release the live run through the coordinator (ownership event).
    const bind = h.store.bindExecution(a.context, "sess_60", "exec_60");
    expect(bind.ok).toBe(true);
    expect(h.coordinator.releaseOwnedRun({ ...a.context, sessionId: "sess_60", executionId: "exec_60" }, "completed")).toBe(true);
    expect(h.store.getRun(b.context.runId)?.state).toBe("scheduled");

    // The queued project's own wake re-enters its scheduleX (the reconciler's
    // requestReconcileForProject path) — the idempotent claim promotes it.
    // No test-only store.pump() is called anywhere in this scenario.
    const wake = h.coordinator.scheduleProjectExecution(61, goal61);
    expect(wake.kind).toBe("idempotent");

    expect(h.store.getRun(b.context.runId)?.state).toBe("dispatching");
    const started = h.starts.find((s) => s.spec.context.runId === b.context.runId);
    expect(started).toBeDefined();
    expect(started!.spec.goal).toBe(goal61);
  });

  it("an idempotent re-claim never starts a live run twice", () => {
    const h = makeHarness();
    seedProject(h.store, 70);

    const first = h.coordinator.scheduleContractAuthoring(70);
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    expect(h.starts.filter((s) => s.spec.context.runId === first.context.runId)).toHaveLength(1);

    const bind = h.store.bindExecution(first.context, "sess_70", "exec_70");
    expect(bind.ok).toBe(true);

    const again = h.coordinator.scheduleContractAuthoring(70);
    expect(again.kind).toBe("idempotent");

    expect(h.starts.filter((s) => s.spec.context.runId === first.context.runId)).toHaveLength(1);
    expect(h.store.getRun(first.context.runId)?.state).toBe("running");
  });

  it("boot recovery never leaves a dispatching run without a starter (#1675)", () => {
    const h = makeHarness();
    seedProject(h.store, 80);

    const claim = h.coordinator.scheduleContractAuthoring(80);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    // Simulate a boot that interrupts the turn before it binds: the run is
    // dispatching with no session/execution (the harness startPort never binds).
    expect(h.store.getRun(claim.context.runId)?.state).toBe("dispatching");
    expect(h.store.getRun(claim.context.runId)?.session_id).toBeNull();

    const affected = h.coordinator.bootRecovery();
    expect(affected).toEqual([80]);

    // The impossible run was superseded; boot recovery promoted nothing, so
    // the global slot is free rather than held by an unstarted run.
    expect(h.store.getRun(claim.context.runId)?.state).toBe("superseded");
    expect(h.store.getLiveRuns()).toHaveLength(0);
    expect(h.starts).toHaveLength(1); // the mock start is recorded, nothing re-started
  });
});

describe("#1680 durable bounded run diagnostics (failure_code)", () => {
  it("a start-port rejection persists the stable start_port_rejected code through the funnel", async () => {
    const h = makeHarness();
    seedProject(h.store, 90);
    // The start port throws synchronously → the coordinator's catch releases
    // the promoted run failed with start_port_rejected and publishes the
    // ownership-released event.
    const releases: Array<{ runId: string; outcome: string; failureCode: string | null }> = [];
    const coordinator = new CoordinatorType({
      ownerPeer: "kp",
      ownerInstanceId: "inst_1",
      getRootIdentity: () => ({ source: "agent", sourcePeer: null }),
      startPort: async () => { throw new Error("port unavailable"); },
    });
    ensureSupervisionTable(coordinator.getStore() as any);
    coordinator.getStore().db.prepare(`
      INSERT OR IGNORE INTO project_supervision (project_card_id, contract_id, state, generation, updated_at)
      VALUES (90, '', 'executing', 1, ?)
    `).run(new Date().toISOString());
    coordinator.onOwnershipReleased((event) => releases.push({ runId: event.runId, outcome: event.outcome, failureCode: null }));

    const claim = coordinator.scheduleContractAuthoring(90);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    await new Promise((r) => setTimeout(r, 50));

    const row = coordinator.getStore().getRun(claim.context.runId);
    expect(row?.state).toBe("released");
    expect(row?.outcome).toBe("failed");
    expect(row?.failure_code).toBe("start_port_rejected");
    expect(row?.started_at).toBeNull();
    expect(releases).toHaveLength(1);
    expect(releases[0]!.outcome).toBe("failed");
  });

  it("the release CAS writes the bounded failure code and success always writes NULL", () => {
    const h = makeHarness();
    seedProject(h.store, 91);
    const claim = h.coordinator.scheduleContractAuthoring(91);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    const failed = h.store.release({ ...claim.context, sessionId: "s_1", executionId: "e_1" }, "failed", "provider_failure");
    expect(failed).toBe(true);
    expect(h.store.getRun(claim.context.runId)?.failure_code).toBe("provider_failure");
    // The production diagnostic is the read of a real written value.
    expect(h.store.lastAuthoringFailureCode(91, 1)).toBe("provider_failure");

    const claim2 = h.coordinator.scheduleContractAuthoring(91);
    expect(claim2.kind).toBe("claimed");
    if (claim2.kind !== "claimed") return;
    const completed = h.store.release({ ...claim2.context, sessionId: "s_2", executionId: "e_2" }, "completed");
    expect(completed).toBe(true);
    const row = h.store.getRun(claim2.context.runId);
    expect(row?.outcome).toBe("completed");
    expect(row?.failure_code).toBeNull();
  });

  it("a failed release without a stated reason defaults to provider_failure", () => {
    const h = makeHarness();
    seedProject(h.store, 92);
    const claim = h.coordinator.scheduleContractAuthoring(92);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(h.store.release({ ...claim.context, sessionId: "s_3", executionId: "e_3" }, "failed")).toBe(true);
    expect(h.store.getRun(claim.context.runId)?.failure_code).toBe("provider_failure");
  });
});

describe("#1728 review retry escalation", () => {
  it("scales the start-spec bound with the stored dispatch attempts on a fresh claim", () => {
    const expectations: Array<[number, number]> = [[0, 6], [1, 8], [2, 10], [4, 10]];
    let cardId = 20;
    for (const [attempts, expectedBound] of expectations) {
      const h = makeHarness();
      cardId += 1;
      seedProject(h.store, cardId);
      seedReviewCase(h.store, cardId);
      const claim = h.coordinator.scheduleReview(cardId, 1, `rc_${cardId}`, attempts);
      expect(claim.kind).toBe("claimed");
      expect(h.starts).toHaveLength(1);
      expect(h.starts[0]!.spec.maxPromptRounds).toBe(expectedBound);
    }
  });

  it("an idempotent promotion of a queued counted run retains its original bound", () => {
    const h = makeHarness();
    seedProject(h.store, 30);
    seedReviewCase(h.store, 30);
    const first = h.coordinator.scheduleReview(30, 1, "rc_30", 0);
    expect(first.kind).toBe("claimed");
    expect(h.starts[0]!.spec.maxPromptRounds).toBe(6);
    // Crash-before-start recovery shape: the claimed run is back in
    // 'scheduled' (queued) and its dispatch attempt is already counted.
    h.store.db.prepare(`UPDATE orc_project_runs SET state = 'scheduled' WHERE project_card_id = 30`).run();
    const second = h.coordinator.scheduleReview(30, 1, "rc_30", 1);
    expect(second.kind).toBe("idempotent");
    expect(h.starts).toHaveLength(2);
    expect(h.starts[1]!.spec.maxPromptRounds).toBe(6);
  });

  it("non-review intents ignore the dispatch ordinal entirely", () => {
    const h = makeHarness();
    seedProject(h.store, 40, "executing");
    const claim = h.coordinator.scheduleProjectExecution(40, "goal");
    expect(claim.kind).toBe("claimed");
    expect(h.starts[0]!.spec.maxPromptRounds).toBe(25);
  });
});
