import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { OrcInvocationContextV1 } from "./orc-project-contracts.js";
import { authorizePeerEgress } from "./orc-project-context.js";

let TEST_HOME: string;
let CoordinatorType: typeof import("./orc-project-coordinator.js").OrcProjectCoordinator;

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
  `);
}

function seedProject(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number, state = "executing"): void {
  store.db.prepare(`
    INSERT OR IGNORE INTO project_supervision (project_card_id, contract_id, state, generation, updated_at)
    VALUES (?, '', ?, 1, ?)
  `).run(cardId, state, new Date().toISOString());
}

interface Harness {
  coordinator: InstanceType<typeof CoordinatorType>;
  store: import("./orc-project-run-store.js").OrcProjectRunStore;
  starts: Array<{ context: OrcInvocationContextV1; goal: string }>;
  setRootIdentity: (id: { source: string; sourcePeer: string | null }) => void;
}

function makeHarness(): Harness {
  const starts: Array<{ context: OrcInvocationContextV1; goal: string }> = [];
  let rootIdentity = { source: "agent", sourcePeer: null };
  const coordinator = new CoordinatorType({
    ownerPeer: "kp",
    ownerInstanceId: "inst_1",
    getRootIdentity: () => rootIdentity,
    startPort: async (context: OrcInvocationContextV1, goal: string) => { starts.push({ context, goal }); },
  });
  ensureSupervisionTable(coordinator.getStore() as any);
  coordinator.getStore().db.exec(`DELETE FROM orc_project_runs`);
  coordinator.getStore().db.exec(`DELETE FROM orc_project_ownership_counters`);
  coordinator.getStore().db.exec(`DELETE FROM project_supervision`);
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
    expect(h.starts[0]!.context.origin.kind).toBe("peer");
    expect(h.starts[0]!.context.origin.peer).toBe("molty");
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
    seedProject(h.store, 2);
    seedProject(h.store, 3);
    seedProject(h.store, 4);
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
      { projectCardId: 9, intentKind: "contract_authoring", originKind: "local", cardSource: "agent", sourcePeer: null },
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
