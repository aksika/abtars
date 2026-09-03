/**
 * orc-cleanup.test.ts — #1707 Task 6: bounded-batch cleanup of orphaned
 * orc_project_runs rows. Proves live rows and active-project history are
 * never touched, deletion is bounded per batch, and a large orphaned backlog
 * (the 2.77M-row incident shape) drains deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let runStoreMod: typeof import("./orc-project-run-store.js");
let kanban: typeof import("../tasks/kanban-board.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "orc-cleanup-"));
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("../tasks/kanban-board.js");
  runStoreMod = await import("./orc-project-run-store.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/** Create a card + supervision row in a given state through the real stores. Returns the real card id. */
function seedProject(state: "executing" | "blocked"): number {
  const id = Number(kanban.kanbanEnqueue(`P${Math.random()}`, "task", `r-${Math.random()}`, { type: "O" }));
  const rs = new reviewStoreMod.ProjectReviewStore();
  rs.insertContract({
    schema_version: 1, id: `ct_${id}`, digest: `dg_${id}`, project_card_id: id, goal: "w",
    criteria: [{ id: "c1", description: "d", required: true, evidence_expectation: "synthesis" }],
    required_outputs: [], constraints: [], limits: { max_review_rounds: 1, max_repair_rounds: 1 },
    provenance: { requested_by: "t", authored_by: "orc", created_at: new Date().toISOString() },
  });
  rs.initializeSupervision(id, `ct_${id}`, state);
  return id;
}

/** Insert synthetic terminal run rows directly (fast, no claim semantics). */
function insertTerminalRuns(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number, count: number, offset = 0): void {
  const now = new Date().toISOString();
  store.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      store.db.prepare(`
        INSERT INTO orc_project_runs
          (id, intent_key, intent_kind, goal, project_card_id, project_generation,
           ownership_generation, owner_peer, owner_instance_id, origin_kind,
           state, outcome, created_at, updated_at)
        VALUES (?, ?, 'project_execution', 'g', ?, 1, ?, 'p', 'inst', 'local',
                'released', 'failed', ?, ?)
      `).run(`or_${cardId}_${i + offset}_synthetic`, `synthetic:${cardId}:${i + offset}`, cardId, i + offset + 1, now, now);
    }
  });
}

describe("#1707 orphaned run cleanup", () => {
  it("deletes only eligible rows in bounded batches — live rows and active projects untouched", () => {
    const store = new runStoreMod.OrcProjectRunStore();

    // Missing project: fully eligible.
    const MISSING = 9_001;
    // Settled supervision: eligible.
    const SETTLED = seedProject("blocked");
    // Live project with history: NOT eligible. Claim FIRST (empty history,
    // so no fuse interference), then backfill terminal history rows far past
    // the live claim's ownership generation (no unique collisions).
    const ACTIVE = seedProject("executing");
    store.claimIntent({
      projectCardId: ACTIVE, intentKind: "operator_turn", intentRef: "live", goal: "g",
      originKind: "local", cardSource: "task", sourcePeer: null,
    }, "p", "inst");

    insertTerminalRuns(store, MISSING, 50);
    insertTerminalRuns(store, SETTLED, 50);
    insertTerminalRuns(store, ACTIVE, 30, 1000);

    const result = store.cleanupOrphanedRuns({ batchSize: 25 });
    expect(result.batches).toBeGreaterThan(1); // bounded batches, not one sweep
    expect(result.deleted).toBe(100);
    expect(result.selected).toBe(result.deleted);

    // Active project's terminal history survives (diagnostics intact).
    expect(store.getRunsForProject(ACTIVE)).toHaveLength(31);
    // Live row untouched:
    expect(store.getLiveRunForProject(ACTIVE)).toBeTruthy();
    // Eligible projects fully drained:
    expect(store.getRunsForProject(MISSING)).toHaveLength(0);
    expect(store.getRunsForProject(SETTLED)).toHaveLength(0);

    // Idempotent: second pass selects nothing.
    expect(store.cleanupOrphanedRuns().deleted).toBe(0);
  });

  it("drains a multi-thousand-row orphaned backlog within the batch budget", () => {
    new reviewStoreMod.ProjectReviewStore(); // materialize supervision schema (always present in production)
    const store = new runStoreMod.OrcProjectRunStore();
    insertTerminalRuns(store, 201, 2_500);

    const result = store.cleanupOrphanedRuns({ batchSize: 200 });
    expect(result.deleted).toBe(2_500);
    expect(result.batches).toBe(Math.ceil(2_500 / 200));
    expect(store.getRunsForProject(201)).toHaveLength(0);
  });

  it("maxBatches caps each invocation — repeated calls finish the job", () => {
    new reviewStoreMod.ProjectReviewStore();
    const store = new runStoreMod.OrcProjectRunStore();
    insertTerminalRuns(store, 301, 500);

    const first = store.cleanupOrphanedRuns({ batchSize: 100, maxBatches: 2 });
    expect(first.deleted).toBe(200);
    expect(first.batches).toBe(2);
    const second = store.cleanupOrphanedRuns({ batchSize: 100, maxBatches: 10 });
    expect(second.deleted).toBe(300);
  });

  it("leaves the database integral after large deletions", () => {
    new reviewStoreMod.ProjectReviewStore();
    const store = new runStoreMod.OrcProjectRunStore();
    insertTerminalRuns(store, 401, 1_000);
    store.cleanupOrphanedRuns({ batchSize: 128 });
    const integrity = store.db.prepare(`PRAGMA quick_check`).get() as Record<string, unknown>;
    expect(Object.values(integrity)[0]).toBe("ok");
    store.checkpointWalPassive();
  });
});
