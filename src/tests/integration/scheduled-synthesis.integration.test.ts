import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * #1729 v2 journey acceptance (the Astrabro gate): the 2026-09-08 ordering defect
 * was Rule 13 → admission → review with no synthesis turn in between. This file
 * reproduces the actual journey through the real gather → decision → claim chain
 * with the internal production composition real; only the Orc turn itself is
 * simulated (write the report file + release the row — the durable effects of a
 * synthesis turn, which is all the decision/admission layers can observe).
 */
describe("#1729 v2 synthesis journey", () => {
  let home: string;
  let store: import("../../components/orc-project/orc-project-run-store.js").OrcProjectRunStore;
  let ReviewStore: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
  let kanban: typeof import("../../components/tasks/kanban-board.js");
  let gatherMod: typeof import("../../components/project-acceptance/project-lifecycle-facts.js");
  let decideMod: typeof import("../../components/project-acceptance/project-lifecycle-decision.js");

  beforeEach(async () => {
    vi.resetModules();
    home = join(tmpdir(), `abtars-synth-journey-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
    kanban = await import("../../components/tasks/kanban-board.js");
    const review = await import("../../components/project-acceptance/project-review-store.js");
    ReviewStore = review.ProjectReviewStore;
    void new ReviewStore();
    const worker = await import("../../components/worker-supervision-store.js");
    void new worker.WorkerSupervisionStore();
    const runStore = await import("../../components/orc-project/orc-project-run-store.js");
    store = new runStore.OrcProjectRunStore();
    gatherMod = await import("../../components/project-acceptance/project-lifecycle-facts.js");
    decideMod = await import("../../components/project-acceptance/project-lifecycle-decision.js");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const isoFuture = (): string => new Date(Date.now() + 3_600_000).toISOString();
  const isoNow = (): string => new Date().toISOString();

  /** Delivered-lane project whose primary completed at handoff; report snapshot persisted, file absent. */
  async function seedHandoffProject(): Promise<{ root: number; runId: string; reportPath: string }> {
    const root = kanban.kanbanEnqueue("Journey project", "task", undefined, { type: "O", goal: "g" }) as number;
    const runId = `jrun-${root}`;
    store.db.prepare(`UPDATE kanban_board SET source_id = ?, due_at = ?, status = 'running' WHERE id = ?`).run(runId, isoFuture(), root);
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_supervision (
      project_card_id INTEGER PRIMARY KEY, contract_id TEXT, state TEXT NOT NULL DEFAULT 'executing',
      generation INTEGER NOT NULL DEFAULT 1, review_round INTEGER NOT NULL DEFAULT 0, repair_round INTEGER NOT NULL DEFAULT 0,
      active_review_case_id TEXT, accepted_decision_id TEXT, blocked_reason TEXT, updated_at TEXT NOT NULL);`);
    store.db.prepare(`INSERT INTO project_supervision (project_card_id, contract_id, state, generation, updated_at) VALUES (?, 'pc', 'executing', 1, ?)`)
      .run(root, isoNow());
    new ReviewStore().insertContract({
      schema_version: 2,
      id: "pc",
      digest: `d-${root}`,
      project_card_id: root,
      goal: "g",
      criteria: [
        { id: "lane1", description: "lane one", required: false, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "lane2", description: "lane two", required: false, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "orc-synthesis", description: "synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
      ],
      required_outputs: [{ id: "briefing", description: "report", kind: "file", required: true }],
      constraints: [],
      limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: isoNow() },
    } as never);
    const dir = join(home, "workspace", `journey-${root}`);
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, "Daily-Briefing-2026-09-08.md");
    const now = Date.now();
    const snapshot = JSON.stringify({
      artifactPath: reportPath, minBytes: 10,
      requiredSections: ["# Daily Briefing", "## Stats"], baseline: { existed: false },
    });
    const cols = ["run_id", "task_id", "group_id", "attempt", "trigger", "occurrence_at", "reserved_at", "deadline_at", "phase", "last_progress_at", "progress_sequence", "card_id", "session_id", "execution_id", "terminal_request_json", "report_contract_json", "owner_pid", "owner_started_at"];
    store.db.prepare(`INSERT INTO task_runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      runId, `jt-${root}`, "g", 1, "schedule", now - 60_000, now - 60_000, now + 3_600_000, "executing", now, 0,
      root, null, null, null, snapshot, process.pid, null);
    for (let i = 0; i < 2; i++) {
      const child = kanban.kanbanEnqueue(`lane ${i}`, "agent", undefined, { type: "W", parent_id: root }) as number;
      store.db.prepare(`UPDATE kanban_board SET status = 'done' WHERE id = ?`).run(child);
      const attemptId = `ja_${root}_${i}`;
      store.db.prepare(`INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, generation, lifecycle, status, started_at) VALUES (?, ?, ?, 1, 'spin-local', 'e1', 1, 'completed', 'done', ?)`)
        .run(attemptId, child, `pc_${child}`, isoNow());
      store.db.prepare(`INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at) VALUES (?, '{}', 'd', ?)`).run(attemptId, isoNow());
    }
    store.db.prepare(`INSERT INTO orc_project_runs (id, intent_key, intent_kind, intent_ref, goal, project_card_id, project_generation, ownership_generation, owner_peer, owner_instance_id, global_sequence, origin_kind, origin_peer, task_run_id, salvage_for_run_id, state, outcome, failure_code, started_at, created_at, updated_at)
      VALUES (?, ?, 'project_execution', NULL, ?, ?, 1, 1, 'local_peer', 'inst_1', NULL, 'local', NULL, ?, NULL, 'released', 'completed', NULL, ?, ?, ?)`)
      .run(`or_${root}_1_x`, `execute:${root}:1`, `primary goal ${root}`, root, runId, isoNow(), isoNow(), isoNow());
    store.db.prepare(`INSERT OR IGNORE INTO orc_project_ownership_counters (project_card_id, next_generation) VALUES (?, 2)`).run(root);
    return { root, runId, reportPath };
  }

  function decide(root: number) {
    const gathered = gatherMod.gatherProjectLifecycleFacts(store.db, root);
    if (!("facts" in gathered)) throw new Error(`gather failed: ${JSON.stringify(gathered)}`);
    return decideMod.deriveProjectLifecycleDecision(gathered.facts);
  }

  const claimInput = (root: number, runId: string) => ({
    projectCardId: root, taskRunId: runId, cardSource: "task", originKind: "local" as const, sourcePeer: null,
  });

  const markedCount = (root: number): number =>
    (store.db.prepare(`SELECT COUNT(*) AS n FROM orc_project_runs WHERE project_card_id = ? AND salvage_for_run_id IS NOT NULL`).get(root) as { n: number }).n;

  it("lanes done → one synthesis turn writes the report → review path, never a second turn", async () => {
    const { root, runId, reportPath } = await seedHandoffProject();

    // Round 1: lanes terminal, no report — the decision must route to synthesis.
    expect(decide(root)).toMatchObject({ kind: "attempt_salvage" });
    const first = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    expect(markedCount(root)).toBe(1);

    // The synthesis turn's durable effects: report written, turn released.
    writeFileSync(reportPath, "# Daily Briefing\n\n## Stats\n\n- x\n");
    expect(store.release(first.context, "completed")).toBe(true);

    // Round 2: same lanes, report now valid — admission must step aside for review.
    expect(decide(root)).toMatchObject({ kind: "attempt_salvage" });
    const second = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(second.kind).toBe("conflict");
    if (second.kind !== "conflict") return;
    expect(second.reason).toBe("salvage_not_needed");
    expect(markedCount(root)).toBe(1);
  });

  it("a live synthesis turn owns the project: duplicate wake cannot start another", async () => {
    const { root, runId } = await seedHandoffProject();
    expect(decide(root)).toMatchObject({ kind: "attempt_salvage" });
    const first = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(first.kind).toBe("claimed");

    // Duplicate wake while the synthesis turn is live (scheduled, un-released):
    // the live owner wins — no second turn is admitted.
    const dup = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(dup.kind).toBe("busy");
    expect(markedCount(root)).toBe(1);
  });
});
