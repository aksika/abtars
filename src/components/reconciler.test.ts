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
const spawnChildMock = vi.fn();
vi.mock("./spin.js", () => ({
  spin: { dispatch: dispatchMock, spawnChild: spawnChildMock },
}));

const kanbanGetCardMock = vi.fn();
const kanbanGetChildrenMock = vi.fn();
const isUnblockedMock = vi.fn().mockReturnValue(true);
const kanbanUpdateMock = vi.fn();
const cascadeFailMock = vi.fn();
const kanbanFailMock = vi.fn();
const kanbanCompleteMock = vi.fn();
const kanbanRunningProjectIdsMock = vi.fn().mockReturnValue([]);
const kanbanQueuedDispatchOrderMock = vi.fn().mockReturnValue([]);
const kanbanPromoteDueRetryMock = vi.fn().mockReturnValue(false);
vi.mock("./tasks/kanban-board.js", () => ({
  kanbanFail: kanbanFailMock,
  kanbanComplete: kanbanCompleteMock,
  kanbanUpdate: kanbanUpdateMock,
  kanbanGetCard: kanbanGetCardMock,
  kanbanGetChildren: kanbanGetChildrenMock,
  kanbanRunningProjectIds: kanbanRunningProjectIdsMock,
  kanbanQueuedDispatchOrder: kanbanQueuedDispatchOrderMock,
  kanbanPromoteDueRetry: kanbanPromoteDueRetryMock,
  KANBAN_TERMINAL_STATUSES: ["done", "delivered", "failed"],
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
const workerContractExistsMock = vi.fn().mockReturnValue(true);
const claimAttemptMock = vi.fn().mockImplementation((cardId: number, contractId: string, executorKind: string, executorId: string, generation: number) => ({
  attemptId: "a_1", cardId, contractId, executorKind, executorId, generation, claimedAt: new Date().toISOString(),
}));
const markAttemptStartObservableMock = vi.fn().mockReturnValue(true);
const markAttemptRunningMock = vi.fn().mockReturnValue(true);
const failAttemptMock = vi.fn().mockReturnValue(true);
const cancelPendingAttemptMock = vi.fn().mockReturnValue(true);
const requestCancelMock = vi.fn().mockReturnValue(true);
const cancelAttemptMock = vi.fn().mockReturnValue(true);
const getActiveAttemptCountForExecutorMock = vi.fn().mockReturnValue(0);
const terminalSettlementMock = vi.fn().mockReturnValue({ kind: "settled", lifecycle: "completed", chargedTokens: 0 });
const claimAttemptWithinLimitsMock = vi.fn().mockImplementation((input: { cardId: number; attemptId: string; contractId: string; executorKind: string; executorId: string; generation: number; executorMax: number; hardDeadlineAt?: string; reservedTokens: number; projectId: number; sourceAttemptId?: string }) => ({
  kind: "claimed",
  claim: { attemptId: input.attemptId, cardId: input.cardId, contractId: input.contractId, executorKind: input.executorKind, executorId: input.executorId, generation: input.generation, claimedAt: new Date().toISOString(), hardDeadlineAt: input.hardDeadlineAt },
}));
vi.mock("./worker-supervision-store.js", () => {
  return {
    WorkerSupervisionStore: class {
      contractExists = workerContractExistsMock;
      getLatestAttempt = getLatestAttemptMock;
      claimAttempt = claimAttemptMock;
      markAttemptStartObservable = markAttemptStartObservableMock;
      markAttemptRunning = markAttemptRunningMock;
      failAttempt = failAttemptMock;
      cancelPendingAttempt = cancelPendingAttemptMock;
      requestCancel = requestCancelMock;
      cancelAttempt = cancelAttemptMock;
      isAttemptTerminal = (lifecycle: string) => ["completed", "failed", "cancelled", "timed_out"].includes(lifecycle);
      getActiveAttemptCountForExecutor = getActiveAttemptCountForExecutorMock;
      terminalSettlement = terminalSettlementMock;
      claimAttemptWithinLimits = claimAttemptWithinLimitsMock;
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
    claimCoverageRound: vi.fn().mockReturnValue(true),
    recordCoverageClear: vi.fn(),
    recordCoverageReviewable: vi.fn().mockReturnValue(true),
    setState: vi.fn(),
    hasActiveProjectSupervision: vi.fn().mockReturnValue(false),
    db: { transaction: transactionImpl },
  };
}

vi.mock("./project-acceptance/project-review-store.js", () => ({
  ProjectReviewStore: vi.fn().mockImplementation(function() {
    return reviewStoreMock ?? makeReviewStoreMock();
  }),
}));

const readProjectCriterionCoverageMock = vi.fn().mockReturnValue({
  kind: "read",
  read: { criterionIds: [], mappings: [], uncovered: [] },
});
vi.mock("./project-acceptance/project-criterion-coverage.js", () => ({
  readProjectCriterionCoverage: readProjectCriterionCoverageMock,
  coverageSignature: vi.fn().mockReturnValue("cov-sig"),
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

const getLiveRunForProjectMock = vi.fn().mockReturnValue(undefined);
vi.mock("./orc-project/orc-project-run-store.js", () => ({
  OrcProjectRunStore: vi.fn().mockImplementation(function() {
    return { getLiveRunForProject: getLiveRunForProjectMock };
  }),
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
  readProjectCriterionCoverageMock.mockReturnValue({
    kind: "read",
    read: { criterionIds: [], mappings: [], uncovered: [] },
  });
  isUnblockedMock.mockReturnValue(true);
  getLatestAttemptMock.mockReturnValue(null);
  workerContractExistsMock.mockReturnValue(true);
  getContractForCardMock.mockReturnValue(undefined);
  cardHasContractMock.mockReturnValue(false);
  kanbanRunningProjectIdsMock.mockReturnValue([]);
  kanbanFailMock.mockReset();
  kanbanCompleteMock.mockReset();
  kanbanPromoteDueRetryMock.mockReset();
  kanbanPromoteDueRetryMock.mockReturnValue(false);
  getLiveRunForProjectMock.mockReset();
  getLiveRunForProjectMock.mockReturnValue(undefined);
  spawnChildMock.mockReset();
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
    function setupDispatchPump(cardId: number) {
      const card = {
        id: cardId, parent_id: 100, status: "queued", type: "W",
        title: "test", priority: "MEDIUM", created_at: new Date().toISOString(),
      } as any;
      kanbanQueuedDispatchOrderMock.mockReturnValue([card]);
      kanbanGetCardMock.mockImplementation((id: number) => {
        if (id === cardId) return card;
        if (id === 100) return { id: 100, status: "running", max_tokens: null, tokens_used: 0, type: "O" } as any;
        return null;
      });
    }

    it("queued card with pending attempt dispatches once", async () => {
      cardHasContractMock.mockReturnValue(true);
      getContractForCardMock.mockReturnValue({ id: "c_1" });
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending" });
      setupDispatchPump(1);
      mod.requestReconcile(1);
      await flush();
      await new Promise(r => setTimeout(r, 10));
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
      setupDispatchPump(1);
      for (let i = 0; i < 10; i++) {
        mod.requestReconcile(1);
      }
      await flush();
      await new Promise(r => setTimeout(r, 10));
      await flush();
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

      const card1 = { id: 1, parent_id: 100, status: "queued", type: "W", title: "test", priority: "MEDIUM", created_at: new Date().toISOString() } as any;
      const card2 = { id: 2, parent_id: 100, status: "queued", type: "W", title: "test", priority: "MEDIUM", created_at: new Date().toISOString() } as any;
      kanbanQueuedDispatchOrderMock.mockReturnValue([card1, card2]);
      kanbanGetCardMock.mockImplementation((id: number) => {
        if (id === 1) return card1;
        if (id === 2) return card2;
        if (id === 100) return { id: 100, status: "running", max_tokens: null, tokens_used: 0, type: "O" } as any;
        return null;
      });

      mod.requestReconcile(1);
      mod.requestReconcile(2);
      await flush();
      await new Promise(r => setTimeout(r, 10));
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

    it("zero-child project without hard deadline stays running (no generic wall-clock)", async () => {
      const past = new Date(Date.now() - 31 * 60 * 1000).toISOString().replace(/Z$/, "");
      const card = makeCard({
        id: 1, status: "running", type: "O",
        created_at: past,
      });
      kanbanGetCardMock.mockReturnValue(card);
      kanbanGetChildrenMock.mockReturnValue([]);

      mod.requestReconcile(1);
      await flush();

      expect(kanbanFailMock).not.toHaveBeenCalled();
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

// ── #1546: scheduled-root driver ──────────────────────────────────────────────

describe("Reconciler — #1546 scheduled-root driver", () => {
  function supervision(overrides: Record<string, unknown> = {}) {
    return {
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
      ...overrides,
    };
  }

  function scheduledRootCard(overrides: Record<string, unknown> = {}) {
    return makeCard({
      id: 1,
      status: "running",
      type: "O",
      source: "task",
      source_id: "run-1",
      next_retry_at: null,
      ...overrides,
    });
  }

  function setupExecutingProject(opts: { children?: unknown[]; attemptLifecycle?: string | null } = {}) {
    reviewStoreMock.contractExists.mockReturnValue(true);
    reviewStoreMock.getSupervision.mockReturnValue(supervision());
    reviewStoreMock.hasActiveProjectSupervision.mockReturnValue(true);
    kanbanGetCardMock.mockReturnValue(scheduledRootCard());
    kanbanGetChildrenMock.mockReturnValue(opts.children ?? []);
    if (opts.attemptLifecycle !== undefined) {
      getLatestAttemptMock.mockReturnValue(
        opts.attemptLifecycle === null ? null : { id: "a_1", lifecycle: opts.attemptLifecycle },
      );
    }
  }

  function fakeCoordinator(claims: Array<{ projectCardId: number; goal: string }>) {
    mod.setOrcCoordinator({
      scheduleScheduledProject: (projectCardId: number, goal: string) => {
        claims.push({ projectCardId, goal });
        // a real claim creates the durable live Orc row the next pass observes
        getLiveRunForProjectMock.mockReturnValue({ project_generation: 1, id: `or_${projectCardId}` });
        return { kind: "claimed" as const, context: { runId: `or_${projectCardId}`, projectCardId } };
      },
      scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_review" }),
    } as never);
  }

  it("routes a queued due scheduled root to the driver and promotes only after the continuation claim", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    let phase: "queued" | "running" = "queued";
    kanbanGetCardMock.mockReturnValue(scheduledRootCard({
      status: "queued",
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    }));
    kanbanPromoteDueRetryMock.mockImplementation(() => { phase = "running"; return true; });
    kanbanGetCardMock.mockImplementation(() => scheduledRootCard({
      status: phase,
      next_retry_at: phase === "queued" ? new Date(Date.now() - 1000).toISOString() : null,
    }));

    mod.requestReconcile(1);
    await flush();

    // zero children → no durable owner → one correlated claim before promotion
    expect(claims).toHaveLength(1);
    expect(claims[0]!.projectCardId).toBe(1);
    expect(claims[0]!.goal).toContain("run-1");
    expect(kanbanPromoteDueRetryMock).toHaveBeenCalledWith(1);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("fails closed when contract authoring has no Orc coordinator", async () => {
    kanbanGetCardMock.mockReturnValue(scheduledRootCard({
      status: "queued",
      source_id: "missing-run-for-coordinator-test",
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    }));
    kanbanGetChildrenMock.mockReturnValue([]);
    reviewStoreMock.contractExists.mockReturnValue(false);
    reviewStoreMock.getSupervision.mockReturnValue(undefined);
    reviewStoreMock.hasActiveProjectSupervision.mockReturnValue(true);
    mod.setOrcCoordinator(null);

    mod.requestReconcile(1);
    await flush();
    await flush();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(kanbanPromoteDueRetryMock).not.toHaveBeenCalled();
    expect(kanbanFailMock).toHaveBeenCalledWith(1, "no scheduled Orc continuation owner after restart");
  });

  it("keeps a future-dated queued scheduled root a no-op", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    kanbanGetCardMock.mockReturnValue(scheduledRootCard({
      status: "queued",
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    }));

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(kanbanPromoteDueRetryMock).not.toHaveBeenCalled();
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("leaves an unrelated parentless queued card on the legacy path", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued", type: "O", source: "agent", next_retry_at: new Date(Date.now() - 1000).toISOString() }));
    reviewStoreMock.hasActiveProjectSupervision.mockReturnValue(true);

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(kanbanPromoteDueRetryMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("resumes a pending Worker attempt without a lease (worker_resume owns)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "queued", type: "W" }), parent_id: 1 }],
      attemptLifecycle: "pending",
    });

    mod.requestReconcile(1);
    await flush();

    // the dispatch pump was requested; no continuation claim and no settle
    expect(claims).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("does not treat an orphaned attempt row without a Worker contract as ownership", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "queued", type: "W" }), parent_id: 1 }],
      attemptLifecycle: "pending",
    });
    workerContractExistsMock.mockReturnValue(false);

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("retains a valid live attempt (running) — never settled, never claimed", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "running", type: "W" }), parent_id: 1 }],
      attemptLifecycle: "running",
    });

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("creates the review case for an executing project whose children are all terminal", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [
        { ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 },
        { ...makeCard({ id: 3, status: "failed", type: "W" }), parent_id: 1 },
      ],
    });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    reviewStoreMock.stateTransition.mockReturnValue(true);

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
    expect(reviewStoreMock.insertReviewRequest).toHaveBeenCalledWith(1, "rc_test_1", 1);
    expect(claims).toHaveLength(0); // case creation is the Reconciler owner — no continuation claim
  });

  it("#1604: review_ready crash recovery with a stale gap never dispatches a coverage round or blocks", async () => {
    // A project already in review_ready (crash between the review_ready
    // transition and case insert) must recover through the continuation path.
    // The gate only guards the executing → review_ready ENTRY (design §3);
    // claimCoverageRound pins state='executing', so a stale gap here can never
    // be claimed — the recovery must not deadlock on it.
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    reviewStoreMock.contractExists.mockReturnValue(true);
    reviewStoreMock.getSupervision.mockReturnValue(supervision({
      state: "review_ready",
      coverage_rounds: 0,
      coverage_signature: null,
      coverage_uncovered_ids: null,
    }));
    reviewStoreMock.hasActiveProjectSupervision.mockReturnValue(true);
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    // Coverage read reports a gap — must NOT trigger a coverage round or block.
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "read",
      read: { criterionIds: ["c1"], mappings: [], uncovered: ["c1"] },
    });
    kanbanGetCardMock.mockReturnValue(scheduledRootCard());
    kanbanGetChildrenMock.mockReturnValue([
      { ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 },
    ]);

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(reviewStoreMock.claimCoverageRound).not.toHaveBeenCalled();
    expect(kanbanFailMock).not.toHaveBeenCalled();
    const coverageDispatches = claims.filter(c => c.goal.includes("[COVERAGE GAP]"));
    expect(coverageDispatches).toHaveLength(0);
    expect(claims.length).toBeGreaterThan(0); // recovery continues via the scheduled continuation
  });

  it("#1605: a fresh delegated gap dispatches exactly one coverage round and stays executing", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    reviewStoreMock.getSupervision.mockReturnValue(supervision({
      state: "executing",
      coverage_rounds: 0,
      coverage_signature: null,
      coverage_uncovered_ids: null,
    }));
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "read",
      read: { criterionIds: ["c1"], mappings: [], uncovered: ["c1"] },
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(reviewStoreMock.claimCoverageRound).toHaveBeenCalledTimes(1);
    expect(reviewStoreMock.recordCoverageReviewable).not.toHaveBeenCalled();
    const coverageDispatches = claims.filter(c => c.goal.includes("[COVERAGE GAP]"));
    expect(coverageDispatches).toHaveLength(1);
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1605: an unchanged gap before grace stays waiting — no second dispatch, no review case", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    reviewStoreMock.getSupervision.mockReturnValue(supervision({
      state: "executing",
      coverage_rounds: 1,
      coverage_signature: "cov-sig",
      coverage_uncovered_ids: JSON.stringify(["c1"]),
      updated_at: new Date().toISOString(), // grace just started
    }));
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "read",
      read: { criterionIds: ["c1"], mappings: [], uncovered: ["c1"] },
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(reviewStoreMock.claimCoverageRound).not.toHaveBeenCalled();
    expect(reviewStoreMock.recordCoverageReviewable).not.toHaveBeenCalled();
    const coverageDispatches = claims.filter(c => c.goal.includes("[COVERAGE GAP]"));
    expect(coverageDispatches).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1605: an unchanged gap after grace proceeds to review with the persisted gap — never blocked", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    reviewStoreMock.stateTransition.mockReturnValue(true);
    reviewStoreMock.getSupervision.mockReturnValue(supervision({
      state: "executing",
      coverage_rounds: 1,
      coverage_signature: "cov-sig",
      coverage_uncovered_ids: JSON.stringify(["c1"]),
      updated_at: new Date(Date.now() - 120_000).toISOString(), // grace elapsed
    }));
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "read",
      read: { criterionIds: ["c1"], mappings: [], uncovered: ["c1"] },
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(reviewStoreMock.recordCoverageReviewable).toHaveBeenCalledWith(1, "cov-sig", ["c1"]);
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1605: a new gap at the coverage-round cap proceeds to review, not a terminal block", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    reviewStoreMock.stateTransition.mockReturnValue(true);
    reviewStoreMock.getSupervision.mockReturnValue(supervision({
      state: "executing",
      coverage_rounds: 3, // MAX_COVERAGE_ROUNDS
      coverage_signature: "other-sig",
      coverage_uncovered_ids: null,
    }));
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "read",
      read: { criterionIds: ["c1"], mappings: [], uncovered: ["c1"] },
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(reviewStoreMock.claimCoverageRound).not.toHaveBeenCalled();
    expect(reviewStoreMock.recordCoverageReviewable).toHaveBeenCalledWith(1, "cov-sig", ["c1"]);
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1605: a fully covered project proceeds to review without a coverage round", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    reviewStoreMock.stateTransition.mockReturnValue(true);
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "read",
      read: { criterionIds: ["c1"], mappings: [], uncovered: [] },
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(reviewStoreMock.recordCoverageClear).toHaveBeenCalled();
    expect(reviewStoreMock.claimCoverageRound).not.toHaveBeenCalled();
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1605: an Orc-only project with zero children proceeds directly to review (no continuation claim, no spawn loop)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({ children: [] });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    reviewStoreMock.stateTransition.mockReturnValue(true);
    reviewStoreMock.getContractByProjectCardId.mockReturnValue({
      id: "pc_orc_only",
      project_card_id: 1,
      contract_digest: "d",
      created_at: new Date().toISOString(),
      contract_json: JSON.stringify({
        schema_version: 2,
        id: "pc_orc_only",
        digest: "d",
        project_card_id: 1,
        goal: "g",
        criteria: [{ id: "synthesis", description: "S", required: true, execution_owner: "orc", evidence_expectation: "synthesis" }],
        required_outputs: [],
        constraints: [],
        limits: { max_review_rounds: 5, max_repair_rounds: 3 },
        provenance: { requested_by: "u", authored_by: "orc", created_at: new Date().toISOString() },
      }),
    });
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "read",
      read: { criterionIds: ["synthesis"], mappings: [], uncovered: [] },
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    // review case creation is the owner — no scheduled continuation claim
    expect(claims).toHaveLength(0);
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
    expect(kanbanFailMock).not.toHaveBeenCalled();
    expect(reviewStoreMock.claimCoverageRound).not.toHaveBeenCalled();
  });

  it("#1605: a zero-child executing project WITH delegated criteria still claims the scheduled continuation (Orc must spawn Workers)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({ children: [] });
    reviewStoreMock.getContractByProjectCardId.mockReturnValue({
      id: "pc_delegated",
      project_card_id: 1,
      contract_digest: "d",
      created_at: new Date().toISOString(),
      contract_json: JSON.stringify({
        schema_version: 2,
        id: "pc_delegated",
        digest: "d",
        project_card_id: 1,
        goal: "g",
        criteria: [{ id: "lane1", description: "L", required: true, execution_owner: "delegated", evidence_expectation: "observed" }],
        required_outputs: [],
        constraints: [],
        limits: { max_review_rounds: 5, max_repair_rounds: 3 },
        provenance: { requested_by: "u", authored_by: "orc", created_at: new Date().toISOString() },
      }),
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    // delegation exists → zero children is NOT this owner → continuation claim
    expect(claims).toHaveLength(1);
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
  });

  it("#1605: an executing project with a missing/unparseable contract is not this owner (gate blocks it)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({ children: [] });
    reviewStoreMock.getContractByProjectCardId.mockReturnValue(undefined);

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(claims).toHaveLength(1);
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
  });

  it("#1605: a corrupt/unreadable contract still fails closed as a structural block", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "undeterminable",
      reason: "root contract for project #1 is unparseable",
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(kanbanFailMock).toHaveBeenCalled();
    const coverageDispatches = claims.filter(c => c.goal.includes("[COVERAGE GAP]"));
    expect(coverageDispatches).toHaveLength(0);
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
  });

  it("#1605: repair re-entry with the same capped gap returns to review, never re-dispatches", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getLatestOpenCase.mockReturnValue(undefined);
    reviewStoreMock.stateTransition.mockReturnValue(true);
    // cap exhausted + unchanged signature → the gate returns reviewable
    reviewStoreMock.getSupervision.mockReturnValue(supervision({
      state: "executing",
      coverage_rounds: 3,
      coverage_signature: "cov-sig",
      coverage_uncovered_ids: JSON.stringify(["c1"]),
      updated_at: new Date().toISOString(),
    }));
    readProjectCriterionCoverageMock.mockReturnValue({
      kind: "read",
      read: { criterionIds: ["c1"], mappings: [], uncovered: ["c1"] },
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(reviewStoreMock.claimCoverageRound).not.toHaveBeenCalled();
    expect(reviewStoreMock.recordCoverageReviewable).toHaveBeenCalledWith(1, "cov-sig", ["c1"]);
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 });
    const coverageDispatches = claims.filter(c => c.goal.includes("[COVERAGE GAP]"));
    expect(coverageDispatches).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("classifies reviewing with an open case as review ownership (never a fresh authoring claim)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    mod.setOrcCoordinator({
      scheduleScheduledProject: (projectCardId: number, goal: string) => {
        claims.push({ projectCardId, goal });
        return { kind: "claimed" as const, context: { runId: "or_1", projectCardId } };
      },
      scheduleReview: () => ({ kind: "claimed" as const, context: { runId: "or_r", projectCardId: 1 } }),
    } as never);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "reviewing" }));
    reviewStoreMock.getLatestOpenCase.mockReturnValue({ id: "rc_open", project_card_id: 1, status: "open", round: 1 } as never);
    reviewStoreMock.getReviewRequestByCaseId.mockReturnValue({ id: "rr_1", status: "pending" });

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(reviewStoreMock.getReviewRequestByCaseId).toHaveBeenCalledWith("rc_open");
  });

  it("classifies reviewing with no open case and no live Orc row as none → continuation claim", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "reviewing" }));

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
  });

  it("treats a live Orc claim matching the generation as an existing owner — no second claim", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    getLiveRunForProjectMock.mockReturnValue({ project_generation: 1, id: "or_live" });

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("treats a stale-generation live Orc row as not an owner (claim attempt resolves it)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    getLiveRunForProjectMock.mockReturnValue({ project_generation: 2, id: "or_stale" });

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
  });

  it("never settles on a busy claim — the existing live run owns the project", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    mod.setOrcCoordinator({
      scheduleScheduledProject: (projectCardId: number, _goal: string) => {
        claims.push({ projectCardId, goal: _goal });
        // busy means a live row exists — the next pass observes it as an owner
        getLiveRunForProjectMock.mockReturnValue({ project_generation: 1, id: "or_busy" });
        return { kind: "busy" as const, activeRunId: "or_busy" };
      },
      scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
    } as never);
    setupExecutingProject();

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("re-derives ownership once on conflict and settles only when the second pass still finds no owner", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    let conflictFirst = true;
    mod.setOrcCoordinator({
      scheduleScheduledProject: (projectCardId: number, goal: string) => {
        claims.push({ projectCardId, goal });
        if (conflictFirst) {
          conflictFirst = false;
          return { kind: "conflict" as const, reason: "project_generation_mismatch" };
        }
        return { kind: "conflict" as const, reason: "project_generation_mismatch" };
      },
      scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
    } as never);
    setupExecutingProject();

    mod.requestReconcile(1);
    await flush();

    // conflict → re-read (still none) → one retry claim → still conflict → the
    // driver freezes the project through the last-resort path (the focused
    // real-store test proves the exactly-once settler half)
    expect(claims).toHaveLength(2);
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(
      1,
      expect.arrayContaining(["executing", "needs_input", "reviewing"]),
      "blocked",
      expect.anything(),
    );
  });

  it("does not settle when a conflict re-derive finds an owner", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    mod.setOrcCoordinator({
      scheduleScheduledProject: (projectCardId: number, goal: string) => {
        claims.push({ projectCardId, goal });
        // another writer advanced the project during the claim attempt
        reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "accepted" }));
        return { kind: "conflict" as const, reason: "project_generation_mismatch" };
      },
      scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
    } as never);
    setupExecutingProject();

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("terminal roots (accepted/blocked) are no-ops", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "blocked" }));

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("duplicate wakes do not duplicate work", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();

    for (let i = 0; i < 5; i++) {
      mod.requestReconcile(1);
    }
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(claims).toHaveLength(1);
  });

  it("falls through to the no-owner decision when needs_input has neither pending nor answered requests", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "needs_input" }));
    reviewStoreMock.getAnsweredInputRequests.mockReturnValue([]);
    reviewStoreMock.getPendingInputRequests.mockReturnValue([]);

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
    expect(reviewStoreMock.setState).not.toHaveBeenCalled();
  });

  it("resumes needs_input through the existing transition when requests are answered", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "needs_input" }));
    reviewStoreMock.getAnsweredInputRequests.mockReturnValue([{ id: "ir_1", question: "q", response_text: "a" }]);
    reviewStoreMock.stateTransition.mockReturnValue(true);

    mod.requestReconcile(1);
    await flush();

    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["needs_input"], "executing");
    expect(claims).toHaveLength(0);
  });

  it("treats pending input requests as the input owner", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "needs_input" }));
    reviewStoreMock.getAnsweredInputRequests.mockReturnValue([]);
    reviewStoreMock.getPendingInputRequests.mockReturnValue([{ id: "ir_1", project_card_id: 1 }]);

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
  });

  it("falls through to the no-owner decision when repair_planned has no repair items", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "repair_planned" }));
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({ action: "repair", repair: { items: [] } }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
  });

  it("reuses an existing repair Worker after a crash before repair state transition", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    fakeCoordinator(claims);
    setupExecutingProject();

    let repairState: "repair_planned" | "repairing" = "repair_planned";
    reviewStoreMock.getSupervision.mockImplementation(() => supervision({ state: repairState }));
    reviewStoreMock.setState.mockImplementation((_projectId: number, nextState: string) => {
      repairState = nextState as "repair_planned" | "repairing";
    });
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_repair_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({
        action: "repair",
        repair: {
          items: [
            { id: "r1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: { max_tokens: 1000 } },
            { id: "r2", affected_criterion_ids: ["c2"], strategy: "rewrite", required_evidence: "synthesis", capabilities: [], budget: { max_tokens: 1000 } },
          ],
        },
      }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });

    const existingRepair = { ...makeCard({ id: 2, status: "queued", type: "W", goal: "Repair: rework" }), parent_id: 1 };
    kanbanGetChildrenMock.mockReturnValue([existingRepair]);
    getContractForCardMock.mockImplementation((cardId: number) => cardId === 2 ? {
      id: "c_existing_repair",
      goal: "Repair: rework",
      supports_root_criteria: ["c1"],
      provenance: { root_card_id: 1 },
    } : undefined);

    mod.requestReconcile(1);
    await flush();

    expect(spawnChildMock).toHaveBeenCalledTimes(1);
    expect(spawnChildMock).toHaveBeenCalledWith(1, expect.objectContaining({
      goal: expect.stringContaining("[repair-item:r2]"),
    }));
    expect(spawnChildMock.mock.calls[0]?.[1]?.goal).not.toContain("r1");
    expect(reviewStoreMock.setState).toHaveBeenCalledWith(1, "repairing");
  });
});
