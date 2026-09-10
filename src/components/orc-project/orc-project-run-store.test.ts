import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
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

const makeInput = (overrides?: Partial<import("./orc-project-contracts.js").OrcClaimInput>): import("./orc-project-contracts.js").OrcClaimInput => ({
  projectCardId: 1,
  intentKind: "operator_turn",
  goal: "Define acceptance contract for project #1",
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

function seedProject(store: import("./orc-project-run-store.js").OrcProjectRunStore, cardId: number, state = "awaiting_contract"): void {
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
    // #1792: operator intent keys embed wall time (each operator turn is a
    // distinct intent), so pin the clock to exercise the same-key path.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1789044000000);
    store.claimIntent(makeInput({ projectCardId: 1 }), "local_peer", "inst_1");
    const result = store.claimIntent(makeInput({ projectCardId: 1 }), "local_peer", "inst_1");
    nowSpy.mockRestore();
    expect(result.kind).toBe("idempotent");
  });

  it("returns busy for a different intent on same project", () => {
    seedProject(store, 2);
    store.claimIntent(makeInput({ projectCardId: 2, intentKind: "operator_turn", intentRef: "busy-a" }), "local_peer", "inst_1");
    const result = store.claimIntent(makeInput({ projectCardId: 2, intentKind: "operator_turn", intentRef: "busy-b" }), "local_peer", "inst_1");
    expect(result.kind).toBe("busy");
  });

  it("persists the first claimant's goal and never overwrites it (#1675)", () => {
    seedProject(store, 41);
    // #1792: see above — pin the clock so both operator claims share one key.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1789044000000);
    const claim = store.claimIntent(makeInput({ projectCardId: 41, goal: "G1-OWNER" }), "local_peer", "inst_1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(store.getRun(claim.context.runId)?.goal).toBe("G1-OWNER");

    // the fresh schema reports goal as NOT NULL
    const cols = store.db.prepare(`PRAGMA table_info(orc_project_runs)`).all() as Array<{ name: string; notnull: number }>;
    const goalCol = cols.find((c) => c.name === "goal");
    expect(goalCol?.notnull).toBe(1);

    // an idempotent re-claim with a different goal leaves the stored goal unchanged
    const again = store.claimIntent(makeInput({ projectCardId: 41, goal: "G2-LATE" }), "local_peer", "inst_1");
    nowSpy.mockRestore();
    expect(again.kind).toBe("idempotent");
    expect(store.getRun(claim.context.runId)?.goal).toBe("G1-OWNER");
  });

  it("promoteRun promotes exactly the given scheduled run once the slot is free (#1675)", () => {
    seedProject(store, 3);
    seedProject(store, 4);
    const claim3 = store.claimIntent(makeInput({ projectCardId: 3 }), "local_peer", "inst_1");
    const claim4 = store.claimIntent(makeInput({ projectCardId: 4 }), "local_peer", "inst_1");
    if (claim3.kind !== "claimed" || claim4.kind !== "claimed") return;

    // scoped promotion of the target run only
    expect(store.promoteRun(claim3.context.runId)).toBe(true);
    expect(store.getRun(claim3.context.runId)?.state).toBe("dispatching");

    // a non-scheduled row, a missing row, or a row behind a taken slot is never promoted
    expect(store.promoteRun(claim3.context.runId)).toBe(false); // already dispatching
    expect(store.promoteRun(claim4.context.runId)).toBe(false); // global slot taken
    expect(store.promoteRun("or_missing")).toBe(false);
    expect(store.getRun(claim4.context.runId)?.state).toBe("scheduled");
  });

  it("never dispatches a second run while a global turn is in flight (#1664/#1675)", () => {
    seedProject(store, 30);
    seedProject(store, 31);
    const claim30 = store.claimIntent(makeInput({ projectCardId: 30 }), "local_peer", "inst_1");
    const claim31 = store.claimIntent(makeInput({ projectCardId: 31 }), "local_peer", "inst_1");
    expect(claim30.kind).toBe("claimed");
    expect(claim31.kind).toBe("claimed");
    if (claim30.kind !== "claimed" || claim31.kind !== "claimed") return;

    const first = store.promoteRun(claim30.context.runId);
    expect(first).toBe(true);
    // A concurrent promotion (another reconciler wake) must not violate the
    // global single-turn UNIQUE index — it leaves the second run scheduled.
    expect(store.promoteRun(claim31.context.runId)).toBe(false);
    const secondRun = store.getLiveRunForProject(31);
    expect(secondRun?.state).toBe("scheduled");

    // Once the in-flight turn binds and releases, the next promotion succeeds.
    expect(store.bindExecution(claim30.context, "sess_30", "exec_30").ok).toBe(true);
    expect(store.promoteRun(claim31.context.runId)).toBe(false); // still running
    expect(store.release({ ...claim30.context, sessionId: "sess_30", executionId: "exec_30" }, "completed")).toBe(true);
    expect(store.promoteRun(claim31.context.runId)).toBe(true);
    expect(store.getRun(claim31.context.runId)?.state).toBe("dispatching");
  });

  it("binds execution and transitions to running", () => {
    seedProject(store, 5);
    const claim = store.claimIntent(makeInput({ projectCardId: 5 }), "local_peer", "inst_1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    store.promoteRun(claim.context.runId);

    const bindResult = store.bindExecution(claim.context, "sess_1", "exec_1");
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
    const released = store.release(claim.context, "completed");
    expect(released).toBe(true);

    const run = store.getRun(claim.context.runId);
    expect(run!.state).toBe("released");
    expect(run!.outcome).toBe("completed");
  });

  it("stale context validation fails after release", () => {
    seedProject(store, 7);
    const claim = store.claimIntent(makeInput({ projectCardId: 7 }), "local_peer", "inst_1");
    if (claim.kind !== "claimed") return;
    store.release(claim.context, "completed");

    const validation = store.validateCurrentContext(claim.context);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.reason).toBe("run_released");
  });

  it("rejects intent and origin substitution on a live context", () => {
    seedProject(store, 71);
    const claim = store.claimIntent(makeInput({ projectCardId: 71 }), "local_peer", "inst_1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    const forgedIntent = store.validateCurrentContext({
      ...claim.context,
      intentKind: "project_execution",
    });
    expect(forgedIntent).toEqual({ ok: false, reason: "intent_mismatch" });

    const forgedOrigin = store.validateCurrentContext({
      ...claim.context,
      origin: { kind: "peer", peer: "molty" },
    });
    expect(forgedOrigin).toEqual({ ok: false, reason: "origin_invalid" });

    expect(store.release({ ...claim.context, intentKind: "project_execution" }, "completed")).toBe(false);
    expect(store.getRun(claim.context.runId)?.state).toBe("scheduled");
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

  it("rejects peer origin without authenticated source provenance", () => {
    seedProject(store, 12);
    const result = store.claimIntent(makeInput({ projectCardId: 12, originKind: "peer", cardSource: "peer" }), "local_peer", "inst_1");
    expect(result).toEqual({ kind: "conflict", reason: "origin_invalid" });
  });

  it("fences binding to the owning instance and current generation, and permits the owner's terminal cleanup after the generation advances", () => {
    // ── binding is fenced on the owning instance ──
    seedProject(store, 13);
    const claim = store.claimIntent(makeInput({ projectCardId: 13 }), "local_peer", "inst_1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    store.promoteRun(claim.context.runId);

    const foreign = store.bindExecution({ ...claim.context, ownerInstanceId: "inst_2" }, "sess_1", "exec_1");
    expect(foreign).toEqual({ ok: false, reason: "foreign_instance" });

    // ── binding is fenced on the current supervision generation (#1673) ──
    seedProject(store, 14);
    const stale = store.claimIntent(makeInput({ projectCardId: 14 }), "local_peer", "inst_1");
    expect(stale.kind).toBe("claimed");
    if (stale.kind !== "claimed") return;
    store.db.prepare("UPDATE project_supervision SET generation = 2 WHERE project_card_id = 14").run();
    const staleBind = store.bindExecution(stale.context, "sess_14", "exec_14");
    expect(staleBind).toEqual({ ok: false, reason: "project_generation_mismatch" });

    // ── terminal cleanup is permitted after the owner's generation advanced ──
    const bound = store.bindExecution(claim.context, "sess_1", "exec_1");
    expect(bound.ok).toBe(true);
    store.db.prepare("UPDATE project_supervision SET generation = 2 WHERE project_card_id = 13").run();
    expect(store.release({ ...claim.context, sessionId: "sess_1", executionId: "exec_1" }, "completed")).toBe(true);
    expect(store.getRun(claim.context.runId)?.state).toBe("released");
    expect(store.getRun(claim.context.runId)?.outcome).toBe("completed");
  });

  it("withCurrentRun invokes the callback on a valid current context and blocks stale-generation work (#1679)", () => {
    seedProject(store, 42);
    const claim = store.claimIntent(makeInput({ projectCardId: 42 }), "local_peer", "inst_1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    let invoked = 0;
    const result = store.withCurrentRun(claim.context, (row) => {
      invoked += 1;
      return `goal=${row.goal}`;
    });
    expect(result).toEqual({ ok: true, value: "goal=Define acceptance contract for project #1" });
    expect(invoked).toBe(1);

    // after the supervision generation advances, the callback must never run
    store.db.prepare("UPDATE project_supervision SET generation = 2 WHERE project_card_id = 42").run();
    let invokedStale = 0;
    const stale = store.withCurrentRun(claim.context, () => {
      invokedStale += 1;
      return "MUTATION";
    });
    expect(stale).toEqual({ ok: false, reason: "project_generation_mismatch" });
    expect(invokedStale).toBe(0);
  });
});

// ── #1628: authoring attempt counts ───────────────────────────────────────────

describe("OrcProjectRunStore authoring counts (#1628)", () => {
  function seedAuthoringRun(store: InstanceType<typeof OrcProjectRunStoreType>, cardId: number, generation: number, opts: { started?: boolean; state?: string; createdAt?: string; intent?: string; outcome?: string; ownershipGeneration?: number } = {}): string {
    const now = new Date().toISOString();
    const runId = `or_count_${cardId}_${Math.random().toString(36).slice(2, 10)}`;
    const ownershipGeneration = opts.ownershipGeneration ?? Math.floor(Math.random() * 1_000_000) + 1;
    store.db.prepare(`
      INSERT INTO orc_project_runs
        (id, intent_key, intent_kind, intent_ref, goal, project_card_id,
         project_generation, ownership_generation, owner_peer, owner_instance_id,
         origin_kind, origin_peer, state, outcome, failure_code, created_at, started_at, released_at, updated_at)
      VALUES (?, ?, 'contract_authoring', NULL, 'seeded goal', ?, ?, ?, 'kp', 'inst', 'local', NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      `contract:${cardId}:${generation}`,
      cardId, generation, ownershipGeneration,
      opts.state ?? "released",
      opts.outcome ?? "failed",
      null,
      opts.createdAt ?? now,
      opts.started ? now : null,
      opts.started ? now : null,
      now,
    );
    return runId;
  }

  it("counts only started authoring turns for the given generation", () => {
    const store = new OrcProjectRunStoreType();
    ensureSupervisionTable(store);
    seedProject(store, 21);
    seedAuthoringRun(store, 21, 1, { started: true });   // counts
    seedAuthoringRun(store, 21, 1, { started: true });   // counts
    seedAuthoringRun(store, 21, 1, { started: false });  // pre-start, does not
    seedAuthoringRun(store, 21, 2, { started: true });   // other generation
    expect(store.countStartedAuthoringTurns(21, 1)).toBe(2);
    expect(store.countStartedAuthoringTurns(21, 2)).toBe(1);
  });

  it("counts consecutive unstartable turns and resets after a started turn", () => {
    const store = new OrcProjectRunStoreType();
    ensureSupervisionTable(store);
    seedProject(store, 22);
    // two pre-start failures, then a started turn, then two more pre-start failures
    const base = Date.now();
    seedAuthoringRun(store, 22, 1, { started: false, createdAt: new Date(base - 40_000).toISOString() });
    seedAuthoringRun(store, 22, 1, { started: false, createdAt: new Date(base - 30_000).toISOString() });
    seedAuthoringRun(store, 22, 1, { started: true, createdAt: new Date(base - 20_000).toISOString() });
    seedAuthoringRun(store, 22, 1, { started: false, createdAt: new Date(base - 10_000).toISOString() });
    seedAuthoringRun(store, 22, 1, { started: false, createdAt: new Date(base).toISOString() });
    expect(store.countConsecutiveUnstartableAuthoringTurns(22, 1)).toBe(2);
    expect(store.countStartedAuthoringTurns(22, 1)).toBe(1);
  });

  it("isolates counts per project generation", () => {
    const store = new OrcProjectRunStoreType();
    ensureSupervisionTable(store);
    seedProject(store, 23);
    seedAuthoringRun(store, 23, 1, { started: true });
    seedAuthoringRun(store, 23, 2, { started: true });
    seedAuthoringRun(store, 23, 2, { started: true });
    expect(store.countStartedAuthoringTurns(23, 1)).toBe(1);
    expect(store.countStartedAuthoringTurns(23, 2)).toBe(2);
  });

  it("exposes the last authoring failure code and latest claim timestamp", () => {
    const store = new OrcProjectRunStoreType();
    ensureSupervisionTable(store);
    seedProject(store, 24);
    const later = new Date(Date.now() + 60_000).toISOString();
    seedAuthoringRun(store, 24, 1, { started: false, createdAt: later });
    store.db.prepare(`UPDATE orc_project_runs SET failure_code = 'start_port_rejected' WHERE created_at = ?`).run(later);
    expect(store.lastAuthoringFailureCode(24, 1)).toBe("start_port_rejected");
    expect(store.lastAuthoringClaimAt(24, 1)).toBe(later);
    expect(store.lastAuthoringFailureCode(24, 2)).toBeNull();
    expect(store.lastAuthoringClaimAt(24, 2)).toBeNull();
  });
});

describe("#1729 v2 synthesis admission", () => {
  let seq = 5000;
  const nextId = (): number => ++seq;
  const isoFuture = (): string => new Date(Date.now() + 3_600_000).toISOString();
  const isoNow = (): string => new Date().toISOString();

  type Store = import("./orc-project-run-store.js").OrcProjectRunStore;

  async function seedDeliveredProject(s: Store, opts: {
    reportJson: string | null;
    newest: { outcome: string; failureCode?: string; marked?: boolean; started?: boolean };
    lanes?: number;
    /** #1789: when provided, lanes are driven through the real kanban transition
        helpers (never a raw status write) to exactly these statuses. */
    laneStatuses?: string[];
  }): Promise<{ root: number; runId: string }> {
    const kanban = await import("../tasks/kanban-board.js");
    const review = await import("../project-acceptance/project-review-store.js");
    const worker = await import("../worker-supervision-store.js");
    void new review.ProjectReviewStore();
    void new worker.WorkerSupervisionStore();
    const root = kanban.kanbanEnqueue("Delivered project", "task", undefined, { type: "O", goal: "g" }) as number;
    const runId = `run-${root}`;
    const taskId = `task-${root}`;
    s.db.prepare(`UPDATE kanban_board SET source_id = ?, due_at = ?, status = 'running' WHERE id = ?`).run(runId, isoFuture(), root);
    // Card-scoped slate: earlier tests in this file seed fixed card ids that can
    // collide with autoincrement roots (INSERT OR IGNORE supervision, stale run
    // rows tripping card fuse windows, stale ownership counters colliding on the
    // UNIQUE(project_card_id, ownership_generation) index). A fresh root owns
    // none of that history; finished tests never re-read it.
    s.db.prepare(`DELETE FROM orc_project_runs WHERE project_card_id = ?`).run(root);
    s.db.prepare(`DELETE FROM orc_fuse_state WHERE scope = ?`).run(`card:${root}`);
    s.db.prepare(`DELETE FROM orc_project_ownership_counters WHERE project_card_id = ?`).run(root);
    s.db.prepare(`INSERT INTO project_supervision (project_card_id, contract_id, state, generation, updated_at)
      VALUES (?, '', 'executing', 1, ?) ON CONFLICT(project_card_id) DO UPDATE SET state = 'executing'`).run(root, isoNow());
    // Bridge-wide start/row windows count every run row in this shared test
    // database, so late-file tests trip them through no fault of their own.
    // Reset the bridge window baseline to "now" for every fresh root.
    try {
      const maxSeq = (s.db.prepare(`SELECT COALESCE(MAX(global_sequence), 0) AS m FROM orc_project_runs`).get() as { m: number }).m;
      s.db.prepare(`INSERT INTO orc_fuse_state (scope, cleared_global_sequence) VALUES ('bridge', ?)
        ON CONFLICT(scope) DO UPDATE SET cleared_global_sequence = excluded.cleared_global_sequence, opened_at = NULL`).run(maxSeq);
    } catch { /* fuse table absent — nothing to clear */ }
    const now = Date.now();
    const cols = ["run_id", "task_id", "group_id", "attempt", "trigger", "occurrence_at", "reserved_at", "deadline_at", "phase", "last_progress_at", "progress_sequence", "card_id", "session_id", "execution_id", "terminal_request_json", "report_contract_json", "owner_pid", "owner_started_at"];
    s.db.prepare(`INSERT INTO task_runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      runId, taskId, "g", 1, "schedule", now - 60_000, now - 60_000, now + 3_600_000, "executing", now, 0,
      root, null, null, null, opts.reportJson, process.pid, null);
    const lanes = opts.lanes ?? 2;
    if (opts.laneStatuses) {
      for (const [i, status] of opts.laneStatuses.entries()) {
        const child = kanban.kanbanEnqueue(`lane ${i} ${status}`, "agent", undefined, { type: "W", parent_id: root }) as number;
        if (status === "running") kanban.kanbanRunning(child);
        if (status === "done" || status === "delivering" || status === "delivered") {
          kanban.kanbanComplete(child, null, "lane summary");
        }
        if (status === "delivering" || status === "delivered") {
          if (!kanban.kanbanClaimDelivery(child)) throw new Error(`delivery claim failed for lane ${i}`);
        }
        if (status === "delivered") kanban.kanbanMarkDelivered(child);
        if (status === "failed") kanban.kanbanFail(child, "lane failed");
      }
    } else {
      for (let i = 0; i < lanes; i++) {
        const child = kanban.kanbanEnqueue(`lane ${i}`, "agent", undefined, { type: "W", parent_id: root }) as number;
        s.db.prepare(`UPDATE kanban_board SET status = 'done' WHERE id = ?`).run(child);
        const attemptId = `a_${root}_${i}`;
        s.db.prepare(`INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, generation, lifecycle, status, started_at) VALUES (?, ?, ?, 1, 'spin-local', 'e1', 1, 'completed', 'done', ?)`)
          .run(attemptId, child, `pc_${child}`, isoNow());
        s.db.prepare(`INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at) VALUES (?, '{}', 'd', ?)`).run(attemptId, isoNow());
      }
    }
    const n = opts.newest;
    s.db.prepare(`INSERT INTO orc_project_runs (id, intent_key, intent_kind, intent_ref, goal, project_card_id, project_generation, ownership_generation, owner_peer, owner_instance_id, global_sequence, origin_kind, origin_peer, task_run_id, salvage_for_run_id, state, outcome, failure_code, started_at, created_at, updated_at)
      VALUES (?, ?, 'project_execution', NULL, ?, ?, 1, 1, 'local_peer', 'inst_1', NULL, 'local', NULL, ?, ?, 'released', ?, ?, ?, ?, ?)`)
      .run(`or_${root}_1_x`, `execute:${root}:1`, `primary goal ${root}`, root, runId,
        n.marked ? `or_${root}_0_x` : null, n.outcome, n.failureCode ?? null,
        n.started === false ? null : isoNow(), isoNow(), isoNow());
    // Production-faithful: the primary claim consumed ownership generation 1,
    // so the synthesis claim allocates 2 (same intent key, distinct generation).
    s.db.prepare(`INSERT OR IGNORE INTO orc_project_ownership_counters (project_card_id, next_generation) VALUES (?, 2)`).run(root);
    return { root, runId };
  }

  const salvageInput = (root: number, runId: string) => ({
    projectCardId: root,
    taskRunId: runId,
    cardSource: "task",
    originKind: "local" as const,
    sourcePeer: null,
  });

  const reportFile = (root: number): string => {
    const dir = join(TEST_HOME, "workspace", `rep-${root}`);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "Daily-Briefing-2026-09-08.md");
    writeFileSync(p, "# Daily Briefing\n\n## Stats\n\n- x\n");
    return p;
  };

  const snapshotFor = (p: string, baseline: { existed: boolean; size?: number; mtimeMs?: number }): string =>
    JSON.stringify({ artifactPath: p, minBytes: 10, requiredSections: ["# Daily Briefing", "## Stats"], baseline });

  it("admits one synthesis turn for a completed primary with a missing report (2026-09-08 shape)", async () => {
    const s = new OrcProjectRunStoreType();
    ensureSupervisionTable(s);
    const p = reportFile(nextId()); // path reserved but file never written
    const missing = p + ".absent";
    const { root, runId } = await seedDeliveredProject(s, {
      reportJson: snapshotFor(missing, { existed: false }),
      newest: { outcome: "completed" },
    });
    const result = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") return;
    const row = s.getRun(result.context.runId);
    expect(row?.salvage_for_run_id).toBe(`or_${root}_1_x`);
    expect(row?.goal.startsWith("[SYNTHESIS]")).toBe(true);
    expect(row?.goal).not.toContain("[SALVAGE SYNTHESIS]");
  });

  it("skips synthesis when the report is already valid", async () => {
    const s = new OrcProjectRunStoreType();
    ensureSupervisionTable(s);
    const p = reportFile(nextId());
    const { root, runId } = await seedDeliveredProject(s, {
      reportJson: snapshotFor(p, { existed: false }),
      newest: { outcome: "completed" },
    });
    const before = (s.db.prepare(`SELECT COUNT(*) AS n FROM orc_project_runs`).get() as { n: number }).n;
    const result = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.reason).toBe("salvage_not_needed");
    const after = (s.db.prepare(`SELECT COUNT(*) AS n FROM orc_project_runs`).get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("admits synthesis for a stale prior-occurrence report at the same path", async () => {
    const s = new OrcProjectRunStoreType();
    ensureSupervisionTable(s);
    const p = reportFile(nextId());
    const st = statSync(p);
    const { root, runId } = await seedDeliveredProject(s, {
      reportJson: snapshotFor(p, { existed: true, size: st.size, mtimeMs: st.mtimeMs }),
      newest: { outcome: "completed" },
    });
    const result = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(result.kind).toBe("claimed");
  });

  it("bounds missing-output-after-synthesis as exhausted with no second turn", async () => {
    const s = new OrcProjectRunStoreType();
    ensureSupervisionTable(s);
    const p = reportFile(nextId());
    const missing = p + ".absent";
    const { root, runId } = await seedDeliveredProject(s, {
      reportJson: snapshotFor(missing, { existed: false }),
      newest: { outcome: "completed" },
    });
    const first = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    // Synthesis ran and released completed, but the report is still missing.
    expect(s.release(first.context, "completed")).toBe(true);
    const second = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(second.kind).toBe("conflict");
    if (second.kind !== "conflict") return;
    expect(second.reason).toBe("salvage_exhausted");
    const marked = (s.db.prepare(`SELECT COUNT(*) AS n FROM orc_project_runs WHERE project_card_id = ? AND salvage_for_run_id IS NOT NULL`).get(root) as { n: number }).n;
    expect(marked).toBe(1);
    const cases = (s.db.prepare(`SELECT COUNT(*) AS n FROM project_review_cases WHERE project_card_id = ?`).get(root) as { n: number }).n;
    expect(cases).toBe(0);
  });

  it("keeps failed-primary salvage on the v1 path and goal", async () => {
    const s = new OrcProjectRunStoreType();
    ensureSupervisionTable(s);
    const p = reportFile(nextId());
    const missing = p + ".absent";
    const { root, runId } = await seedDeliveredProject(s, {
      reportJson: snapshotFor(missing, { existed: false }),
      newest: { outcome: "failed", failureCode: "prompt_round_limit" },
    });
    const result = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") return;
    expect(s.getRun(result.context.runId)?.goal.startsWith("[SALVAGE SYNTHESIS]")).toBe(true);
  });

  it("routes a failed primary with an already-valid report straight to review (v1 change)", async () => {
    const s = new OrcProjectRunStoreType();
    ensureSupervisionTable(s);
    const p = reportFile(nextId());
    const { root, runId } = await seedDeliveredProject(s, {
      reportJson: snapshotFor(p, { existed: false }),
      newest: { outcome: "failed", failureCode: "prompt_round_limit" },
    });
    const result = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.reason).toBe("salvage_not_needed");
  });

  it("treats legacy rows without a snapshot as no-evidence (today's routing)", async () => {
    const s = new OrcProjectRunStoreType();
    ensureSupervisionTable(s);
    const { root, runId } = await seedDeliveredProject(s, {
      reportJson: null,
      newest: { outcome: "completed" },
    });
    const result = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.reason).toBe("salvage_not_needed");
  });

  it("#1789 admits the KP-35 repair shape: failed originals plus delivered repairs", async () => {
    // #1789 regression: 2 failed lanes + 4 delivered (2 originals + 2 repairs),
    // nothing in flight, report missing → the claim must admit. The shipped
    // `status = 'done'` gate read 0 ready of 6 and refused. Lanes are driven
    // through the real transition helpers; no attempt/result rows are seeded,
    // proving the new gate depends on lane status alone.
    const s = new OrcProjectRunStoreType();
    ensureSupervisionTable(s);
    const p = reportFile(nextId());
    const missing = p + ".absent";
    const { root, runId } = await seedDeliveredProject(s, {
      reportJson: snapshotFor(missing, { existed: false }),
      newest: { outcome: "completed" },
      laneStatuses: ["failed", "delivered", "failed", "delivered", "delivered", "delivered"],
    });
    const result = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
    expect(result.kind).toBe("claimed");
  });

  it("#1789 refuses while any lane is queued, running, or delivering", async () => {
    for (const status of ["queued", "running", "delivering"]) {
      const s = new OrcProjectRunStoreType();
      ensureSupervisionTable(s);
      const p = reportFile(nextId());
      const missing = p + ".absent";
      const { root, runId } = await seedDeliveredProject(s, {
        reportJson: snapshotFor(missing, { existed: false }),
        newest: { outcome: "completed" },
        laneStatuses: ["delivered", status],
      });
      const result = s.claimSalvageExecution(salvageInput(root, runId), "local_peer", "inst_1");
      expect(result.kind, status).toBe("conflict");
      if (result.kind !== "conflict") continue;
      expect(result.reason).toBe("salvage_ineligible");
    }
  });
});
