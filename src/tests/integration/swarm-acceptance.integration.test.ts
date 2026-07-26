import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskDatabase } from "../../components/tasks/kanban-board.js";

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
vi.mock("../../components/tasks/kanban-board.js", () => ({
  kanbanEnqueue: (title: string, source: string, opts?: any) => {
    const id = nextCardId++;
    const card: any = { id, title, source, status: "queued", type: "W", parent_id: null, goal: null, notes: null, created_at: new Date().toISOString().replace(/Z$/, ""), result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null };
    if (opts) { if (opts.type) card.type = opts.type; if (opts.parent_id) card.parent_id = opts.parent_id; if (opts.notes) card.notes = opts.notes; }
    cards.set(id, card);
    return id;
  },
  kanbanGetCard: (id: number) => { const c = cards.get(id); return c ?? null; },
  kanbanGetChildren: (parentId: number) => Array.from(cards.values()).filter((c: any) => c.parent_id === parentId),
  kanbanRunning: (id: number) => { const c = cards.get(id); if (c) c.status = "running"; },
  kanbanComplete: (id: number) => { const c = cards.get(id); if (c) c.status = "done"; },
  kanbanFail: (id: number, reason?: string) => { const c = cards.get(id); if (c) { c.status = "failed"; c.error = reason ?? "failed"; } },
  kanbanUpdate: vi.fn(),
  cascadeFail: vi.fn(),
  isUnblocked: () => true,
  resolveRootId: (id: number) => id,
  requireTaskDatabase: () => { if (!_overrideDb) throw new Error("_overrideDb not set — call initDb() in beforeEach"); return _overrideDb; },
}));

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
}

describe("Swarm acceptance — Scenario A: three local workers (#927)", () => {
  let mod: typeof import("../../components/reconciler.js");
  let WorkerSupervisionStore: typeof import("../../components/worker-supervision-store.js").WorkerSupervisionStore;
  let WorkerSupervisionService: typeof import("../../components/worker-supervision-service.js").WorkerSupervisionService;
  let ProjectReviewStore: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
  let ReviewCaseAssembler: typeof import("../../components/project-acceptance/project-review-case.js").ReviewCaseAssembler;
  let ProjectReviewService: typeof import("../../components/project-acceptance/project-review-service.js").ProjectReviewService;

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
      delivery_mode TEXT DEFAULT 'deliver'
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
      attempt: { id: `a_${childId}_1`, ordinal: 1, contract_id: contractId, contract_digest: `d_${contractId}`, executor_kind: "local_worker", executor_id: "spin-local", started_at: now, finished_at: now },
      outcome: "completed",
      criteria: [{ criterion_id: rootCriterionId, status: "passed", evidence_ids: [`chk_${childId}`] }],
      checks: [{ check_id: `chk_${childId}`, argv: ["echo", "ok"], started_at: now, finished_at: now, timed_out: false, exit_code: 0, signal: null, stdout_excerpt: "ok", stderr_excerpt: "" }],
      artifacts: [{ artifact_id: `art_${childId}`, exists: true, kind: "file", ref: `out_${childId}`, size: 42 }],
      worker_report: { summary: `Worker ${childId} ok`, claims: [], unresolved_risks: [] },
    };
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
        { id: "c1", description: "Worker 1 completes", evidence_expectation: "observed" },
        { id: "c2", description: "Worker 2 completes", evidence_expectation: "observed" },
        { id: "c3", description: "Worker 3 completes", evidence_expectation: "observed" },
      ],
      required_outputs: [{ id: "out", description: "summaries", kind: "file", required: true }],
      constraints: [], limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { root_card_id: projectId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    reviewStore.ensureAwaitingContract(projectId);
    reviewStore.insertContract(rootContract as any);
    reviewStore.stateTransition(projectId, ["awaiting_contract"], "executing");

    const childIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cId = nextCardId++;
      cards.set(cId, {
        id: cId, title: `worker ${i}`, source: "agent",
        status: "queued", type: "W", parent_id: projectId,
        goal: `summary ${i}`, notes: JSON.stringify({ supervised: true }),
        created_at: new Date().toISOString().replace(/Z$/, ""),
        result_summary: null, delivery_attempts: 0, max_tokens: null, tokens_used: null,
      });
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

  it("all-terminal children trigger ReviewCaseAssembler with real structured results and Orc dispatch", async () => {
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

    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "O", cardId: projectId }),
    );
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
});
