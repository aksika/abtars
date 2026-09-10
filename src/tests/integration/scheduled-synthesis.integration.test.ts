import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * #1729 v2 journey acceptance (the Astrabro gate): the 2026-09-08 ordering defect
 * was Rule 13 → admission → review with no synthesis turn in between. This file
 * reproduces the actual journey through the real salvage-claim chain
 * with the internal production composition real; only the Orc turn itself is
 * simulated (write the report file + release the row — the durable effects of a
 * synthesis turn, which is all the admission layer can observe).
 */
describe("#1729 v2 synthesis journey", () => {
  let home: string;
  let store: import("../../components/orc-project/orc-project-run-store.js").OrcProjectRunStore;
  let ReviewStore: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
  let kanban: typeof import("../../components/tasks/kanban-board.js");

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
      // #1789: drive the production lifecycle through the real transition helpers —
      // never a raw status write. Lanes end `delivered` (where production's sweeper
      // leaves them), not the transient `done` the old fixture hand-seeded.
      kanban.kanbanComplete(child, null, "lane summary");
      if (!kanban.kanbanClaimDelivery(child)) throw new Error(`delivery claim failed for lane ${i}`);
      kanban.kanbanMarkDelivered(child);
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

  const claimInput = (root: number, runId: string) => ({
    projectCardId: root, taskRunId: runId, cardSource: "task", originKind: "local" as const, sourcePeer: null,
  });

  const markedCount = (root: number): number =>
    (store.db.prepare(`SELECT COUNT(*) AS n FROM orc_project_runs WHERE project_card_id = ? AND salvage_for_run_id IS NOT NULL`).get(root) as { n: number }).n;

  it("lanes done → one synthesis turn writes the report → review path, never a second turn", async () => {
    const { root, runId, reportPath } = await seedHandoffProject();

    // Round 1: lanes terminal, no report — salvage admission must claim the synthesis turn.
    const first = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    expect(markedCount(root)).toBe(1);

    // The synthesis turn's durable effects: report written, turn released.
    writeFileSync(reportPath, "# Daily Briefing\n\n## Stats\n\n- x\n");
    expect(store.release(first.context, "completed")).toBe(true);

    // Round 2: same lanes, report now valid — admission must step aside for review.
    const second = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(second.kind).toBe("conflict");
    if (second.kind !== "conflict") return;
    expect(second.reason).toBe("salvage_not_needed");
    expect(markedCount(root)).toBe(1);
  });

  it("a live synthesis turn owns the project: duplicate wake cannot start another", async () => {
    const { root, runId } = await seedHandoffProject();
    const first = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(first.kind).toBe("claimed");

    // Duplicate wake while the synthesis turn is live (scheduled, un-released):
    // the live owner wins — no second turn is admitted.
    const dup = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(dup.kind).toBe("busy");
    expect(markedCount(root)).toBe(1);
  });

  it("#1791 report handoff: failed primary with valid report → review receives citable report evidence → accept", async () => {
    // Production incident 2026-09-09 (project 160): lanes passed, the primary
    // wrote the final report, then exhausted its prompt rounds. Admission stood
    // down correctly (no second synthesis turn), but the review case carried no
    // report evidence and the reviewer — without filesystem tools — blocked on
    // missing_required_output for a deliverable that existed. Root
    // output/criterion ids deliberately differ from project 160 to catch
    // hardcoding (final-report/orc-synthesis must never appear here).
    const root = kanban.kanbanEnqueue("Handoff project", "task", undefined, { type: "O", goal: "g" }) as number;
    const runId = `hrun-${root}`;
    store.db.prepare(`UPDATE kanban_board SET source_id = ?, due_at = ?, status = 'running' WHERE id = ?`).run(runId, isoFuture(), root);
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_supervision (
      project_card_id INTEGER PRIMARY KEY, contract_id TEXT, state TEXT NOT NULL DEFAULT 'executing',
      generation INTEGER NOT NULL DEFAULT 1, review_round INTEGER NOT NULL DEFAULT 0, repair_round INTEGER NOT NULL DEFAULT 0,
      active_review_case_id TEXT, accepted_decision_id TEXT, blocked_reason TEXT, updated_at TEXT NOT NULL);`);
    store.db.prepare(`INSERT INTO project_supervision (project_card_id, contract_id, state, generation, updated_at) VALUES (?, 'hpc', 'executing', 1, ?)`)
      .run(root, isoNow());
    const reviewStoreMod = await import("../../components/project-acceptance/project-review-store.js");
    new reviewStoreMod.ProjectReviewStore().insertContract({
      schema_version: 2,
      id: "hpc",
      digest: `d-hpc-${root}`,
      project_card_id: root,
      goal: "g",
      criteria: [
        { id: "jlane-a", description: "first source", required: false, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "jlane-b", description: "second source", required: false, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "jmeld", description: "meld into dossier", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
      ],
      required_outputs: [{ id: "jdossier", description: "dossier file", kind: "file", required: true }],
      constraints: [],
      limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: isoNow() },
    } as never);

    const dir = join(home, "workspace", `handoff-${root}`);
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, "Dossier.md");
    const reportBody = "# Dossier\n\n## Findings\n\n- melded lane evidence\n";
    const now = Date.now();
    const snapshot = JSON.stringify({
      artifactPath: reportPath, minBytes: 10,
      requiredSections: ["# Dossier", "## Findings"], baseline: { existed: false },
    });
    const cols = ["run_id", "task_id", "group_id", "attempt", "trigger", "occurrence_at", "reserved_at", "deadline_at", "phase", "last_progress_at", "progress_sequence", "card_id", "session_id", "execution_id", "terminal_request_json", "report_contract_json", "owner_pid", "owner_started_at"];
    store.db.prepare(`INSERT INTO task_runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      runId, `ht-${root}`, "g", 1, "schedule", now - 60_000, now - 60_000, now + 3_600_000, "executing", now, 0,
      root, null, null, null, snapshot, process.pid, null);

    // Two lanes with real worker contracts and passed results (supports mapping).
    const supMod = await import("../../components/worker-supervision-store.js");
    const supStore = new supMod.WorkerSupervisionStore();
    const laneCrit = ["jlane-a", "jlane-b"];
    const laneEvidence: string[] = [];
    for (let i = 0; i < 2; i++) {
      const child = kanban.kanbanEnqueue(`hlane ${i}`, "agent", undefined, { type: "W", parent_id: root }) as number;
      const contractId = `hpc_${child}`;
      const childCrit = `hl${child}c1`;
      supStore.insertContract({
        schema_version: 1,
        id: contractId,
        digest: `digest-${contractId}`,
        goal: "lane goal",
        criteria: [{ id: childCrit, description: "lane criterion" }],
        expected_artifacts: [{ id: "a1", kind: "file", ref: "handoff.md", required: true, criterion_ids: [childCrit] }],
        verification_commands: [],
        required_capabilities: [],
        supports_root_criteria: [laneCrit[i]!],
        limits: {},
        provenance: { root_card_id: root, card_id: child, authored_by: "orc", created_at: isoNow() },
      }, child);
      kanban.kanbanComplete(child, null, "lane summary");
      if (!kanban.kanbanClaimDelivery(child)) throw new Error(`delivery claim failed for lane ${i}`);
      kanban.kanbanMarkDelivered(child);
      const attemptId = `ha_${root}_${i}`;
      store.db.prepare(`INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, generation, lifecycle, status, started_at) VALUES (?, ?, ?, 1, 'spin-local', 'e1', 1, 'completed', 'done', ?)`)
        .run(attemptId, child, contractId, isoNow());
      supStore.insertResult(attemptId, {
        schema_version: 1,
        attempt: { id: attemptId, ordinal: 1, contract_id: contractId, contract_digest: `digest-${contractId}`, executor_kind: "spin-local", executor_id: "e1", started_at: isoNow(), finished_at: isoNow() },
        outcome: "completed",
        criteria: [{ criterion_id: childCrit, status: "passed", evidence_ids: ["v1"] }],
        checks: [{ check_id: "v1", argv: ["true"], started_at: isoNow(), finished_at: isoNow(), timed_out: false, exit_code: 0, signal: null, stdout_excerpt: "ok", stderr_excerpt: "" }],
        artifacts: [{ artifact_id: "a1", exists: true, kind: "file", ref: "handoff.md" }],
        worker_report: { summary: "lane done", claims: [], unresolved_risks: [] },
      });
      laneEvidence.push(`attempt:${attemptId}:check:v1`);
    }

    // The primary's durable effects: report written, then the turn exhausted
    // its rounds (released + failed with prompt_round_limit — the incident).
    writeFileSync(reportPath, reportBody, "utf-8");
    store.db.prepare(`INSERT INTO orc_project_runs (id, intent_key, intent_kind, intent_ref, goal, project_card_id, project_generation, ownership_generation, owner_peer, owner_instance_id, global_sequence, origin_kind, origin_peer, task_run_id, salvage_for_run_id, state, outcome, failure_code, started_at, created_at, updated_at)
      VALUES (?, ?, 'project_execution', NULL, ?, ?, 1, 1, 'local_peer', 'inst_1', NULL, 'local', NULL, ?, NULL, 'released', 'failed', 'prompt_round_limit', ?, ?, ?)`)
      .run(`or_${root}_1_x`, `execute:${root}:1`, `primary goal ${root}`, root, runId, isoNow(), isoNow(), isoNow());
    store.db.prepare(`INSERT OR IGNORE INTO orc_project_ownership_counters (project_card_id, next_generation) VALUES (?, 2)`).run(root);

    // Admission stands down: valid report routes to review, no second turn.
    const claim = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(claim).toMatchObject({ kind: "conflict", reason: "salvage_not_needed" });
    expect(markedCount(root)).toBe(0);

    // Real case assembly + persistence.
    const { ReviewCaseAssembler } = await import("../../components/project-acceptance/project-review-case.js");
    const assembled = await new ReviewCaseAssembler().assembleCase(root, 1, 1);
    expect("error" in assembled).toBe(false);
    if ("error" in assembled) return;
    const expectedDigest = `sha256:${createHash("sha256").update(reportBody, "utf-8").digest("hex")}`;
    const expectedId = `report:${runId}:${expectedDigest}`;
    expect(assembled.report_evidence).toMatchObject({
      state: "captured",
      evidence_id: expectedId,
      run_id: runId,
      path: reportPath,
      digest: expectedDigest,
      content: reportBody,
    });
    // Citable from the Orc-owned criterion only — never from delegated lanes.
    const meld = assembled.criterion_inputs.find(c => c.criterion_id === "jmeld")!;
    expect(meld.artifact_observation_ids).toContain(expectedId);
    for (const laneId of laneCrit) {
      const lane = assembled.criterion_inputs.find(c => c.criterion_id === laneId)!;
      expect(lane.artifact_observation_ids).not.toContain(expectedId);
    }

    const reviewStore = new ReviewStore();
    const { id: caseId } = reviewStore.insertReviewCase(root, 1, 1, assembled, `digest_handoff_${root}`);
    reviewStore.insertReviewRequest(root, caseId, 1);
    reviewStore.stateTransition(root, ["executing"], "review_requested");

    // Actual reviewer-tool retrieval with review authority.
    const { getOrcTools } = await import("../../components/transport/orc-tools.js");
    const caseTool = getOrcTools().find(t => t.name === "get_project_review_case")!;
    const raw = await caseTool.execute(
      { project_card_id: root, review_case_id: caseId },
      { userId: "test", orcContext: { projectCardId: root, projectGeneration: 1 } } as never,
    );
    const brief = JSON.parse(raw) as {
      report_evidence?: { state: string; evidence_id?: string; content?: string; digest?: string };
      criteria: Array<{ criterion_id: string; compatible_evidence: { artifacts: string[] } }>;
    };
    expect(brief.report_evidence?.state).toBe("captured");
    expect(brief.report_evidence?.evidence_id).toBe(expectedId);
    expect(brief.report_evidence?.content).toBe(reportBody);
    expect(brief.report_evidence?.digest).toBe(expectedDigest);
    expect(brief.criteria.find(c => c.criterion_id === "jmeld")!.compatible_evidence.artifacts).toContain(expectedId);

    // Immutability: replacing the file cannot change the tool response — the
    // reviewer reads the stored capture, never the live filesystem.
    writeFileSync(reportPath, "# Replaced\n", "utf-8");
    const rawAfter = await caseTool.execute(
      { project_card_id: root, review_case_id: caseId },
      { userId: "test", orcContext: { projectCardId: root, projectGeneration: 1 } } as never,
    );
    const briefAfter = JSON.parse(rawAfter) as { report_evidence?: { content?: string; digest?: string } };
    expect(briefAfter.report_evidence?.content).toBe(reportBody);
    expect(briefAfter.report_evidence?.digest).toBe(expectedDigest);

    // Acceptance submission through the real review service.
    const { ProjectReviewService } = await import("../../components/project-acceptance/project-review-service.js");
    const outcome = new ProjectReviewService().processDecision({
      schema_version: 1,
      id: `rd_handoff_${root}`,
      project_card_id: root,
      review_case_id: caseId,
      project_generation: 1,
      action: "accept",
      criteria: [
        { criterion_id: "jlane-a", verdict: "satisfied", evidence_ids: [laneEvidence[0]!], rationale: "lane passed with observed check" },
        { criterion_id: "jlane-b", verdict: "satisfied", evidence_ids: [laneEvidence[1]!], rationale: "lane passed with observed check" },
        { criterion_id: "jmeld", verdict: "satisfied", evidence_ids: [expectedId], rationale: "dossier quality reviewed against both lanes" },
      ],
      outputs: [{ output_id: "jdossier", disposition: "present", evidence_ids: [expectedId] }],
      contradictions: [],
      residual_risks: [],
      synthesis: "Dossier accepted with captured report evidence.",
      authored_at: isoNow(),
    });
    expect(outcome.kind).toBe("accepted");

    // The stored case keeps the original capture even after the file is
    // deleted outright.
    rmSync(reportPath, { force: true });
    const stored = reviewStore.getReviewCase(caseId)!;
    expect(stored.status).toBe("accepted");
    const storedSnapshot = JSON.parse(stored.case_json) as {
      report_evidence?: { state: string; content?: string; digest?: string };
    };
    expect(storedSnapshot.report_evidence?.state).toBe("captured");
    expect(storedSnapshot.report_evidence?.content).toBe(reportBody);
    expect(storedSnapshot.report_evidence?.digest).toBe(expectedDigest);
    expect(reviewStore.getSupervision(root)!.accepted_decision_id).toBeTruthy();
  });

  it("#1789 KP-35 repair shape: failed originals plus delivered repairs still admit synthesis", async () => {
    // Production shape that the shipped gate could never admit: 2 failed lanes +
    // 4 delivered (2 originals + 2 repairs), nothing in flight, report missing.
    const { root, runId } = await seedHandoffProject();
    const extra: Array<[string, "failed" | "delivered"]> = [
      ["repair-a-failed", "failed"],
      ["repair-a-retry", "delivered"],
      ["repair-b-failed", "failed"],
      ["repair-b-retry", "delivered"],
    ];
    for (const [name, status] of extra) {
      const child = kanban.kanbanEnqueue(name, "agent", undefined, { type: "W", parent_id: root }) as number;
      if (status === "failed") {
        kanban.kanbanFail(child, "lane failed");
      } else {
        kanban.kanbanComplete(child, null, "lane summary");
        if (!kanban.kanbanClaimDelivery(child)) throw new Error(`delivery claim failed for ${name}`);
        kanban.kanbanMarkDelivered(child);
      }
    }
    const first = store.claimSalvageExecution(claimInput(root, runId), "local_peer", "inst_1");
    expect(first.kind).toBe("claimed");
    expect(markedCount(root)).toBe(1);
  });
});
