/**
 * reconciler.test.ts — #1411 retry ownership domain guard.
 *
 * Verifies that:
 *  - Unsupervised legacy cards are completely invisible to Reconciler.
 *  - Supervised cards still dispatch through the normal path.
 *  - Fail-closed behavior when supervision state is missing or errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const dispatchMock = vi.fn();
vi.mock("./spin.js", () => ({
  spin: { dispatch: dispatchMock },
}));

const kanbanGetCardMock = vi.fn();
const kanbanGetChildrenMock = vi.fn();
const isUnblockedMock = vi.fn().mockReturnValue(true);
const kanbanUpdateMock = vi.fn();
const cascadeFailMock = vi.fn();
const kanbanFailMock = vi.fn();
const kanbanCompleteMock = vi.fn();
const kanbanRunningProjectIdsMock = vi.fn().mockReturnValue([]);
vi.mock("./tasks/kanban-board.js", () => ({
  kanbanFail: kanbanFailMock,
  kanbanComplete: kanbanCompleteMock,
  kanbanUpdate: kanbanUpdateMock,
  kanbanGetCard: kanbanGetCardMock,
  kanbanGetChildren: kanbanGetChildrenMock,
  kanbanRunningProjectIds: kanbanRunningProjectIdsMock,
  isUnblocked: isUnblockedMock,
  cascadeFail: cascadeFailMock,
}));

const cardHasContractMock = vi.fn();
const getContractForCardMock = vi.fn();
vi.mock("./worker-supervision-service.js", () => {
  return {
    WorkerSupervisionService: class {
      cardHasContract = cardHasContractMock;
      getContractForCard = getContractForCardMock;
    },
  };
});

const getLatestAttemptMock = vi.fn().mockReturnValue(null);
const claimAttemptMock = vi.fn().mockImplementation((cardId: number, contractId: string, executorKind: string, executorId: string, generation: number) => ({
  attemptId: "a_1", cardId, contractId, executorKind, executorId, generation, claimedAt: new Date().toISOString(),
}));
const markAttemptStartObservableMock = vi.fn().mockReturnValue(true);
const markAttemptRunningMock = vi.fn().mockReturnValue(true);
const failAttemptMock = vi.fn().mockReturnValue(true);
const cancelPendingAttemptMock = vi.fn().mockReturnValue(true);
const requestCancelMock = vi.fn().mockReturnValue(true);
const cancelAttemptMock = vi.fn().mockReturnValue(true);
vi.mock("./worker-supervision-store.js", () => {
  return {
    WorkerSupervisionStore: class {
      getLatestAttempt = getLatestAttemptMock;
      claimAttempt = claimAttemptMock;
      markAttemptStartObservable = markAttemptStartObservableMock;
      markAttemptRunning = markAttemptRunningMock;
      failAttempt = failAttemptMock;
      cancelPendingAttempt = cancelPendingAttemptMock;
      requestCancel = requestCancelMock;
      cancelAttempt = cancelAttemptMock;
      isAttemptTerminal = (lifecycle: string) => ["completed", "failed", "cancelled", "timed_out"].includes(lifecycle);
    },
  };
});

vi.mock("./spin-worker-adapter.js", () => ({
  SpinWorkerAdapter: class {
    capacity = vi.fn().mockResolvedValue({ available: 3, max: 3 });
    start = vi.fn().mockImplementation((claim: { cardId: number }) => {
      dispatchMock({ type: "W", cardId: claim.cardId });
      return Promise.resolve({ kind: "started", attemptId: "a_1", generation: 1, executorId: "spin-local" });
    });
    cancel = vi.fn().mockResolvedValue({ kind: "cancelled", attemptId: "a_1" });
  },
}));

// These are imported by reconcileProject / evaluateLease — mock as no-ops
vi.mock("./executor-lease-store.js", () => ({
  ExecutorLeaseStore: vi.fn().mockImplementation(() => ({
    getSnapshot: vi.fn().mockReturnValue(null),
  })),
}));

function makeReviewStoreMock() {
  const transactionImpl = vi.fn((fn: () => void) => fn());
  return {
    contractExists: vi.fn().mockReturnValue(false),
    getSupervision: vi.fn().mockReturnValue(undefined),
    ensureAwaitingContract: vi.fn().mockReturnValue(true),
    initializeSupervision: vi.fn(),
    getContractByProjectCardId: vi.fn().mockReturnValue(undefined),
    getLatestOpenCase: vi.fn().mockReturnValue(undefined),
    stateTransition: vi.fn().mockReturnValue(false),
    getLatestDecisionForProject: vi.fn().mockReturnValue(undefined),
    getAnsweredInputRequests: vi.fn().mockReturnValue([]),
    getPendingInputRequests: vi.fn().mockReturnValue([]),
    clearInputNotice: vi.fn(),
    insertReviewCase: vi.fn().mockReturnValue({ id: "rc_test_1" }),
    insertReviewRequest: vi.fn().mockReturnValue({ id: "rr_test_1" }),
    markReviewRequestDispatched: vi.fn().mockReturnValue(true),
    getReviewRequestByCaseId: vi.fn().mockReturnValue(undefined),
    setState: vi.fn(),
    db: { transaction: transactionImpl },
  };
}

vi.mock("./project-acceptance/project-review-store.js", () => ({
  ProjectReviewStore: vi.fn().mockImplementation(function() {
    return reviewStoreMock ?? makeReviewStoreMock();
  }),
}));

vi.mock("./project-acceptance/project-review-case.js", () => ({
  ReviewCaseAssembler: vi.fn().mockImplementation(function() {
    return {
      assembleCase: vi.fn().mockReturnValue({
        schema_version: 1,
        project_card_id: 1,
        generation: 1,
        round: 1,
        created_at: new Date().toISOString(),
        root_contract: { id: "pc_test_1", digest: "d1", goal: "test", criteria: [], required_outputs: [], limits: { max_tokens: 100000, max_cost: undefined, hard_deadline_at: undefined, max_review_rounds: 5, max_repair_rounds: 3 } },
        criterion_inputs: [],
        contradiction_candidates: [],
        uncovered_criteria: [],
        child_summaries: [],
        peer_contributions: [],
        budgets: { total_cost: 0, total_tokens: 0, wall_clock_ms: 1000, review_round: 1, repair_round: 0 },
        evidence_ref_count: 0,
        contradiction_count: 0,
      }),
    };
  }),
}));

// Catch-all for retry-service dynamic require — return error
vi.mock("./retry/retry-service.js", () => ({
  RetryService: vi.fn().mockImplementation(() => ({
    handleTerminalAttempt: vi.fn().mockReturnValue({ error: "mock error" }),
  })),
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

let mod: typeof import("./reconciler.js");
let reviewStoreMock: {
  contractExists: ReturnType<typeof vi.fn>;
  getSupervision: ReturnType<typeof vi.fn>;
  ensureAwaitingContract: ReturnType<typeof vi.fn>;
  initializeSupervision: ReturnType<typeof vi.fn>;
  getContractByProjectCardId: ReturnType<typeof vi.fn>;
  getLatestOpenCase: ReturnType<typeof vi.fn>;
  stateTransition: ReturnType<typeof vi.fn>;
  getLatestDecisionForProject: ReturnType<typeof vi.fn>;
  getAnsweredInputRequests: ReturnType<typeof vi.fn>;
  getPendingInputRequests: ReturnType<typeof vi.fn>;
  clearInputNotice: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  vi.clearAllMocks();
  reviewStoreMock = makeReviewStoreMock();
  isUnblockedMock.mockReturnValue(true);
  getLatestAttemptMock.mockReturnValue(null);
  getContractForCardMock.mockReturnValue(undefined);
  cardHasContractMock.mockReturnValue(false);
  kanbanRunningProjectIdsMock.mockReturnValue([]);
  kanbanFailMock.mockReset();
  kanbanCompleteMock.mockReset();
  mod = await import("./reconciler.js");
});

function makeCard(overrides: Partial<{
  id: number; status: string; type: string; title: string; notes: string | null;
  parent_id: number | null; delivery_attempts: number;
}> = {}): NonNullable<ReturnType<typeof kanbanGetCardMock>> {
  return {
    id: 1, status: "queued", type: "W", title: "test card", notes: null,
    parent_id: null, delivery_attempts: 0, source: "agent",
    source_id: null, assignee: "local", priority: "MEDIUM",
    goal: null, result_summary: null, result_path: null,
    error: null, approval: null, due_at: null, labels: null,
    blocked_by: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), completed_at: null,
    delivered_at: null, max_tokens: null, tokens_used: null,
    delivery_mode: "deliver", chat_id: null, source_peer: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Reconciler — #1411 domain guard", () => {
  describe("unsupervised cards (no contract)", () => {
    it("queued card produces zero dispatches", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("failed card produces zero dispatches", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "failed" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("running card produces zero dispatches", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "running" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("fifty wakeups for one unsupervised card yield zero dispatches", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "failed" }));
      for (let i = 0; i < 50; i++) {
        mod.requestReconcile(1);
      }
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("unsupervised B card is never dispatched as W", async () => {
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued", type: "B" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });

  describe("supervised cards (has contract)", () => {
    it("queued card with pending attempt dispatches once", async () => {
      cardHasContractMock.mockReturnValue(true);
      getContractForCardMock.mockReturnValue({ id: "c_1" });
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending" });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: 1, type: "W" }),
      );
    });

    it("dispatches exactly once under duplicate wakeups", async () => {
      cardHasContractMock.mockReturnValue(true);
      getContractForCardMock.mockReturnValue({ id: "c_1" });
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending" });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      for (let i = 0; i < 10; i++) {
        mod.requestReconcile(1);
      }
      await flush();
      // The keyed scheduler coalesces: first call sets dirty=false, subsequent
      // calls set dirty=true but do not dispatch again until next reconcile pass
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });

    it("queued card with no pending attempt does not dispatch (fail closed)", async () => {
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue(null);
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("queued card with non-pending lifecycle does not dispatch", async () => {
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "running" });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("two supervised card IDs can each make progress", async () => {
      cardHasContractMock.mockReturnValue(true);
      getContractForCardMock.mockReturnValue({ id: "c_1" });
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending" });

      kanbanGetCardMock.mockImplementation((id: number) => {
        if (id === 1) return makeCard({ id: 1, status: "queued" });
        if (id === 2) return makeCard({ id: 2, status: "queued" });
        return null;
      });

      mod.requestReconcile(1);
      mod.requestReconcile(2);
      await flush();
      expect(dispatchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("supervised card classification/directive errors", () => {
    it("classification error leaves card failed with zero dispatches", async () => {
      // Mock RetryService to return error from handleTerminalAttempt
      // The catch-all mock already does this — but we need to clear
      // and set the module mock per test
      vi.resetModules();
      vi.doMock("./retry/retry-service.js", () => ({
        RetryService: vi.fn().mockImplementation(() => ({
          handleTerminalAttempt: vi.fn().mockReturnValue({ error: "classification failed (mock)" }),
        })),
      }));
      // Re-mock everything else
      const { WorkerSupervisionService: WSS } = await import("./worker-supervision-service.js");
      cardHasContractMock.mockReturnValue(true);
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "failed" });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "failed" }));

      const localMod = await import("./reconciler.js");
      localMod.requestReconcile(1);
      await flush();

      expect(dispatchMock).not.toHaveBeenCalled();
      expect(kanbanUpdateMock).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("non-existent card is silently ignored", async () => {
      kanbanGetCardMock.mockReturnValue(null);
      mod.requestReconcile(999);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("Pi card still routes through Pi lane regardless of contract", async () => {
      // Pi lane runs first — should not be blocked by domain guard
      cardHasContractMock.mockReturnValue(false);
      getLatestAttemptMock.mockReturnValue(null);
      // Pi card has no executor lease or Pi service set, so it will just warn and return
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued", type: "pi" }));
      mod.requestReconcile(1);
      await flush();
      // No dispatch since Pi service is null, but importantly no crash
      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });

  describe("scanActiveProjects (#1414)", () => {
    it("wakes each running O-type project and returns count", () => {
      kanbanRunningProjectIdsMock.mockReturnValue([10, 20, 30]);
      const count = mod.scanActiveProjects();
      expect(count).toBe(3);
      // After flush, each should have been reconciled
    });

    it("returns 0 when no running O-type projects exist", () => {
      kanbanRunningProjectIdsMock.mockReturnValue([]);
      const count = mod.scanActiveProjects();
      expect(count).toBe(0);
    });
  });

  describe("zero-child project timeout (#1414)", () => {
    it("zero-child project before wall-clock deadline stays running", async () => {
      const card = makeCard({
        id: 1, status: "running", type: "O",
        created_at: new Date().toISOString(),
      });
      kanbanGetCardMock.mockReturnValue(card);
      kanbanGetChildrenMock.mockReturnValue([]);

      mod.requestReconcile(1);
      await flush();

      expect(kanbanFailMock).not.toHaveBeenCalled();
    });

    it("zero-child project past wall-clock deadline is aborted", async () => {
      // SQLite datetime('now') has no trailing Z; reconcileProject appends one.
      const past = new Date(Date.now() - 31 * 60 * 1000).toISOString().replace(/Z$/, "");
      const card = makeCard({
        id: 1, status: "running", type: "O",
        created_at: past,
      });
      kanbanGetCardMock.mockReturnValue(card);
      kanbanGetChildrenMock.mockReturnValue([]);

      mod.requestReconcile(1);
      await flush();

      expect(kanbanFailMock).toHaveBeenCalledWith(1, expect.stringContaining("wall-clock"));
    });

      it("supervised project with all-terminal children transitions to review_ready and dispatches Orc", async () => {
      // reviewStoreMock is already fresh from beforeEach
      reviewStoreMock.contractExists.mockReturnValue(true);
      reviewStoreMock.getSupervision.mockReturnValue({
        project_card_id: 1,
        contract_id: "pc_test_1",
        state: "executing",
        generation: 1,
        review_round: 0,
        repair_round: 0,
        active_review_case_id: null,
        accepted_decision_id: null,
        blocked_reason: null,
        updated_at: new Date().toISOString(),
      });
      reviewStoreMock.stateTransition
        .mockReturnValueOnce(true)   // executing → review_ready
        .mockReturnValueOnce(true);  // review_ready → review_requested (inside transaction)

      const card = makeCard({
        id: 1, status: "running", type: "O",
        created_at: new Date().toISOString(),
      });
      kanbanGetCardMock.mockReturnValue(card);
      kanbanGetChildrenMock.mockReturnValue([
        { ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 },
        { ...makeCard({ id: 3, status: "done", type: "W" }), parent_id: 1 },
      ]);

      mod.requestReconcile(1);
      await flush();

      expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
      expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["review_ready"], "review_requested");
      expect(reviewStoreMock.insertReviewRequest).toHaveBeenCalledWith(1, "rc_test_1", 1);
      expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: "O", cardId: 1 }));
      expect(kanbanCompleteMock).not.toHaveBeenCalled();
    });

    it("project with all-terminal children but no contract does not auto-complete (legacy removed)", async () => {
      // No root contract → should not auto-complete
      const card = makeCard({
        id: 1, status: "running", type: "O",
        created_at: new Date().toISOString(),
      });
      kanbanGetCardMock.mockReturnValue(card);
      kanbanGetChildrenMock.mockReturnValue([
        { ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 },
        { ...makeCard({ id: 3, status: "done", type: "W" }), parent_id: 1 },
      ]);

      mod.requestReconcile(1);
      await flush();

      expect(kanbanCompleteMock).not.toHaveBeenCalled();
    });
  });
});
