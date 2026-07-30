import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let OrcProjectRunStoreType: typeof import("./orc-project-run-store.js").OrcProjectRunStore;

function cleanHome(dir: string): void {
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `orc-run-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const mod = await import("./orc-project-run-store.js");
  OrcProjectRunStoreType = mod.OrcProjectRunStore;
});

afterAll(() => {
  cleanHome(TEST_HOME);
});

const makeInput = (overrides?: Record<string, unknown>) => ({
  projectCardId: 1,
  intentKind: "contract_authoring",
  originKind: "local",
  sourcePeer: null,
  cardSource: "agent",
  ...overrides,
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

describe("OrcProjectRunStore", () => {
  let store: import("./orc-project-run-store.js").OrcProjectRunStore;

  beforeEach(() => {
    store = new OrcProjectRunStoreType();
    ensureSupervisionTable(store);
    store.db.exec(`DELETE FROM orc_project_runs`);
    store.db.exec(`DELETE FROM orc_project_ownership_counters`);
    store.db.exec(`DELETE FROM project_supervision`);
  });

  it("claims a new intent and returns context", () => {
    seedProject(store, 1);
    const result = store.claimIntent(makeInput({ projectCardId: 1 }), "local_peer", "inst_1");
    expect(result.kind).toBe("claimed");
    if (result.kind === "claimed") {
      expect(result.context.projectCardId).toBe(1);
      expect(result.context.ownershipGeneration).toBe(1);
      expect(result.context.origin.kind).toBe("local");
    }
  });

  it("returns idempotent for same intent on same instance", () => {
    seedProject(store, 1);
    store.claimIntent(makeInput({ projectCardId: 1 }), "local_peer", "inst_1");
    const result = store.claimIntent(makeInput({ projectCardId: 1 }), "local_peer", "inst_1");
    expect(result.kind).toBe("idempotent");
  });

  it("returns busy for a different intent on same project", () => {
    seedProject(store, 2);
    store.claimIntent(makeInput({ projectCardId: 2, intentKind: "contract_authoring" }), "local_peer", "inst_1");
    const result = store.claimIntent(makeInput({ projectCardId: 2, intentKind: "project_review" }), "local_peer", "inst_1");
    expect(result.kind).toBe("busy");
  });

  it("pumps oldest eligible scheduled run", () => {
    seedProject(store, 3);
    seedProject(store, 4);
    store.claimIntent(makeInput({ projectCardId: 3 }), "local_peer", "inst_1");
    store.claimIntent(makeInput({ projectCardId: 4 }), "local_peer", "inst_1");

    const promoted = store.pump();
    expect(promoted).not.toBeNull();

    const run = store.getRun(promoted!);
    expect(run).toBeDefined();
    expect(run!.state).toBe("dispatching");
  });

  it("binds execution and transitions to running", () => {
    seedProject(store, 5);
    const claim = store.claimIntent(makeInput({ projectCardId: 5 }), "local_peer", "inst_1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    store.pump();

    const bindResult = store.bindExecution(claim.context.runId, claim.context.ownershipGeneration, "sess_1", "exec_1");
    expect(bindResult.ok).toBe(true);

    const run = store.getRun(claim.context.runId);
    expect(run).toBeDefined();
    expect(run!.state).toBe("running");
    expect(run!.session_id).toBe("sess_1");
    expect(run!.execution_id).toBe("exec_1");
  });

  it("releases run and transitions to released", () => {
    seedProject(store, 6);
    const claim = store.claimIntent(makeInput({ projectCardId: 6 }), "local_peer", "inst_1");
    if (claim.kind !== "claimed") return;
    const released = store.release(claim.context.runId, claim.context.ownershipGeneration, "completed");
    expect(released).toBe(true);

    const run = store.getRun(claim.context.runId);
    expect(run!.state).toBe("released");
    expect(run!.outcome).toBe("completed");
  });

  it("stale context validation fails after release", () => {
    seedProject(store, 7);
    const claim = store.claimIntent(makeInput({ projectCardId: 7 }), "local_peer", "inst_1");
    if (claim.kind !== "claimed") return;
    store.release(claim.context.runId, claim.context.ownershipGeneration, "completed");

    const validation = store.validateCurrentContext(claim.context);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.reason).toBe("run_released");
  });

  it("supersedes a live run", () => {
    seedProject(store, 8);
    const claim = store.claimIntent(makeInput({ projectCardId: 8 }), "local_peer", "inst_1");
    if (claim.kind !== "claimed") return;
    const superseded = store.supersede(claim.context.runId, "stale");
    expect(superseded).toBe(true);

    const run = store.getRun(claim.context.runId);
    expect(run!.state).toBe("superseded");
    expect(run!.outcome).toBe("stale");
  });

  it("two projects can each have a scheduled run", () => {
    seedProject(store, 9);
    seedProject(store, 10);
    const a = store.claimIntent(makeInput({ projectCardId: 9 }), "local_peer", "inst_1");
    const b = store.claimIntent(makeInput({ projectCardId: 10 }), "local_peer", "inst_1");
    expect(a.kind).toBe("claimed");
    expect(b.kind).toBe("claimed");

    const runs = store.getLiveRuns();
    expect(runs.length).toBe(2);
  });

  it("different instance gets busy for same project", () => {
    seedProject(store, 11);
    store.claimIntent(makeInput({ projectCardId: 11 }), "local_peer", "inst_a");
    const claimB = store.claimIntent(makeInput({ projectCardId: 11 }), "local_peer", "inst_b");
    expect(claimB.kind).toBe("busy");
  });
});
