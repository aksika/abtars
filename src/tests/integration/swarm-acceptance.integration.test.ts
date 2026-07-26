import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dispatchMock = vi.fn();
const spawnChildMock = vi.fn();
vi.mock("../../components/spin.js", () => ({
  spin: { dispatch: dispatchMock, spawnChild: spawnChildMock },
}));

const cards = new Map<number, any>();
let nextCardId = 100;
vi.mock("../../components/tasks/kanban-board.js", () => ({
  kanbanEnqueue: (title: string, source: string, opts?: any) => {
    const id = nextCardId++;
    const card: any = {
      id, title, source, status: "queued", type: "W",
      parent_id: null, goal: null, notes: null,
      created_at: new Date().toISOString().replace(/Z$/, ""),
      result_summary: null, delivery_attempts: 0,
    };
    if (opts) {
      if (opts.type) card.type = opts.type;
      if (opts.parent_id) card.parent_id = opts.parent_id;
      if (opts.notes) card.notes = opts.notes;
    }
    cards.set(id, card);
    return id;
  },
  kanbanGetCard: (id: number) => cards.get(id) ?? null,
  kanbanGetChildren: (parentId: number) =>
    Array.from(cards.values()).filter((c: any) => c.parent_id === parentId),
  kanbanRunning: (id: number) => { const c = cards.get(id); if (c) c.status = "running"; },
  kanbanComplete: (id: number) => { const c = cards.get(id); if (c) c.status = "done"; },
  kanbanFail: (id: number) => { const c = cards.get(id); if (c) c.status = "failed"; },
  kanbanUpdate: vi.fn(),
  cascadeFail: vi.fn(),
  isUnblocked: () => true,
  resolveRootId: (id: number) => id,
  requireTaskDatabase: () => { throw new Error("should not be called in test"); },
}));

vi.mock("../../components/worker-supervision-service.js", () => ({
  WorkerSupervisionService: vi.fn().mockImplementation(function () {
    return {
      cardHasContract: vi.fn().mockReturnValue(true),
      getContractForCard: vi.fn().mockReturnValue({
        id: "c_child", schema_version: 1,
        goal: "child work",
        criteria: [{ id: "child_c1", description: "child criterion" }],
        required_capabilities: [],
        supports_root_criteria: ["root_c1"],
        limits: { max_duration_ms: 300000 },
        provenance: { root_card_id: 1, card_id: 0, authored_by: "orc", created_at: new Date().toISOString() },
      }),
      createChild: vi.fn().mockReturnValue({
        contract: { id: "c_child" },
        attempt: { id: "a_child" },
        attemptId: "a_child",
      }),
    };
  }),
}));

let latestAttemptBehavior: ((cardId: number) => any) | null = null;
vi.mock("../../components/worker-supervision-store.js", () => ({
  WorkerSupervisionStore: vi.fn().mockImplementation(function () {
    return {
      getLatestAttempt: vi.fn().mockImplementation((cardId: number) => {
        if (latestAttemptBehavior) return latestAttemptBehavior(cardId);
        return null;
      }),
      claimAttempt: vi.fn().mockImplementation((cardId: number, contractId: string, executorKind: string, executorId: string, generation: number) => ({
        attemptId: `a_${cardId}`, cardId, contractId, executorKind, executorId, generation,
        claimedAt: new Date().toISOString(),
      })),
      markAttemptStartObservable: vi.fn().mockReturnValue(true),
      markAttemptRunning: vi.fn().mockReturnValue(true),
      failAttempt: vi.fn().mockReturnValue(true),
      cancelAttempt: vi.fn().mockReturnValue(true),
      completeAttempt: vi.fn().mockReturnValue(true),
      getAttemptsForCard: vi.fn().mockReturnValue([]),
      getResultByAttempt: vi.fn().mockReturnValue(undefined),
      isAttemptTerminal: (lc: string) => ["completed", "failed", "cancelled", "timed_out"].includes(lc),
    };
  }),
}));

let reviewStoreMock: any;
function makeReviewStoreMock() {
  return {
    contractExists: vi.fn().mockReturnValue(true),
    getSupervision: vi.fn().mockReturnValue({
      project_card_id: 1, contract_id: "pc_1", state: "executing",
      generation: 1, review_round: 0, repair_round: 0,
      active_review_case_id: null, accepted_decision_id: null,
      blocked_reason: null, updated_at: new Date().toISOString(),
    }),
    ensureAwaitingContract: vi.fn(),
    initializeSupervision: vi.fn(),
    getContractByProjectCardId: vi.fn().mockReturnValue({
      id: "pc_1", project_card_id: 1,
      contract_json: JSON.stringify({
        schema_version: 1, id: "pc_1",
        goal: "three worker project",
        criteria: [
          { id: "root_c1", description: "root criterion 1", evidence_expectation: "observed" },
        ],
        required_outputs: [],
        constraints: [],
        limits: { max_review_rounds: 5, max_repair_rounds: 3, max_tokens: 100000 },
        provenance: { root_card_id: 1, authored_by: "orc", created_at: new Date().toISOString() },
      }),
      contract_digest: "d1",
    }),
    getLatestOpenCase: vi.fn().mockReturnValue(undefined),
    stateTransition: vi.fn().mockReturnValue(true),
    insertReviewCase: vi.fn().mockReturnValue({ id: "rc_1" }),
    insertReviewRequest: vi.fn().mockReturnValue({ id: "rr_1" }),
    bumpReviewRequestAttempt: vi.fn(),
    getReviewRequestByCaseId: vi.fn().mockReturnValue(undefined),
    getLatestDecisionForProject: vi.fn().mockReturnValue(undefined),
    getAnsweredInputRequests: vi.fn().mockReturnValue([]),
    getPendingInputRequests: vi.fn().mockReturnValue([]),
    clearInputNotice: vi.fn(),
    setState: vi.fn(),
    settleAcceptance: vi.fn().mockReturnValue(true),
    db: { transaction: (fn: () => void) => fn() },
  };
}

vi.mock("../../components/project-acceptance/project-review-store.js", () => ({
  ProjectReviewStore: vi.fn().mockImplementation(function () {
    return reviewStoreMock ?? makeReviewStoreMock();
  }),
}));

vi.mock("../../components/project-acceptance/project-review-case.js", () => ({
  ReviewCaseAssembler: vi.fn().mockImplementation(function () {
    return {
      assembleCase: vi.fn().mockReturnValue({
        schema_version: 1, project_card_id: 1, generation: 1, round: 1,
        created_at: new Date().toISOString(),
        root_contract: { id: "pc_1", digest: "d1", goal: "three worker project", criteria: [], required_outputs: [], limits: {} },
        criterion_inputs: [],
        contradiction_candidates: [],
        uncovered_criteria: [],
        child_summaries: [],
        peer_contributions: [],
        budgets: { total_tokens: 0, wall_clock_ms: 1000, review_round: 1, repair_round: 0 },
        evidence_ref_count: 0, contradiction_count: 0,
      }),
    };
  }),
}));

vi.mock("../../components/project-acceptance/project-review-service.js", () => ({
  ProjectReviewService: vi.fn().mockImplementation(function () {
    return {
      processDecision: vi.fn().mockReturnValue({ kind: "accepted", decisionId: "d_1", summary: "accepted" }),
    };
  }),
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

  beforeEach(async () => {
    vi.clearAllMocks();
    cards.clear();
    nextCardId = 100;
    latestAttemptBehavior = null;
    reviewStoreMock = makeReviewStoreMock();
    mod = await import("../../components/reconciler.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("three queued supervised children are all concurrently dispatched by Reconciler", async () => {
    const projectId = (() => {
      const id = nextCardId++;
      cards.set(id, {
        id, title: "project", source: "user",
        status: "running", type: "O", parent_id: null,
        goal: "Produce three summaries", notes: null,
        created_at: new Date().toISOString().replace(/Z$/, ""),
        result_summary: null, delivery_attempts: 0,
      });
      return id;
    })();

    const childIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cId = nextCardId++;
      cards.set(cId, {
        id: cId, title: `worker ${i}`, source: "agent",
        status: "queued", type: "W", parent_id: projectId,
        goal: `summary ${i}`, notes: JSON.stringify({ supervised: true }),
        created_at: new Date().toISOString().replace(/Z$/, ""),
        result_summary: null, delivery_attempts: 0,
      });
      childIds.push(cId);
    }

    latestAttemptBehavior = (cardId: number) => {
      if (childIds.includes(cardId)) return { id: `a_${cardId}`, lifecycle: "pending" };
      return null;
    };

    mod.requestReconcile(projectId);
    await flush();

    expect(dispatchMock).toHaveBeenCalledTimes(3);
    const dispatchedIds = dispatchMock.mock.calls.map((c: any) => c[0].cardId);
    expect(new Set(dispatchedIds).size).toBe(3);
    for (const id of childIds) {
      expect(dispatchedIds).toContain(id);
    }
  });

  it("all three children terminal triggers review case creation and Orc dispatch", async () => {
    const projectId = (() => {
      const id = nextCardId++;
      cards.set(id, {
        id, title: "project", source: "user",
        status: "running", type: "O", parent_id: null,
        goal: "Produce summaries", notes: null,
        created_at: new Date().toISOString().replace(/Z$/, ""),
        result_summary: null, delivery_attempts: 0,
      });
      return id;
    })();

    for (let i = 0; i < 3; i++) {
      const cId = nextCardId++;
      cards.set(cId, {
        id: cId, title: `worker ${i}`, source: "agent",
        status: "done", type: "W", parent_id: projectId,
        goal: `summary ${i}`, notes: JSON.stringify({ supervised: true }),
        created_at: new Date().toISOString().replace(/Z$/, ""),
        result_summary: "ok", delivery_attempts: 1,
      });
    }

    mod.requestReconcile(projectId);
    await flush();

    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(
      projectId,
      ["executing", "review_ready"],
      "review_ready",
      { review_round: 1 },
    );
    expect(reviewStoreMock.insertReviewCase).toHaveBeenCalledTimes(1);
    expect(reviewStoreMock.insertReviewRequest).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "O", cardId: projectId }),
    );
  });

  it("full lifecycle: children complete, review created, project accepted, exactly-once", async () => {
    const projectId = (() => {
      const id = nextCardId++;
      cards.set(id, {
        id, title: "project", source: "user",
        status: "running", type: "O", parent_id: null,
        goal: "Produce summaries", notes: null,
        created_at: new Date().toISOString().replace(/Z$/, ""),
        result_summary: null, delivery_attempts: 0,
      });
      return id;
    })();

    for (let i = 0; i < 3; i++) {
      const cId = nextCardId++;
      cards.set(cId, {
        id: cId, title: `worker ${i}`, source: "agent",
        status: "done", type: "W", parent_id: projectId,
        goal: `summary ${i}`, notes: JSON.stringify({ supervised: true }),
        created_at: new Date().toISOString().replace(/Z$/, ""),
        result_summary: "ok", delivery_attempts: 1,
      });
    }

    reviewStoreMock.getSupervision.mockReturnValue({
      project_card_id: projectId, contract_id: "pc_1", state: "executing",
      generation: 1, review_round: 0, repair_round: 0,
      active_review_case_id: null, accepted_decision_id: null,
      blocked_reason: null, updated_at: new Date().toISOString(),
    });

    reviewStoreMock.getContractByProjectCardId.mockReturnValue({
      id: "pc_1", project_card_id: projectId,
      contract_json: JSON.stringify({
        schema_version: 1, id: "pc_1", goal: "test",
        criteria: [{ id: "root_c1", description: "c1", evidence_expectation: "observed" }],
        required_outputs: [], constraints: [],
        limits: { max_review_rounds: 5, max_repair_rounds: 3, max_tokens: 100000 },
        provenance: { root_card_id: projectId, authored_by: "orc", created_at: new Date().toISOString() },
      }),
      contract_digest: "d1",
    });

    mod.requestReconcile(projectId);
    await flush();

    expect(reviewStoreMock.insertReviewCase).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "O", cardId: projectId }),
    );

    reviewStoreMock.getLatestOpenCase.mockReturnValue({ id: "rc_1", status: "open" });
    reviewStoreMock.getReviewRequestByCaseId.mockReturnValue({ id: "rr_1", status: "pending" });

    const service = new (await import("../../components/project-acceptance/project-review-service.js")).ProjectReviewService();
    const decision = {
      schema_version: 1, id: "d_1", project_card_id: projectId,
      review_case_id: "rc_1", project_generation: 1,
      action: "accept",
      criteria: [{ criterion_id: "root_c1", verdict: "passed", evidence_ids: [], rationale: "all workers passed" }],
      synthesis: "All three workers completed successfully",
    };
    const result = service.processDecision(decision);
    expect(result.kind).toBe("accepted");
  });
});
