import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskDatabase } from "../../components/tasks/kanban-board.js";
import { getOrcTools } from "../../components/transport/orc-tools.js";

const dispatchMock = vi.fn();
let _DbCtor: any = null;
async function getDbCtor(): Promise<any> {
  if (_DbCtor) return _DbCtor;
  const mod = await import("../../utils/lazy-require.js");
  _DbCtor = mod.resolveNativeDep("better-sqlite3");
  return _DbCtor;
}
vi.mock("../../components/spin.js", () => ({
  spin: { dispatch: dispatchMock },
}));

const cards = new Map<number, any>();
let nextCardId = 100;

let _overrideDb: TaskDatabase | null = null;
let _rawDb: any = null;
vi.mock("../../components/tasks/kanban-board.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/tasks/kanban-board.js")>();
  return {
    // kanbanTransition and sqliteNow are REAL: ProjectReviewStore and
    // ContributionStore call the transition with their own TaskDatabase
    // (the harness's _overrideDb), so journal writes land in the test DB.
    // kanbanComplete/kanbanFail delegate to the real transition with the
    // test DB too — never the module singleton (real home) path.
    kanbanTransition: actual.kanbanTransition,
    sqliteNow: actual.sqliteNow,
    kanbanEnqueue: (title: string, source: string, opts?: any) => {
      const id = nextCardId++;
      const card: any = { id, title, source, status: "queued", type: "W", parent_id: null, goal: null, notes: null, created_at: new Date().toISOString().replace(/Z$/, ""), result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null, priority: "MEDIUM" };
      if (opts) { if (opts.type) card.type = opts.type; if (opts.parent_id) card.parent_id = opts.parent_id; if (opts.notes) card.notes = opts.notes; if (opts.priority) card.priority = opts.priority; }
      cards.set(id, card);
      return id;
    },
    kanbanGetCard: (id: number) => { const c = cards.get(id); return c ?? null; },
    kanbanGetChildren: (parentId: number) => Array.from(cards.values()).filter((c: any) => c.parent_id === parentId),
    kanbanQueuedDispatchOrder: (now?: number) => Array.from(cards.values()).filter((c: any) => c.status === "queued"),
    kanbanRunning: (id: number) => { const c = cards.get(id); if (c) c.status = "running"; },
    kanbanComplete: (id: number, resultPath: string | null, summary: string) => {
      if (!_overrideDb) return;
      actual.kanbanTransition({
        cardId: id, from: ["running", "queued"], to: "done", actor: "settle_done",
        reason: "contribution completed",
        fields: { result_path: resultPath, result_summary: summary.slice(0, 4000), completed_at: actual.sqliteNow() },
        emit: false,
      }, _overrideDb);
      // Mirror into the in-memory dispatch map — the reconciler reads cards
      // through the mocked kanbanGetCard.
      const c = cards.get(id);
      if (c) { c.status = "done"; if (resultPath) c.result_path = resultPath; if (summary) c.result_summary = summary; }
    },
    kanbanFail: (id: number, reason?: string) => {
      if (!_overrideDb) return;
      actual.kanbanTransition({
        cardId: id, from: ["queued", "running", "done"], to: "failed", actor: "settle_failed",
        reason: reason ?? "contribution failed",
        fields: { error: reason ?? "contribution failed", completed_at: actual.sqliteNow() },
        emit: false,
      }, _overrideDb);
      const c = cards.get(id);
      if (c) { c.status = "failed"; c.error = reason ?? "contribution failed"; }
    },
    kanbanUpdate: vi.fn(),
    cascadeFail: vi.fn(),
    isUnblocked: () => true,
    resolveRootId: (id: number) => id,
    KANBAN_TERMINAL_STATUSES: ["done", "delivered", "failed"],
    kanbanPromoteDueRetry: () => false,
    requireTaskDatabase: () => { if (!_overrideDb) throw new Error("_overrideDb not set — call initDb() in beforeEach"); return _overrideDb; },
  };
});

vi.mock("../../components/spin-worker-adapter.js", () => ({
  SpinWorkerAdapter: vi.fn().mockImplementation(function () {
    return {
      capacity: vi.fn().mockResolvedValue({ available: 3, max: 3 }),
      start: vi.fn().mockImplementation((claim: any) => {
        dispatchMock({ type: "W", cardId: claim.cardId });
        return Promise.resolve({ kind: "started", attemptId: claim.attemptId, generation: 1, executorId: "spin-local" });
      }),
      cancel: vi.fn().mockResolvedValue({ kind: "cancelled", attemptId: "a_1" }),
    };
  }),
}));

vi.mock("../../components/executor-lease-store.js", () => ({
  ExecutorLeaseStore: vi.fn().mockImplementation(function () {
    return { getSnapshot: vi.fn().mockReturnValue(null) };
  }),
}));

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

async function initDb(): Promise<void> {
  const DbCtor = await getDbCtor();
  _rawDb = new (DbCtor as any)(":memory:");
  _rawDb.exec(`CREATE TABLE IF NOT EXISTS kanban_board (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT,
    assignee TEXT DEFAULT 'local',
    priority TEXT NOT NULL DEFAULT 'MEDIUM',
    status TEXT NOT NULL DEFAULT 'queued',
    type TEXT, notes TEXT, goal TEXT,
    result_summary TEXT, result_path TEXT, error TEXT,
    delivery_attempts INTEGER DEFAULT 0,
    parent_id INTEGER, blocked_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT, max_tokens INTEGER, tokens_used INTEGER,
    delivery_mode TEXT DEFAULT 'deliver',
    source_peer TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at TEXT
  )`);
  _overrideDb = {
    prepare(sql: string) {
      const stmt = _rawDb.prepare(sql);
      return {
        run(...params: unknown[]) { return stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint }; },
        get(...params: unknown[]) { const r = stmt.get(...params); return r === undefined ? undefined : (r as Record<string, unknown>); },
        all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { _rawDb.exec(sql); },
    transaction<T>(fn: () => T): T { return _rawDb.transaction(fn)(); },
  };
}

// Module-scoped bindings shared by Scenario A/B and the coverage-gate suite.
// Each describe assigns these in beforeEach; helpers below close over them.
let mod: typeof import("../../components/reconciler.js");
let WorkerSupervisionStore: typeof import("../../components/worker-supervision-store.js").WorkerSupervisionStore;
let WorkerSupervisionService: typeof import("../../components/worker-supervision-service.js").WorkerSupervisionService;
let ProjectReviewStore: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
let ReviewCaseAssembler: typeof import("../../components/project-acceptance/project-review-case.js").ReviewCaseAssembler;
let ProjectReviewService: typeof import("../../components/project-acceptance/project-review-service.js").ProjectReviewService;

function makeChildContract(childId: number, rootCardId: number, criterionId: string): import("../../components/worker-contract.js").WorkerAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: `cc_${childId}`,
    digest: `d_cc_${childId}`,
    goal: `summary ${childId}`,
    criteria: [{ id: `wc_${childId}`, description: `worker ${childId}` }],
    expected_artifacts: [{ id: `art_${childId}`, kind: "file", ref: `out_${childId}`, required: true, criterion_ids: [`wc_${childId}`] }],
    verification_commands: [{ id: `chk_${childId}`, argv: ["echo", "ok"], timeout_ms: 30000, criterion_ids: [`wc_${childId}`] }],
    required_capabilities: [],
    supports_root_criteria: [criterionId],
    limits: { max_duration_ms: 300000, max_tokens: 50000 },
    provenance: { root_card_id: rootCardId, card_id: childId, authored_by: "orc", created_at: new Date().toISOString() },
  };
}

function makeEnvelope(childId: number, contractId: string, rootCriterionId: string): import("../../components/worker-contract.js").WorkerResultEnvelopeV1 {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    attempt: { id: `a_${childId}_1`, ordinal: 1, contract_id: contractId, contract_digest: `d_${contractId}`, executor_kind: "agent", executor_id: "spin-local", started_at: now, finished_at: now },
    outcome: "completed",
    criteria: [{ criterion_id: rootCriterionId, status: "passed", evidence_ids: [`chk_${childId}`] }],
    checks: [{ check_id: `chk_${childId}`, argv: ["echo", "ok"], started_at: now, finished_at: now, timed_out: false, exit_code: 0, signal: null, stdout_excerpt: "ok", stderr_excerpt: "" }],
    artifacts: [{ artifact_id: `art_${childId}`, exists: true, kind: "file", ref: `out_${childId}`, size: 42 }],
    worker_report: { summary: `Worker ${childId} ok`, claims: [], unresolved_risks: [] },
  };
}

/** #1618: supervised roots claim through the Orc coordinator, not legacy dispatch. */
function installFakeCoordinator(claims: Array<{ kind: string; pid: number; goal?: string }>) {
  mod.setOrcCoordinator({
    scheduleContractAuthoring: (pid: number) => {
      claims.push({ kind: "authoring", pid });
      return { kind: "claimed" as const, context: { runId: `or_${pid}_fake`, projectCardId: pid } };
    },
    scheduleScheduledProject: (pid: number, goal: string) => {
      claims.push({ kind: "coverage", pid, goal });
      return { kind: "claimed" as const, context: { runId: `or_${pid}_fake`, projectCardId: pid } };
    },
    scheduleReview: (pid: number) => {
      claims.push({ kind: "review", pid });
      return { kind: "claimed" as const, context: { runId: `or_${pid}_rev`, projectCardId: pid } };
    },
  } as never);
}

async function createProject(): Promise<{ projectId: number; childIds: number[] }> {
  const projectId = nextCardId++;
  const now = new Date().toISOString().replace(/Z$/, "");
  cards.set(projectId, {
    id: projectId, title: "three worker project", source: "user",
    status: "running", type: "O", parent_id: null, goal: "Produce three summaries", notes: null,
    created_at: now, result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
  });

  const reviewStore = new ProjectReviewStore();
  reviewStore.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, goal, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, ?, ?)`).run(
    projectId, "three worker project", "user", "Produce three summaries", now, now,
  );
  const rootContractId = `pc_${projectId}`;
  const rootContract = {
    schema_version: 1, id: rootContractId, project_card_id: projectId, digest: `d_${rootContractId}`,
    goal: "Produce three summaries",
    criteria: [
      { id: "c1", description: "Worker 1 completes", required: true, evidence_expectation: "observed" },
      { id: "c2", description: "Worker 2 completes", required: true, evidence_expectation: "observed" },
      { id: "c3", description: "Worker 3 completes", required: true, evidence_expectation: "observed" },
    ],
    required_outputs: [{ id: "out", description: "summaries", kind: "file", required: true }],
    constraints: [], limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
  };
  reviewStore.ensureAwaitingContract(projectId);
  reviewStore.insertContract(rootContract as any);
  reviewStore.stateTransition(projectId, ["awaiting_contract"], "executing");

  const childIds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const cId = nextCardId++;
    const createdAt = new Date().toISOString().replace(/Z$/, "");
    cards.set(cId, {
      id: cId, title: `worker ${i}`, source: "agent",
      status: "queued", type: "W", parent_id: projectId,
      goal: `summary ${i}`, notes: JSON.stringify({ supervised: true }),
      created_at: createdAt, priority: "MEDIUM",
      result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
    });
    const reviewStore = new ProjectReviewStore();
    reviewStore.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, parent_id, goal, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'W', ?, ?, ?, ?)`).run(
      cId, `worker ${i}`, "agent", projectId, `summary ${i}`, createdAt, createdAt,
    );
    childIds.push(cId);
  }
  return { projectId, childIds };
}

async function setupChildContract(store: import("../../components/worker-supervision-store.js").WorkerSupervisionStore, childId: number, rootCardId: number, criterionId: string): Promise<string> {
  const contract = makeChildContract(childId, rootCardId, criterionId);
  store.insertContract(contract, childId);
  store.insertAttempt({
    id: `a_${childId}_1`,
    card_id: childId,
    contract_id: contract.id,
    ordinal: 1,
    executor_kind: "agent",
    executor_id: "spin-local",
    status: "pending",
    started_at: new Date().toISOString(),
    root_project_card_id: rootCardId,
    root_project_generation: 1,
    scheduled_run_id: null,
  });
  return contract.id;
}

async function completeChild(store: import("../../components/worker-supervision-store.js").WorkerSupervisionStore, childId: number, contractId: string, rootCriterionId: string): Promise<void> {
  const attemptId = `a_${childId}_1`;
  store.lifecycleTransition(attemptId, ["pending"], "running", { settled_at: null });
  const env = makeEnvelope(childId, contractId, rootCriterionId);
  store.completeAttempt(attemptId);
  store.insertResult(attemptId, env);
  const card = cards.get(childId);
  if (card) card.status = "done";
}

describe("Swarm acceptance — Scenario A: three local workers (#927)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    cards.clear();
    nextCardId = 100;
    await initDb();

    mod = await import("../../components/reconciler.js");
    const wss = await import("../../components/worker-supervision-store.js");
    WorkerSupervisionStore = wss.WorkerSupervisionStore;
    const wsvc = await import("../../components/worker-supervision-service.js");
    WorkerSupervisionService = wsvc.WorkerSupervisionService;
    const prs = await import("../../components/project-acceptance/project-review-store.js");
    ProjectReviewStore = prs.ProjectReviewStore;
    const rca = await import("../../components/project-acceptance/project-review-case.js");
    ReviewCaseAssembler = rca.ReviewCaseAssembler;
    const prsvc = await import("../../components/project-acceptance/project-review-service.js");
    ProjectReviewService = prsvc.ProjectReviewService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (_rawDb) { try { _rawDb.close(); } catch {} _rawDb = null; _overrideDb = null; }
  });

  it("three supervised children are all claimed and dispatched concurrently", async () => {
    const { projectId, childIds } = await createProject();
    const store = new WorkerSupervisionStore();
    for (let i = 0; i < childIds.length; i++) {
      await setupChildContract(store, childIds[i]!, projectId, `c${i + 1}`);
    }

    mod.requestReconcile(projectId);
    await flush();

    expect(dispatchMock).toHaveBeenCalledTimes(3);
    const dispatchedIds = dispatchMock.mock.calls.map((c: any) => c[0].cardId);
    expect(new Set(dispatchedIds).size).toBe(3);
    for (const id of childIds) expect(dispatchedIds).toContain(id);
  });

  it("W=3 concurrency: all three children transition to running, not sequential", async () => {
    const { projectId, childIds } = await createProject();
    const store = new WorkerSupervisionStore();
    for (let i = 0; i < childIds.length; i++) {
      await setupChildContract(store, childIds[i]!, projectId, `c${i + 1}`);
    }

    mod.requestReconcile(projectId);
    await flush();

    for (const id of childIds) {
      const attempt = store.db.prepare("SELECT lifecycle FROM worker_attempts WHERE card_id = ?").get(id) as any;
      expect(attempt).toBeDefined();
      expect(["running", "starting", "claimed", "completed"].includes(attempt.lifecycle)).toBe(true);
    }
    const running = store.db.prepare("SELECT COUNT(*) as cnt FROM worker_attempts WHERE lifecycle IN ('running','starting','claimed')").get() as any;
    expect(Number(running.cnt)).toBe(3);
  });

  it("all-terminal children trigger ReviewCaseAssembler with real structured results and one durable Orc review claim", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const { projectId, childIds } = await createProject();
    const store = new WorkerSupervisionStore();
    for (let i = 0; i < childIds.length; i++) {
      const cId = await setupChildContract(store, childIds[i]!, projectId, `c${i + 1}`);
      await completeChild(store, childIds[i]!, cId, `c${i + 1}`);
    }

    mod.requestReconcile(projectId);
    await flush();

    const reviewStore = new ProjectReviewStore();
    const openCase = reviewStore.getLatestOpenCase(projectId);
    expect(openCase).toBeDefined();
    const parsed = JSON.parse((openCase as any).case_json);
    expect(parsed.child_summaries.length).toBe(3);

    expect(parsed.child_summaries.every((s: any) => s.outcome === "completed")).toBe(true);
    expect(parsed.criterion_inputs.length).toBeGreaterThanOrEqual(3);

    const supervision = reviewStore.getSupervision(projectId) as any;
    expect(supervision.state).toBe("review_requested");

    // #1625: review dispatch is coordinator-owned after 0b4504a9 — one
    // durable scheduleReview claim, never the legacy spin.dispatch path.
    expect(claims.filter(c => c.kind === "review" && c.pid === projectId)).toHaveLength(1);
    expect(dispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "O", cardId: projectId }),
    );

    mod.setOrcCoordinator(null);
  });

  it("duplicate reconcile pass does not create duplicate review case (exactly-once)", async () => {
    const { projectId, childIds } = await createProject();
    const store = new WorkerSupervisionStore();
    for (let i = 0; i < childIds.length; i++) {
      const cId = await setupChildContract(store, childIds[i]!, projectId, `c${i + 1}`);
      await completeChild(store, childIds[i]!, cId, `c${i + 1}`);
    }

    mod.requestReconcile(projectId);
    await flush();
    const firstCaseCount = Number((new ProjectReviewStore().db.prepare("SELECT COUNT(*) as cnt FROM project_review_cases WHERE project_card_id = ?").get(projectId) as any)?.cnt ?? 0);
    expect(firstCaseCount).toBe(1);

    mod.requestReconcile(projectId);
    await flush();
    const secondCaseCount = Number((new ProjectReviewStore().db.prepare("SELECT COUNT(*) as cnt FROM project_review_cases WHERE project_card_id = ?").get(projectId) as any)?.cnt ?? 0);
    expect(secondCaseCount).toBe(1);
  });

  it("full lifecycle: acceptance persists durably, card settles as done, no duplicate Orc dispatch on replay", async () => {
    const { projectId, childIds } = await createProject();
    const store = new WorkerSupervisionStore();
    for (let i = 0; i < childIds.length; i++) {
      const cId = await setupChildContract(store, childIds[i]!, projectId, `c${i + 1}`);
      await completeChild(store, childIds[i]!, cId, `c${i + 1}`);
    }

    mod.requestReconcile(projectId);
    await flush();

    const reviewStore = new ProjectReviewStore();
    const openCase = reviewStore.getLatestOpenCase(projectId);
    expect(openCase).toBeDefined();

    const assembler = new ReviewCaseAssembler();
    const supervision = reviewStore.getSupervision(projectId) as any;
    const snapshot = await assembler.assembleCase(projectId, supervision.generation, supervision.review_round);
    expect("error" in snapshot).toBe(false);
    const snap = snapshot as any;
    expect(snap.child_summaries.length).toBe(3);
    expect(snap.criterion_inputs.length).toBeGreaterThanOrEqual(3);

    const svc = new ProjectReviewService();

    const criterionVerdicts = snap.criterion_inputs.map((ci: any) => ({
      criterion_id: ci.criterion_id,
      verdict: "satisfied" as const,
      evidence_ids: ci.observed_evidence_ids.length > 0 ? [ci.observed_evidence_ids[0]!] : [],
      rationale: `evidence: ${ci.observed_evidence_ids.join(",")}`,
    }));

    const decision: import("../../components/project-acceptance/project-review-validator.js").ProjectReviewDecisionV1 = {
      schema_version: 1, id: `d_${projectId}`, project_card_id: projectId,
      review_case_id: (openCase as any).id, project_generation: supervision.generation,
      action: "accept",
      criteria: criterionVerdicts,
      outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
      contradictions: [],
      residual_risks: [],
      authored_at: new Date().toISOString(),
      synthesis: "All three workers completed",
    };

    const result = svc.processDecision(decision);
    expect(result.kind).toBe("accepted");

    const updatedSupervision = reviewStore.getSupervision(projectId) as any;
    expect(updatedSupervision.state).toBe("accepted");
    expect(updatedSupervision.accepted_decision_id).toBeTruthy();

    const decisionRow = reviewStore.db.prepare("SELECT * FROM project_review_decisions WHERE review_case_id = ? ORDER BY created_at DESC LIMIT 1").get((openCase as any).id) as any;
    expect(decisionRow).toBeDefined();

    const kanbanRow = reviewStore.db.prepare("SELECT status, result_summary FROM kanban_board WHERE id = ?").get(projectId) as any;
    expect(kanbanRow).toBeDefined();
    expect(kanbanRow.status).toBe("done");
    expect(kanbanRow.result_summary).toContain("completed");

    mod.requestReconcile(projectId);
    await flush();
    const orcDispatchesAfterAcceptance = dispatchMock.mock.calls.filter((c: any) => c[0]?.type === "O");
    expect(orcDispatchesAfterAcceptance.length).toBeLessThanOrEqual(1);
  });

  it("#1626: queued root with retry backoff settles through the real review service", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const { projectId, childIds } = await createProject();
    const store = new WorkerSupervisionStore();
    for (let i = 0; i < childIds.length; i++) {
      const cId = await setupChildContract(store, childIds[i]!, projectId, `c${i + 1}`);
      await completeChild(store, childIds[i]!, cId, `c${i + 1}`);
    }

    mod.requestReconcile(projectId);
    await flush();

    const reviewStore = new ProjectReviewStore();
    const openCase = reviewStore.getLatestOpenCase(projectId);
    expect(openCase).toBeDefined();
    const supervision = reviewStore.getSupervision(projectId) as any;
    expect(supervision.state).toBe("review_requested");

    // Production-observed state (#1389): the coordinator claimed the review
    // turn, then the retry backoff returned the card to queued with a stale
    // execution error and a future next_retry_at. Both the authoritative DB
    // row and the in-memory dispatch map mirror the live state.
    const future = new Date(Date.now() + 60_000).toISOString().replace(/Z$/, "").replace("T", " ").slice(0, 19);
    reviewStore.db.prepare(`
      UPDATE kanban_board SET status = 'queued', error = 'stale failed-turn',
        next_retry_at = ?, retry_count = 2, updated_at = datetime('now') WHERE id = ?
    `).run(future, projectId);
    const mapCard = cards.get(projectId);
    if (mapCard) { mapCard.status = "queued"; mapCard.error = "stale failed-turn"; }

    const assembler = new ReviewCaseAssembler();
    const snapshot = await assembler.assembleCase(projectId, supervision.generation, supervision.review_round);
    expect("error" in snapshot).toBe(false);
    const snap = snapshot as any;

    const svc = new ProjectReviewService();
    const criterionVerdicts = snap.criterion_inputs.map((ci: any) => ({
      criterion_id: ci.criterion_id,
      verdict: "satisfied" as const,
      evidence_ids: ci.observed_evidence_ids.length > 0 ? [ci.observed_evidence_ids[0]!] : [],
      rationale: `evidence: ${ci.observed_evidence_ids.join(",")}`,
    }));
    const decision: import("../../components/project-acceptance/project-review-validator.js").ProjectReviewDecisionV1 = {
      schema_version: 1, id: `d_${projectId}`, project_card_id: projectId,
      review_case_id: (openCase as any).id, project_generation: supervision.generation,
      action: "accept",
      criteria: criterionVerdicts,
      outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
      contradictions: [],
      residual_risks: [],
      authored_at: new Date().toISOString(),
      synthesis: "All three workers completed",
    };

    const result = svc.processDecision(decision);
    expect(result.kind).toBe("accepted");

    // Terminal projection: the queued card becomes done with the bounded
    // synthesis, cleared stale error and retry backoff, and a completion stamp.
    const kanbanRow = reviewStore.db.prepare(
      "SELECT status, result_summary, error, next_retry_at, completed_at FROM kanban_board WHERE id = ?",
    ).get(projectId) as any;
    expect(kanbanRow.status).toBe("done");
    expect(kanbanRow.result_summary).toContain("completed");
    expect(kanbanRow.error).toBeNull();
    expect(kanbanRow.next_retry_at).toBeNull();
    expect(kanbanRow.completed_at).toBeTruthy();

    const journal = reviewStore.db.prepare(
      "SELECT from_status, to_status, actor FROM kanban_card_transitions WHERE card_id = ?",
    ).all(projectId) as any[];
    expect(journal).toEqual([{ from_status: "queued", to_status: "done", actor: "project_acceptance" }]);

    // Durable review state is terminal in the same transaction.
    expect(reviewStore.getSupervision(projectId)!.state).toBe("accepted");
    expect(reviewStore.getReviewCase((openCase as any).id)!.status).toBe("accepted");
    expect(reviewStore.getReviewRequestByCaseId((openCase as any).id)!.status).toBe("settled");

    // No legacy Orc dispatch for the review turn.
    expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "O", cardId: projectId }));

    mod.setOrcCoordinator(null);
  });
});

describe("Swarm acceptance — coverage gate (#1604)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    cards.clear();
    nextCardId = 100;
    await initDb();

    mod = await import("../../components/reconciler.js");
    const wss = await import("../../components/worker-supervision-store.js");
    WorkerSupervisionStore = wss.WorkerSupervisionStore;
    const prs = await import("../../components/project-acceptance/project-review-store.js");
    ProjectReviewStore = prs.ProjectReviewStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (_rawDb) { try { _rawDb.close(); } catch {} _rawDb = null; _overrideDb = null; }
  });

  /** Root with criteria c1-c3; only c1 and c2 mapped by terminal children → c3 gap. */
  async function createGapProject(): Promise<{ projectId: number; childIds: number[] }> {
    const { projectId, childIds } = await createProject();
    const store = new WorkerSupervisionStore();
    for (let i = 0; i < 2; i++) {
      const cId = await setupChildContract(store, childIds[i]!, projectId, `c${i + 1}`);
      await completeChild(store, childIds[i]!, cId, `c${i + 1}`);
    }
    // Third child exists but has no contract — a legitimate unsupervised
    // sibling, not a coverage fault.
    const third = cards.get(childIds[2]!);
    if (third) third.status = "done";
    return { projectId, childIds };
  }

  it("partial coverage dispatches exactly one coverage round and stays executing, spawn-eligible", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const { projectId } = await createGapProject();
    const reviewStore = new ProjectReviewStore();

    mod.requestReconcile(projectId);
    await flush();

    const sup = reviewStore.getSupervision(projectId)!;
    expect(sup.state).toBe("executing");
    expect(sup.coverage_rounds).toBe(1);
    expect(JSON.parse(sup.coverage_uncovered_ids!)).toEqual(["c3"]);
    expect(reviewStore.getLatestOpenCase(projectId)).toBeUndefined();
    const coverageClaims = claims.filter((c: any) => c.goal?.includes("[COVERAGE GAP]"));
    expect(coverageClaims.length).toBe(1);
  });

  it("identical signature with grace not elapsed: no second dispatch, no settle (tight loop)", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const { projectId } = await createGapProject();
    const reviewStore = new ProjectReviewStore();

    mod.requestReconcile(projectId);
    await flush();
    mod.requestReconcile(projectId);
    await flush();

    const sup = reviewStore.getSupervision(projectId)!;
    expect(sup.state).toBe("executing");
    expect(sup.coverage_rounds).toBe(1);
    const coverageClaims = claims.filter((c: any) => c.goal?.includes("[COVERAGE GAP]"));
    expect(coverageClaims.length).toBe(1);
  });

  it("identical signature with grace elapsed proceeds to review with the persisted gap (no terminal block)", async () => {
    const { projectId } = await createGapProject();
    const reviewStore = new ProjectReviewStore();

    mod.requestReconcile(projectId);
    await flush();

    // Age the supervision row past COVERAGE_ROUND_GRACE_MS (60s).
    reviewStore.db.prepare(`UPDATE project_supervision SET updated_at = ? WHERE project_card_id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), projectId);
    mod.requestReconcile(projectId);
    await flush();

    const sup = reviewStore.getSupervision(projectId)!;
    // #1605: an unchanged post-remediation gap is review evidence, not a gate
    expect(sup.state).toBe("review_requested");
    expect(JSON.parse(sup.coverage_uncovered_ids!)).toEqual(["c3"]);
    expect(reviewStore.getLatestOpenCase(projectId)).toBeDefined();
  });

  it("gap closed by a newly mapped child proceeds to normal review", async () => {
    const { projectId, childIds } = await createGapProject();
    const reviewStore = new ProjectReviewStore();

    mod.requestReconcile(projectId);
    await flush();
    expect(reviewStore.getSupervision(projectId)!.coverage_rounds).toBe(1);

    // Close the gap: give the third child a contract mapping c3, complete it.
    const store = new WorkerSupervisionStore();
    const cId = await setupChildContract(store, childIds[2]!, projectId, "c3");
    await completeChild(store, childIds[2]!, cId, "c3");

    mod.requestReconcile(projectId);
    await flush();

    const sup = reviewStore.getSupervision(projectId)!;
    expect(sup.state).toBe("review_requested");
    expect(sup.coverage_uncovered_ids).toBe("[]");
    expect(reviewStore.getLatestOpenCase(projectId)).toBeDefined();
  });

  it("coverage_rounds at the ceiling proceeds to review regardless of signature (cap is a loop guard)", async () => {
    const { projectId } = await createGapProject();
    const reviewStore = new ProjectReviewStore();
    reviewStore.db.prepare(`UPDATE project_supervision SET coverage_rounds = 3 WHERE project_card_id = ?`).run(projectId);

    mod.requestReconcile(projectId);
    await flush();

    const sup = reviewStore.getSupervision(projectId)!;
    // #1605: exhausted cap means the gap reaches review, never a terminal block
    expect(sup.state).toBe("review_requested");
    expect(JSON.parse(sup.coverage_uncovered_ids!)).toEqual(["c3"]);
    expect(reviewStore.getLatestOpenCase(projectId)).toBeDefined();
  });

  it("two rapid wakes claim exactly one coverage round (CAS at the gate)", async () => {
    const { projectId } = await createGapProject();
    const reviewStore = new ProjectReviewStore();

    mod.requestReconcile(projectId);
    mod.requestReconcile(projectId);
    await flush();

    expect(reviewStore.getSupervision(projectId)!.coverage_rounds).toBe(1);
  });
});

describe("Swarm acceptance — production contract shape (#1605)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    cards.clear();
    nextCardId = 100;
    await initDb();

    mod = await import("../../components/reconciler.js");
    const wss = await import("../../components/worker-supervision-store.js");
    WorkerSupervisionStore = wss.WorkerSupervisionStore;
    const prs = await import("../../components/project-acceptance/project-review-store.js");
    ProjectReviewStore = prs.ProjectReviewStore;
    const rca = await import("../../components/project-acceptance/project-review-case.js");
    ReviewCaseAssembler = rca.ReviewCaseAssembler;
    const prsvc = await import("../../components/project-acceptance/project-review-service.js");
    ProjectReviewService = prsvc.ProjectReviewService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (_rawDb) { try { _rawDb.close(); } catch {} _rawDb = null; _overrideDb = null; }
  });

  /**
   * Production-shaped v2 root contract: three delegated lane criteria (one
   * optional) + four Orc-owned synthesis criteria. One optional delegated lane
   * fails; the Orc accepts with the disclosed gap.
   */
  async function createProductionShapeProject(): Promise<{ projectId: number; laneIds: number[]; failedLaneId: number }> {
    const projectId = nextCardId++;
    const now = new Date().toISOString().replace(/Z$/, "");
    cards.set(projectId, {
      id: projectId, title: "daily-ai shape", source: "task",
      status: "running", type: "O", parent_id: null, goal: "Produce the daily briefing", notes: null,
      created_at: now, result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
    });

    const reviewStore = new ProjectReviewStore();
    reviewStore.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, goal, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, ?, ?)`).run(
      projectId, "daily-ai shape", "task", "Produce the daily briefing", now, now,
    );
    const rootContractId = `pc_${projectId}`;
    const rootContract = {
      schema_version: 2, id: rootContractId, project_card_id: projectId, digest: `d_${rootContractId}`,
      goal: "Produce the daily briefing",
      criteria: [
        { id: "lane1-feeds", description: "Feed research lane", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "lane2-newsletters", description: "Newsletter lane", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "lane3-web", description: "Web lane", required: false, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "synthesis", description: "Orc synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
        { id: "quality", description: "Final quality", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
        { id: "budget", description: "Budget discipline", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
        { id: "honest-stats", description: "Honest stats", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
      ],
      required_outputs: [{ id: "out", description: "briefing", kind: "file", required: true }],
      constraints: [], limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    };
    reviewStore.ensureAwaitingContract(projectId);
    reviewStore.insertContract(rootContract as any);
    reviewStore.stateTransition(projectId, ["awaiting_contract"], "executing");

    const laneIds: number[] = [];
    for (const [i, cid] of ["lane1-feeds", "lane2-newsletters", "lane3-web"].entries()) {
      const cId = nextCardId++;
      const createdAt = new Date().toISOString().replace(/Z$/, "");
      cards.set(cId, {
        id: cId, title: `lane ${i}`, source: "agent",
        status: "queued", type: "W", parent_id: projectId,
        goal: `lane ${i}`, notes: JSON.stringify({ supervised: true }),
        created_at: createdAt, priority: "MEDIUM",
        result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
      });
      reviewStore.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, parent_id, goal, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'W', ?, ?, ?, ?)`).run(
        cId, `lane ${i}`, "agent", projectId, `lane ${i}`, createdAt, createdAt,
      );
      laneIds.push(cId);
    }
    return { projectId, laneIds, failedLaneId: laneIds[2]! };
  }

  async function completeLane(store: import("../../components/worker-supervision-store.js").WorkerSupervisionStore, childId: number, rootCardId: number, criterionId: string): Promise<string> {
    const contract = makeChildContract(childId, rootCardId, criterionId);
    store.insertContract(contract, childId);
    store.insertAttempt({
      id: `a_${childId}_1`,
      card_id: childId,
      contract_id: contract.id,
      ordinal: 1,
      executor_kind: "agent",
      executor_id: "spin-local",
      status: "pending",
      started_at: new Date().toISOString(),
      root_project_card_id: rootCardId,
      root_project_generation: 1,
      scheduled_run_id: null,
    });
    await completeChild(store, childId, contract.id, criterionId);
    return contract.id;
  }

  async function failLane(store: import("../../components/worker-supervision-store.js").WorkerSupervisionStore, childId: number, rootCardId: number, criterionId: string): Promise<void> {
    const contract = makeChildContract(childId, rootCardId, criterionId);
    store.insertContract(contract, childId);
    store.insertAttempt({
      id: `a_${childId}_1`,
      card_id: childId,
      contract_id: contract.id,
      ordinal: 1,
      executor_kind: "agent",
      executor_id: "spin-local",
      status: "failed",
      started_at: new Date().toISOString(),
      root_project_card_id: rootCardId,
      root_project_generation: 1,
      scheduled_run_id: null,
    });
    const card = cards.get(childId);
    if (card) card.status = "failed";
  }

  it("reaches review without any coverage turn for Orc-owned criteria, with the failed optional lane in the case", async () => {
    const { projectId, laneIds, failedLaneId } = await createProductionShapeProject();
    const store = new WorkerSupervisionStore();
    await completeLane(store, laneIds[0]!, projectId, "lane1-feeds");
    await completeLane(store, laneIds[1]!, projectId, "lane2-newsletters");
    await failLane(store, failedLaneId, projectId, "lane3-web");

    mod.requestReconcile(projectId);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    const reviewStore = new ProjectReviewStore();
    const sup = reviewStore.getSupervision(projectId)!;
    expect(sup.state).toBe("review_requested");

    // Orc-owned criteria are covered by the Orc — no coverage rounds, no gaps
    expect(sup.coverage_rounds).toBe(0);
    expect(JSON.parse(sup.coverage_uncovered_ids ?? "[]")).toEqual([]);

    const coverageDispatches = dispatchMock.mock.calls.filter((c: any) => c[0]?.goal?.includes("[COVERAGE GAP]"));
    expect(coverageDispatches).toHaveLength(0);

    const openCase = reviewStore.getLatestOpenCase(projectId);
    expect(openCase).toBeDefined();
    const snap = JSON.parse((openCase as any).case_json) as any;
    // failed optional lane is durable evidence
    const lane3Summary = snap.child_summaries.find((s: any) => s.card_id === failedLaneId);
    expect(lane3Summary).toBeDefined();
    expect(lane3Summary.outcome).toContain("failed");
    // orc_owned hints present
    const synthesisInput = snap.criterion_inputs.find((ci: any) => ci.criterion_id === "synthesis");
    expect(synthesisInput.coverage_hint).toBe("orc_owned");
    expect(synthesisInput.execution_owner).toBe("orc");
  });

  it("accepts with the canonical Known gaps disclosure in the delivered synthesis", async () => {
    const { projectId, laneIds, failedLaneId } = await createProductionShapeProject();
    const store = new WorkerSupervisionStore();
    await completeLane(store, laneIds[0]!, projectId, "lane1-feeds");
    await completeLane(store, laneIds[1]!, projectId, "lane2-newsletters");
    await failLane(store, failedLaneId, projectId, "lane3-web");

    mod.requestReconcile(projectId);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    const reviewStore = new ProjectReviewStore();
    const openCase = reviewStore.getLatestOpenCase(projectId);
    expect(openCase).toBeDefined();
    const supervision = reviewStore.getSupervision(projectId) as any;
    const snap = JSON.parse((openCase as any).case_json) as any;

    const verdicts = snap.criterion_inputs.map((ci: any) => {
      if (ci.criterion_id === "lane3-web") {
        return { criterion_id: ci.criterion_id, verdict: "unsatisfied", evidence_ids: [], rationale: "web lane failed; briefing remains useful" };
      }
      if (ci.execution_owner === "orc") {
        return { criterion_id: ci.criterion_id, verdict: "satisfied", evidence_ids: [], rationale: `Orc-owned: ${ci.criterion_id} evaluated in review` };
      }
      return { criterion_id: ci.criterion_id, verdict: "satisfied", evidence_ids: ci.observed_evidence_ids.length > 0 ? [ci.observed_evidence_ids[0]!] : [], rationale: "lane passed" };
    });

    const decision: import("../../components/project-acceptance/project-review-validator.js").ProjectReviewDecisionV1 = {
      schema_version: 1, id: `d_${projectId}`, project_card_id: projectId,
      review_case_id: (openCase as any).id, project_generation: supervision.generation,
      action: "accept",
      criteria: verdicts,
      outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
      contradictions: [],
      residual_risks: [],
      authored_at: new Date().toISOString(),
      synthesis: "Daily briefing delivered with all required lanes.",
    };

    const svc = new ProjectReviewService();
    const result = svc.processDecision(decision);
    expect(result.kind).toBe("accepted");

    const updated = reviewStore.getSupervision(projectId) as any;
    expect(updated.state).toBe("accepted");

    // delivered synthesis carries the deterministic Known gaps section
    const kanbanRow = reviewStore.db.prepare("SELECT status, result_summary FROM kanban_board WHERE id = ?").get(projectId) as any;
    expect(kanbanRow.status).toBe("done");
    expect(kanbanRow.result_summary).toContain("Daily briefing delivered");
    expect(kanbanRow.result_summary).toContain("Known gaps:");
    expect(kanbanRow.result_summary).toContain("lane3-web: unsatisfied");

    // the authored decision keeps the original synthesis (no prose mutating)
    const decisionRow = reviewStore.getDecision(updated.accepted_decision_id);
    const parsed = JSON.parse((decisionRow as any).decision_json) as any;
    expect(parsed.synthesis).toBe("Daily briefing delivered with all required lanes.");
  });
});

describe("Swarm acceptance — Scenario B: one remote contribution (#927)", () => {
  let contributionStore: import("../../components/peer-help/contribution-store.js").ContributionStore;
  let peerHelpService: import("../../components/peer-help/service.js").PeerHelpService;
  let reconcilerMod: typeof import("../../components/reconciler.js");
  let ProjectReviewStore: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
  let ReviewCaseAssembler: typeof import("../../components/project-acceptance/project-review-case.js").ReviewCaseAssembler;
  let ProjectReviewService: typeof import("../../components/project-acceptance/project-review-service.js").ProjectReviewService;

  beforeEach(async () => {
    vi.clearAllMocks();
    cards.clear();
    nextCardId = 100;
    await initDb();

    reconcilerMod = await import("../../components/reconciler.js");
    const prs = await import("../../components/project-acceptance/project-review-store.js");
    ProjectReviewStore = prs.ProjectReviewStore;
    const rca = await import("../../components/project-acceptance/project-review-case.js");
    ReviewCaseAssembler = rca.ReviewCaseAssembler;
    const prsvc = await import("../../components/project-acceptance/project-review-service.js");
    ProjectReviewService = prsvc.ProjectReviewService;

    const { ContributionStore } = await import("../../components/peer-help/contribution-store.js");
    const { PeerHelpService } = await import("../../components/peer-help/service.js");
    const { PeerHelpStore } = await import("../../components/peer-help/store.js");
    const kb = await import("../../components/tasks/kanban-board.js");

    const kanbanMock = {
      kanbanGetCard: (id: number) => {
        const card = cards.get(id);
        if (card) return card;
        const row = _overrideDb!.prepare("SELECT * FROM kanban_board WHERE id = ?").get(id) as any;
        if (row) { cards.set(id, row); return row; }
        return undefined;
      },
      kanbanUpdate: vi.fn(),
      kanbanComplete: (id: number, _result: string | null, summary: string) =>
        kb.kanbanComplete(id, _result, summary),
      kanbanFail: (id: number, error: string) => kb.kanbanFail(id, error),
    };

    contributionStore = new ContributionStore(_overrideDb, kanbanMock);
    const peerHelpStore = new PeerHelpStore(_rawDb, kanbanMock, { fire: vi.fn() });
    peerHelpService = new PeerHelpService(peerHelpStore, () => []);
    peerHelpService.setContributionStore(contributionStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (_rawDb) { try { _rawDb.close(); } catch {} _rawDb = null; _overrideDb = null; }
  });

  function createScenarioProject(): number {
    const projectId = nextCardId++;
    const now = new Date().toISOString().replace(/Z$/, "");
    cards.set(projectId, {
      id: projectId, title: "remote contribution project", source: "user",
      status: "running", type: "O", parent_id: null, goal: "Contribution project", notes: null,
      created_at: now, result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
    });

    const reviewStore = new ProjectReviewStore();
    reviewStore.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, goal, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, ?, ?)`).run(
      projectId, "remote contribution project", "user", "Contribution project", now, now,
    );

    const rootContractId = `pc_${projectId}`;
    const rootContract = {
      schema_version: 1, id: rootContractId, project_card_id: projectId, digest: `d_${rootContractId}`,
      goal: "Contribution project",
      criteria: [{ id: "c1", description: "Remote contribution received and reviewed", required: true, evidence_expectation: "observed" }],
      required_outputs: [{ id: "out", description: "result", kind: "file", required: true }],
      constraints: [], limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    };
    reviewStore.ensureAwaitingContract(projectId);
    reviewStore.insertContract(rootContract as any);
    reviewStore.stateTransition(projectId, ["awaiting_contract"], "executing");

    return projectId;
  }

  function makeContributionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
      version: 1,
      event_id: `evt_molty_completed_${Date.now()}`,
      sequence: 0,
      request_id: "req-scenario-b",
      contribution_ref: "help_molty_ref",
      kind: "completed",
      occurred_at: now,
      summary: "Molty completed the analysis",
      projection: {
        schema_version: 1,
        outcome: "completed",
        summary: "Molty completed the analysis",
        evidence: [{ id: "check_1", kind: "check", summary: "analysis ok", observed_by: "molty" }],
        artifacts: [{ name: "report.md", content_type: "text/markdown", size_bytes: 1024, ref: "report.md" }],
        provenance: { receiver_peer: "molty", receiver_project_ref: "proj_molty_1", acceptance_id: "accept_molty_1", accepted_at: now },
      },
      ...overrides,
    };
  }

  function setupContribution(projectId: number): number {
    const result = contributionStore.reserveProxy({
      peer: "molty",
      requestId: "req-scenario-b",
      requestHash: "hash_scenario_b",
      projectCardId: projectId,
      title: "[help:molty] analysis",
      goal: "analyze data",
      priority: "MEDIUM",
      sourcePeer: "molty",
      notes: { peer: "molty", root_criteria: ["c1"], request_id: "req-scenario-b", outcome: "pending" },
    });
    expect(result.status).toBe("new");
    expect(result.proxyCardId).toBeGreaterThan(0);
    const pid = result.proxyCardId!;
    const row = _rawDb.prepare("SELECT * FROM kanban_board WHERE id = ?").get(pid) as Record<string, unknown>;
    if (row) cards.set(pid, { id: pid, ...row });
    contributionStore.adoptContributionRef("molty", "req-scenario-b", "help_molty_ref");
    contributionStore.transitionToAccepted("molty", "req-scenario-b");
    return pid;
  }

  it("project-linked contribution is reserved with root_criteria and project_card_id", async () => {
    const projectId = createScenarioProject();
    const proxyCardId = setupContribution(projectId);

    const contrib = contributionStore.getContribution("molty", "req-scenario-b");
    expect(contrib).toBeDefined();
    expect(contrib!.project_card_id).toBe(projectId);
    expect(contrib!.state).toBe("accepted");
    expect(contrib!.root_criteria_json).toBe('["c1"]');

    const proxyCard = cards.get(proxyCardId);
    expect(proxyCard).toBeDefined();
    expect(proxyCard!.type).toBe("contribution");
    expect(proxyCard!.status).toBe("running");
    expect(proxyCard!.parent_id).toBe(projectId);
  });

  it("terminal event completes contribution proxy card and wakes Reconciler", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const projectId = createScenarioProject();
    setupContribution(projectId);

    const event = makeContributionEvent();
    const handleResult = await peerHelpService.handleContributionEvent("molty", event);
    expect(handleResult.ok).toBe(true);

    const contrib = contributionStore.getContribution("molty", "req-scenario-b");
    expect(contrib!.state).toBe("completed");
    expect(contrib!.projection_json).toBeTruthy();

    const contribEvents = _rawDb.prepare(
      "SELECT COUNT(*) as cnt FROM peer_contribution_events WHERE peer = ? AND request_id = ?",
    ).get("molty", "req-scenario-b") as any;
    expect(Number(contribEvents.cnt)).toBe(1);

    await flush();

    // the supervised root is claimed by the Orc coordinator (coverage or
    // review) — never legacy-dispatched (#1618)
    expect(claims.some(c => c.pid === projectId)).toBe(true);
  });

  it("review case assembler includes peer_contributions with root_criteria and provenance", async () => {
    const projectId = createScenarioProject();
    setupContribution(projectId);

    await peerHelpService.handleContributionEvent("molty", makeContributionEvent());
    dispatchMock.mockClear();

    reconcilerMod.requestReconcile(projectId);
    await flush();

    const reviewStore = new ProjectReviewStore();
    const supervision = reviewStore.getSupervision(projectId) as any;
    expect(supervision).not.toBeNull();
    expect(supervision.state).toBe("review_requested");

    const snapshot = await new ReviewCaseAssembler().assembleCase(
      projectId, supervision.generation, supervision.review_round,
    );
    expect("error" in snapshot).toBe(false);
    const snap = snapshot as any;
    expect(Array.isArray(snap.peer_contributions)).toBe(true);
    expect(snap.peer_contributions.length).toBeGreaterThanOrEqual(1);

    const moltyEntry = snap.peer_contributions.find((c: any) => c.peer === "molty");
    expect(moltyEntry).toBeDefined();
    expect(moltyEntry.outcome).toBe("completed");
    expect(moltyEntry.projection_summary).toContain("Molty completed the analysis");
    expect(Array.isArray(moltyEntry.root_criteria)).toBe(true);
    expect(moltyEntry.root_criteria).toContain("c1");
    expect(typeof moltyEntry.provenance).toBe("string");
  });

  it("duplicate terminal event is idempotent (no duplicate reconcile)", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const projectId = createScenarioProject();
    setupContribution(projectId);
    claims.length = 0;

    const event = makeContributionEvent();
    const first = await peerHelpService.handleContributionEvent("molty", event);
    expect(first.ok).toBe(true);

    const second = await peerHelpService.handleContributionEvent("molty", event);
    expect(second.ok).toBe(true);

    const contribEvents = _rawDb.prepare(
      "SELECT COUNT(*) as cnt FROM peer_contribution_events WHERE peer = ? AND request_id = ?",
    ).get("molty", "req-scenario-b") as any;
    expect(Number(contribEvents.cnt)).toBe(1);

    await flush();

    // exactly one coordinator claim for the project — the duplicate event
    // never wakes a second claim
    expect(claims.filter(c => c.pid === projectId)).toHaveLength(1);
  });

  it("declined contribution state is set and proxy card fails cleanly", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const projectId = createScenarioProject();
    const result = contributionStore.reserveProxy({
      peer: "molty",
      requestId: "req-scenario-b-declined",
      requestHash: "hash_decline",
      projectCardId: projectId,
      title: "[help:molty] analysis",
      goal: "analyze data",
      priority: "MEDIUM",
      sourcePeer: "molty",
      notes: { peer: "molty", root_criteria: ["c1"], request_id: "req-scenario-b-declined", outcome: "pending" },
    });
    expect(result.status).toBe("new");
    contributionStore.transitionToNonStarted("molty", "req-scenario-b-declined", "declined");

    const contrib = contributionStore.getContribution("molty", "req-scenario-b-declined");
    expect(contrib!.state).toBe("declined");

    const proxyCard = cards.get(result.proxyCardId!);
    if (proxyCard) proxyCard.status = "failed";

    reconcilerMod.requestReconcile(projectId);
    await flush();

    const supervision = new ProjectReviewStore().getSupervision(projectId) as any;
    expect(supervision).toBeDefined();
    expect(["executing", "review_ready", "review_requested"].includes(supervision.state)).toBe(true);
  });
});

describe("Swarm acceptance — escaped Orc review journeys (#1620)", () => {
  let ProjectReviewStore: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
  let WorkerSupervisionStore: typeof import("../../components/worker-supervision-store.js").WorkerSupervisionStore;
  let mod: typeof import("../../components/reconciler.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    cards.clear();
    nextCardId = 100;
    await initDb();

    mod = await import("../../components/reconciler.js");
    const prs = await import("../../components/project-acceptance/project-review-store.js");
    ProjectReviewStore = prs.ProjectReviewStore;
    const wss = await import("../../components/worker-supervision-store.js");
    WorkerSupervisionStore = wss.WorkerSupervisionStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (_rawDb) { try { _rawDb.close(); } catch {} _rawDb = null; _overrideDb = null; }
  });

  const reviewProjectTool = () => getOrcTools().find(t => t.name === "review_project")!;
  const reviewCaseTool = () => getOrcTools().find(t => t.name === "get_project_review_case")!;
  const orcCtx = (pid: number) => ({ userId: "test", orcContext: { projectCardId: pid, projectGeneration: 1 } } as any);

  function insertRoot(projectId: number, title: string, contract: Record<string, unknown>): void {
    const now = new Date().toISOString().replace(/Z$/, "");
    cards.set(projectId, {
      id: projectId, title, source: "user",
      status: "running", type: "O", parent_id: null, goal: contract.goal, notes: null,
      created_at: now, result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
    });
    const reviewStore = new ProjectReviewStore();
    reviewStore.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, goal, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, ?, ?)`).run(
      projectId, title, "user", contract.goal, now, now,
    );
    reviewStore.ensureAwaitingContract(projectId);
    reviewStore.insertContract(contract as any);
    reviewStore.stateTransition(projectId, ["awaiting_contract"], "executing");
  }

  async function completeChild(store: import("../../components/worker-supervision-store.js").WorkerSupervisionStore, childId: number, contractId: string, rootCriterionId: string): Promise<void> {
    const attemptId = `a_${childId}_1`;
    store.lifecycleTransition(attemptId, ["pending"], "running", { settled_at: null });
    const env = makeEnvelope(childId, contractId, rootCriterionId);
    store.completeAttempt(attemptId);
    store.insertResult(attemptId, env);
    const card = cards.get(childId);
    if (card) card.status = "done";
  }

  async function setupChildContract(store: import("../../components/worker-supervision-store.js").WorkerSupervisionStore, childId: number, rootCardId: number, criterionId: string): Promise<string> {
    const contract = makeChildContract(childId, rootCardId, criterionId);
    store.insertContract(contract, childId);
    store.insertAttempt({
      id: `a_${childId}_1`,
      card_id: childId,
      contract_id: contract.id,
      ordinal: 1,
      executor_kind: "agent",
      executor_id: "spin-local",
      status: "pending",
      started_at: new Date().toISOString(),
      root_project_card_id: rootCardId,
      root_project_generation: 1,
      scheduled_run_id: null,
    });
    return contract.id;
  }

  async function addWorkerChild(projectId: number, criterionId: string): Promise<void> {
    const cId = nextCardId++;
    const createdAt = new Date().toISOString().replace(/Z$/, "");
    cards.set(cId, {
      id: cId, title: `worker ${cId}`, source: "agent",
      status: "queued", type: "W", parent_id: projectId,
      goal: `worker ${cId}`, notes: JSON.stringify({ supervised: true }),
      created_at: createdAt, priority: "MEDIUM",
      result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
    });
    new ProjectReviewStore().db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, parent_id, goal, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'W', ?, ?, ?, ?)`).run(
      cId, `worker ${cId}`, "agent", projectId, `worker ${cId}`, createdAt, createdAt,
    );
    const store = new WorkerSupervisionStore();
    const contractId = await setupChildContract(store, cId, projectId, criterionId);
    await completeChild(store, cId, contractId, criterionId);
  }

  it("Molty 54 shape: Orc-only root reads its case and submits one typed accept", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const projectId = nextCardId++;
    const rootContract = {
      schema_version: 2, id: `pc_${projectId}`, project_card_id: projectId, digest: `d_${projectId}`,
      goal: "Produce the analysis",
      criteria: [
        { id: "synth1", description: "Synthesize findings", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
        { id: "synth2", description: "Quality gate", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
      ],
      required_outputs: [{ id: "out", description: "analysis report", kind: "file", required: true }],
      constraints: [], limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    };
    insertRoot(projectId, "orc-only analysis", rootContract);

    mod.requestReconcile(projectId);
    await flush();

    const reviewStore = new ProjectReviewStore();
    const sup = reviewStore.getSupervision(projectId)!;
    // Orc-owned criteria need no coverage round and no children
    expect(sup.state).toBe("review_requested");
    expect(sup.coverage_rounds).toBe(0);
    const openCase = reviewStore.getLatestOpenCase(projectId);
    expect(openCase).toBeDefined();

    // the Orc reads the immutable case first — no private SQL needed
    const briefRaw = await reviewCaseTool().execute(
      { project_card_id: projectId, review_case_id: (openCase as any).id }, orcCtx(projectId),
    );
    const brief = JSON.parse(briefRaw) as any;
    expect(brief.schema_version).toBe(1);
    expect(brief.criteria.every((c: any) => c.execution_owner === "orc")).toBe(true);
    expect(brief.outputs.some((o: any) => o.output_id === "out" && o.required)).toBe(true);
    expect(brief.legal_values.output_dispositions).toContain("remote_only");

    const resultRaw = await reviewProjectTool().execute({
      action: "accept",
      project_card_id: projectId,
      project_generation: sup.generation,
      review_case_id: (openCase as any).id,
      criteria: [
        { criterion_id: "synth1", verdict: "satisfied", evidence_ids: [], rationale: "Synthesized from the immutable case" },
        { criterion_id: "synth2", verdict: "satisfied", evidence_ids: [], rationale: "Quality gate passed on Orc evaluation" },
      ],
      outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
      contradictions: [],
      residual_risks: [],
      synthesis: "Analysis complete",
    }, orcCtx(projectId));

    const result = JSON.parse(resultRaw) as { outcome: string };
    expect(result.outcome).toBe("accepted");

    const settled = reviewStore.getSupervision(projectId)!;
    expect(settled.state).toBe("accepted");
    const kanbanRow = reviewStore.db.prepare("SELECT status FROM kanban_board WHERE id = ?").get(projectId) as any;
    expect(kanbanRow.status).toBe("done");
  });

  it("KP 24 shape: requester root with failed peer claim and delegated gap blocks for the authored reason", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const projectId = nextCardId++;
    const rootContract = {
      schema_version: 2, id: `pc_${projectId}`, project_card_id: projectId, digest: `d_${projectId}`,
      goal: "Deliver the analysis",
      criteria: [
        { id: "c1", description: "Peer lane", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "c2", description: "Local synthesis", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
      ],
      required_outputs: [{ id: "out", description: "result", kind: "file", required: true }],
      constraints: [], limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    };
    insertRoot(projectId, "requester analysis", rootContract);

    // c1 is covered by a completed local child; c2 stays uncovered
    await addWorkerChild(projectId, "c1");

    // the peer contribution failed — a durable claim, not requester evidence
    _overrideDb!.exec(`
      CREATE TABLE IF NOT EXISTS peer_contributions (
        peer TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        contribution_ref TEXT NOT NULL,
        project_card_id INTEGER,
        proxy_card_id INTEGER,
        root_criteria_json TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','accepted','running','completed','failed','declined','deferred','unknown','withdrawal_noted')),
        last_sequence INTEGER NOT NULL DEFAULT -1,
        terminal_event_id TEXT,
        terminal_digest TEXT,
        projection_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (peer, request_id),
        UNIQUE (contribution_ref)
      );
    `);
    const proxyId = nextCardId++;
    const now = new Date().toISOString().replace(/Z$/, "");
    new ProjectReviewStore().db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, parent_id, goal, source_peer, created_at, updated_at) VALUES (?, ?, 'peer', 'failed', 'contribution', ?, ?, 'molty', ?, ?)`).run(
      proxyId, "[help:molty] analysis", projectId, "analyze data", now, now,
    );
    _overrideDb!.prepare(`INSERT INTO peer_contributions (peer, request_id, request_hash, contribution_ref, project_card_id, proxy_card_id, root_criteria_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', datetime('now'), datetime('now'))`).run(
      "molty", "req-kp24", "hash_kp24", "help_ref_kp24", projectId, proxyId, JSON.stringify(["c1"]),
    );

    mod.requestReconcile(projectId);
    await flush();
    // the c2 gap goes through a coverage round, then reaches review after grace
    const reviewStore = new ProjectReviewStore();
    expect(reviewStore.getSupervision(projectId)!.coverage_rounds).toBe(1);
    reviewStore.db.prepare(`UPDATE project_supervision SET updated_at = ? WHERE project_card_id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), projectId);
    mod.requestReconcile(projectId);
    await flush();

    const sup = reviewStore.getSupervision(projectId)!;
    expect(sup.state).toBe("review_requested");
    const openCase = reviewStore.getLatestOpenCase(projectId);
    expect(openCase).toBeDefined();

    const briefRaw = await reviewCaseTool().execute(
      { project_card_id: projectId, review_case_id: (openCase as any).id }, orcCtx(projectId),
    );
    const brief = JSON.parse(briefRaw) as any;
    expect(brief.uncovered_criteria).toContain("c2");
    // the failed peer contribution is a labeled claim, never compatible evidence
    expect(brief.peer_claims.length).toBeGreaterThanOrEqual(1);
    expect(brief.peer_claims[0].outcome).toBe("failed");
    const c1 = brief.criteria.find((c: any) => c.criterion_id === "c1");
    expect(c1.compatible_evidence.observed).not.toContain("help_ref_kp24");

    const resultRaw = await reviewProjectTool().execute({
      action: "blocked",
      project_card_id: projectId,
      project_generation: sup.generation,
      review_case_id: (openCase as any).id,
      criteria: [
        { criterion_id: "c1", verdict: "satisfied", evidence_ids: c1.compatible_evidence.observed, rationale: "local lane passed" },
        { criterion_id: "c2", verdict: "unsatisfied", evidence_ids: [], rationale: "peer contribution failed; no local lane covered this criterion" },
      ],
      outputs: [{ output_id: "out", disposition: "missing", evidence_ids: [] }],
      contradictions: [],
      residual_risks: [],
      synthesis: "Cannot complete without the failed criterion",
      blocker: { blocker_class: "peer_contribution_failed", affected_criterion_ids: ["c2"], what_was_attempted: "waited for molty contribution" },
    }, orcCtx(projectId));

    const result = JSON.parse(resultRaw) as { outcome: string; summary: string };
    expect(result.outcome).toBe("blocked");
    expect(result.summary).toContain("peer_contribution_failed");
    expect(result.summary).not.toContain("review_protocol_exhausted");

    const settled = reviewStore.getSupervision(projectId)!;
    expect(settled.state).toBe("blocked");
    expect(settled.blocked_reason).toBe("peer_contribution_failed");
    expect(reviewStore.getDecision(settled.accepted_decision_id!)).toBeDefined();
  });

  it("ordinary non-peer supervised project uses the same tools and enums", async () => {
    const claims: Array<{ kind: string; pid: number; goal?: string }> = [];
    installFakeCoordinator(claims);
    const projectId = nextCardId++;
    const now = new Date().toISOString().replace(/Z$/, "");
    cards.set(projectId, {
      id: projectId, title: "ordinary project", source: "task",
      status: "running", type: "O", parent_id: null, goal: "Produce three summaries", notes: null,
      created_at: now, result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
    });
    const reviewStore = new ProjectReviewStore();
    reviewStore.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, goal, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, ?, ?)`).run(
      projectId, "ordinary project", "task", "Produce three summaries", now, now,
    );
    const rootContract = {
      schema_version: 1, id: `pc_${projectId}`, project_card_id: projectId, digest: `d_${projectId}`,
      goal: "Produce three summaries",
      criteria: [
        { id: "c1", description: "Worker 1", required: true, evidence_expectation: "observed" },
        { id: "c2", description: "Worker 2", required: true, evidence_expectation: "observed" },
      ],
      required_outputs: [{ id: "out", description: "summaries", kind: "file", required: true }],
      constraints: [], limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    };
    reviewStore.ensureAwaitingContract(projectId);
    reviewStore.insertContract(rootContract as any);
    reviewStore.stateTransition(projectId, ["awaiting_contract"], "executing");
    await addWorkerChild(projectId, "c1");
    await addWorkerChild(projectId, "c2");

    mod.requestReconcile(projectId);
    await flush();

    const sup = reviewStore.getSupervision(projectId)!;
    expect(sup.state).toBe("review_requested");
    const openCase = reviewStore.getLatestOpenCase(projectId);
    expect(openCase).toBeDefined();

    const briefRaw = await reviewCaseTool().execute(
      { project_card_id: projectId, review_case_id: (openCase as any).id }, orcCtx(projectId),
    );
    const brief = JSON.parse(briefRaw) as any;
    expect(brief.peer_claims).toHaveLength(0);

    const verdicts = brief.criteria.map((c: any) => ({
      criterion_id: c.criterion_id,
      verdict: "satisfied",
      evidence_ids: c.compatible_evidence.observed.slice(0, 1),
      rationale: "lane passed",
    }));
    const resultRaw = await reviewProjectTool().execute({
      action: "accept",
      project_card_id: projectId,
      project_generation: sup.generation,
      review_case_id: (openCase as any).id,
      criteria: verdicts,
      outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
      contradictions: [],
      residual_risks: [],
      synthesis: "All workers completed",
    }, orcCtx(projectId));

    const result = JSON.parse(resultRaw) as { outcome: string };
    expect(result.outcome).toBe("accepted");
    expect(reviewStore.getSupervision(projectId)!.state).toBe("accepted");
  });
});
