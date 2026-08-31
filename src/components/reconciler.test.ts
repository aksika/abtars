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

// #1628: fake run store with zeroed authoring counters — the reconciler's
// ceilings read through getStore() before every authoring claim.
function makeFakeRunStore() {
  return {
    countStartedAuthoringTurns: () => 0,
    countConsecutiveUnstartableAuthoringTurns: () => 0,
    lastAuthoringClaimAt: () => null,
    lastAuthoringFailureCode: () => null,
  };
}

const dispatchMock = vi.fn();
const spawnChildMock = vi.fn();
vi.mock("./spin.js", () => ({
  spin: { dispatch: dispatchMock, spawnChild: spawnChildMock },
}));

// #1707: the durable occurrence gate reads the real task catalog, which this
// mocked-environment file does not provide (cards are kanbanGetCard mocks).
// Default to "active" so driver tests exercise the claim paths; the terminal
// boundary itself is covered by the real-store reconciler-last-resort suite.
vi.mock("./tasks/scheduled-occurrence-gate.js", () => ({
  isScheduledRootIdentity: (card: { type?: string; parent_id?: number | null; source?: string; source_id?: string | null }): boolean =>
    card.type === "O" && card.parent_id === null && card.source === "task" && !!card.source_id && card.source_id.length > 0,
  findActiveScheduledOccurrence: (): undefined => undefined,
  scheduledOccurrenceState: (): "active" => "active",
  inspectScheduledOccurrence: (): { state: "terminal" } => ({ state: "terminal" }),
}));


const kanbanGetCardMock = vi.fn();
const kanbanGetChildrenMock = vi.fn();
const isUnblockedMock = vi.fn().mockReturnValue(true);
const kanbanUpdateMock = vi.fn();
const cascadeFailMock = vi.fn();
const kanbanFailMock = vi.fn();
const kanbanCompleteMock = vi.fn();
const kanbanRunningProjectIdsMock = vi.fn().mockReturnValue([]);
const kanbanStrandedQueuedProjectIdsMock = vi.fn().mockReturnValue([]);
const kanbanQueuedDispatchOrderMock = vi.fn().mockReturnValue([]);
const kanbanPromoteDueRetryMock = vi.fn().mockReturnValue(false);
const resolveRootIdMock = vi.fn().mockReturnValue(undefined);
vi.mock("./tasks/kanban-board.js", () => ({
  kanbanFail: kanbanFailMock,
  kanbanComplete: kanbanCompleteMock,
  kanbanUpdate: kanbanUpdateMock,
  kanbanGetCard: kanbanGetCardMock,
  kanbanGetChildren: kanbanGetChildrenMock,
  kanbanRunningProjectIds: kanbanRunningProjectIdsMock,
  kanbanStrandedQueuedProjectIds: kanbanStrandedQueuedProjectIdsMock,
  kanbanQueuedDispatchOrder: kanbanQueuedDispatchOrderMock,
  kanbanPromoteDueRetry: kanbanPromoteDueRetryMock,
  resolveRootId: resolveRootIdMock,
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

// ── #1664: quarantine store mock ─────────────────────────────────────────────
// The reconciler caches one store instance per module, so the mock class reads
// a mutable state object that each test (re)configures. resetModules() is used
// in the construction-failure test to force a fresh module-level singleton.
interface RecordedFailure {
  cardId: number;
  signature: string;
  now: string;
}
let quarantineState: {
  quarantined: Set<number>;
  recorded: RecordedFailure[];
  cleared: number[];
  throwOnConstruct: boolean;
  throwOnLookup: boolean;
  throwOnRecord: boolean;
  throwOnClear: boolean;
  resultFor: (cardId: number, signature: string, now: string) => { cardId: number; failureCount: number; errorSignature: string; lastErrorAt: string; quarantinedAt: string | null };
};

vi.mock("./reconcile-quarantine-store.js", () => ({
  ReconcileQuarantineStore: class {
    constructor() {
      if (quarantineState.throwOnConstruct) throw new Error("store construct failed");
    }
    isQuarantined(cardId: number): boolean {
      if (quarantineState.throwOnLookup) throw new Error("store lookup failed");
      return quarantineState.quarantined.has(cardId);
    }
    recordFailure(cardId: number, signature: string, now: string) {
      if (quarantineState.throwOnRecord) throw new Error("store record failed");
      quarantineState.recorded.push({ cardId, signature, now });
      return quarantineState.resultFor(cardId, signature, now);
    }
    clearFailures(cardId: number): void {
      if (quarantineState.throwOnClear) throw new Error("store clear failed");
      quarantineState.cleared.push(cardId);
    }
  },
  reconcileErrorSignature: (err: unknown) =>
    err instanceof Error ? `${err.name}:${err.message}` : String(err),
}));

const getLatestAttemptMock = vi.fn().mockReturnValue(null);
const getResultByAttemptMock = vi.fn().mockReturnValue(undefined);
/** #1686: durable source-contract reads for the repair path. */
const getContractMock = vi.fn().mockReturnValue(undefined);
const getAttemptsForCardMock = vi.fn().mockReturnValue([]);
const getContractByCardIdMock = vi.fn().mockReturnValue(undefined);
/** #1656: lifecycle the adapter mock reports after a synchronous start settle. */
let attemptLifecycleOverride: string | null = null;
const workerContractExistsMock = vi.fn().mockReturnValue(true);
const claimAttemptMock = vi.fn().mockImplementation((cardId: number, contractId: string, executorKind: string, executorId: string, generation: number) => ({
  attemptId: "a_1", cardId, contractId, executorKind, executorId, generation, claimedAt: new Date().toISOString(),
}));
const deferClaimAfterProvenNoStartMock = vi.fn().mockReturnValue("deferred");
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
      getResultByAttempt = getResultByAttemptMock;
      getActiveSupervisedAttempts = () => [];
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
      deferClaimAfterProvenNoStart = deferClaimAfterProvenNoStartMock;
      // #1686: repair source-contract resolution reads.
      getContract = getContractMock;
      getAttemptsForCard = getAttemptsForCardMock;
      getContractByCardId = getContractByCardIdMock;
    },
  };
});

vi.mock("./spin-worker-adapter.js", () => ({
  SpinWorkerAdapter: class {
    capacity = vi.fn().mockResolvedValue({ available: 3, max: 3 });
    start = vi.fn().mockImplementation(async (claim: { cardId: number }) => {
      dispatchMock({ type: "W", cardId: claim.cardId });
      // #1656: an executor-settled lane (Pi) settles the attempt synchronously
      // inside start and leaves the W card untransitioned.
      attemptLifecycleOverride = "completed";
      return { kind: "started", attemptId: "a_1", generation: 1, executorId: "spin-local" };
    });
    cancel = vi.fn().mockResolvedValue({ kind: "cancelled", attemptId: "a_1" });
  },
}));

// These are imported by reconcileProject / evaluateLease — mock as no-ops
vi.mock("./executor-lease-store.js", () => {
  const MockExecutorLeaseStore = vi.fn().mockImplementation(() => ({
    getSnapshot: vi.fn().mockReturnValue(null),
    getEvaluationSchedule: vi.fn().mockReturnValue([]),
    getDueSnapshots: vi.fn().mockReturnValue([]),
  }));
  (MockExecutorLeaseStore as unknown as { onLeaseChanged?: () => void }).onLeaseChanged = undefined;
  (MockExecutorLeaseStore as unknown as { lastChangedCardId?: number }).lastChangedCardId = undefined;
  return { ExecutorLeaseStore: MockExecutorLeaseStore };
});

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

// #1751: the continuation not_actionable guard re-reads the Orc snapshot at
// the decision point. A controllable double lets the tests drive the durable
// owner flags directly instead of reproducing the 65 ms transition window by
// timing.
const readOrcProjectSnapshotMock = vi.fn();
vi.mock("./orc-project/orc-intent-policy.js", () => ({
  readOrcProjectSnapshot: (db: unknown, projectCardId: number) => readOrcProjectSnapshotMock(db, projectCardId),
}));

const hasLiveContributionForProjectMock = vi.fn().mockReturnValue(false);
vi.mock("./peer-help/contribution-store.js", () => ({
  ContributionStore: vi.fn(),
  hasLiveContributionForProject: hasLiveContributionForProjectMock,
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

// ── #1554: deterministic generation startup for the mocked environment ─────

let testGenerationCounter = 0;
let activeTestHandle: import("./reconciler.js").ReconcilerHandle | null = null;

function makeTestCoordinator(overrides: Record<string, unknown> = {}) {
  return {
    getStore: makeFakeRunStore,
    bootRecovery: () => [] as number[],
    onOwnershipReleased: () => () => {},
    scheduleContractAuthoring: () => ({ kind: "busy" as const, activeRunId: "or_unused" }),
    scheduleProjectExecution: () => ({ kind: "busy" as const, activeRunId: "or_unused" }),
    scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_review" }),
    ...overrides,
  };
}

const testWakeScheduler = {
  register: vi.fn(() => () => {}),
  sourceChanged: vi.fn(),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  safetyScan: vi.fn(),
} as unknown as import("./lifecycle-wake-scheduler.js").LifecycleWakeScheduler;

const testPiAdapter: import("./swarm-executor-types.js").SwarmExecutorAdapter = {
  kind: "pi",
  schedulingPolicy: { recovery: "inspectable" },
  capacity: async () => ({ available: 0, max: 0 }),
  start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }),
  cancel: async () => ({ kind: "cancelled", attemptId: "" }),
  inspect: async () => ({ kind: "running", lifecycle: "running" }),
};

async function startTestGeneration(
  mod2: typeof import("./reconciler.js") = mod,
  overrides: { coordinator?: unknown; workerAdapter?: unknown; piService?: unknown } = {},
): Promise<import("./reconciler.js").ReconcilerHandle> {
  const { SpinWorkerAdapter } = await import("./spin-worker-adapter.js");
  const { ReconcileQuarantineStore } = await import("./reconcile-quarantine-store.js");
  return mod2.startReconciler({
    generationId: `test-gen-${++testGenerationCounter}`,
    coordinator: { ...makeTestCoordinator(), ...(overrides.coordinator as Record<string, unknown> | undefined) } as never,
    wakeScheduler: testWakeScheduler,
    workerAdapter: (overrides.workerAdapter ?? new SpinWorkerAdapter()) as never,
    piService: (overrides.piService ?? null) as never,
    createPiAdapter: (() => testPiAdapter) as never,
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: () => {},
  } as never);
}

/** Stop the active generation and start a new one with different deps. */
async function swapTestGeneration(
  overrides: { coordinator?: unknown; workerAdapter?: unknown; piService?: unknown } = {},
): Promise<void> {
  await activeTestHandle?.stop();
  activeTestHandle = null;
  activeTestHandle = await startTestGeneration(mod, overrides);
}

  beforeEach(async () => {
  vi.clearAllMocks();
  resolveRootIdMock.mockReturnValue(undefined);
  quarantineState = {
    quarantined: new Set(),
    recorded: [],
    cleared: [],
    throwOnConstruct: false,
    throwOnLookup: false,
    throwOnRecord: false,
    throwOnClear: false,
    resultFor: (cardId, signature, now) => ({ cardId, failureCount: 1, errorSignature: signature, lastErrorAt: now, quarantinedAt: null }),
  };
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
  hasLiveContributionForProjectMock.mockReset();
  hasLiveContributionForProjectMock.mockReturnValue(false);
  readOrcProjectSnapshotMock.mockReset();
  readOrcProjectSnapshotMock.mockReturnValue({
    supervisionState: "executing",
    supervisionGeneration: 1,
    contractExists: true,
    projectTerminal: false,
    contributionActive: false,
    openReviewCase: false,
    inputRequestsOutstanding: false,
    ownerReadsComplete: true,
    workerOwnedChild: false,
    acceptedTerminalChildrenReady: false,
  });
  spawnChildMock.mockReset();
  mod = await import("./reconciler.js");
  activeTestHandle = await startTestGeneration();
});

afterEach(async () => {
  await activeTestHandle?.stop();
  activeTestHandle = null;
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
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending", executor_kind: "agent", executor_id: "spin-local", generation: 1 });
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
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending", executor_kind: "agent", executor_id: "spin-local", generation: 1 });
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
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "running", executor_kind: "agent", executor_id: "spin-local", generation: 1 });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued" }));
      mod.requestReconcile(1);
      await flush();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("two supervised card IDs can each make progress", async () => {
      cardHasContractMock.mockReturnValue(true);
      getContractForCardMock.mockReturnValue({ id: "c_1" });
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending", executor_kind: "agent", executor_id: "spin-local", generation: 1 });

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

    // #1656: executor-settled lanes (Pi) settle the attempt synchronously
    // inside adapter.start and never touch the W card; the pump projects the
    // card from the durable envelope via the exact-contract predicate.
    const completedContract = { id: "c_1", digest: "d", criteria: [{ id: "c1" }] };

    function envelopeWith(overrides: Record<string, unknown>): { envelope: unknown } {
      return {
        envelope: {
          schema_version: 1,
          outcome: "completed",
          attempt: { id: "a_1", ordinal: 1, contract_id: "c_1", contract_digest: "d", executor_kind: "pi", executor_id: "pi-coding", started_at: "", finished_at: "" },
          criteria: [{ criterion_id: "c1", status: "passed", evidence_ids: ["a1"] }],
          checks: [],
          artifacts: [],
          worker_report: { summary: "x", claims: [], unresolved_risks: [] },
          ...overrides,
        },
      };
    }

    function runPiStartProjection(cardId: number, envelope: unknown): Promise<void> {
      return (async () => {
        attemptLifecycleOverride = null;
        cardHasContractMock.mockReturnValue(true);
        getContractForCardMock.mockReturnValue(completedContract);
        getResultByAttemptMock.mockReturnValue(envelope);
        getLatestAttemptMock.mockImplementation(() => ({
          id: "a_1", lifecycle: attemptLifecycleOverride ?? "pending", executor_kind: "agent", executor_id: "spin-local", generation: 1,
        }));
        const card = { id: cardId, parent_id: 100, status: "queued", type: "W", title: "lane", priority: "MEDIUM", created_at: new Date().toISOString() } as any;
        // the projection must terminate the card like the real store does,
        // or the pump's dirty flag loops forever on the mock board
        kanbanFailMock.mockImplementation((id: number) => { if (id === cardId) card.status = "failed"; });
        kanbanCompleteMock.mockImplementation((id: number) => { if (id === cardId) card.status = "done"; });
        kanbanQueuedDispatchOrderMock.mockReturnValue([card]);
        kanbanGetCardMock.mockImplementation((id: number) => {
          if (id === cardId) return card;
          if (id === 100) return { id: 100, status: "running", max_tokens: null, tokens_used: 0, type: "O" } as any;
          return null;
        });
        mod.requestReconcile(cardId);
        await flush();
        await new Promise(r => setTimeout(r, 10));
        await flush();
      })();
    }

    it("#1656 fails the W card when a completed Pi attempt's envelope criteria did not pass", async () => {
      await runPiStartProjection(1, envelopeWith({ criteria: [{ criterion_id: "c1", status: "failed", evidence_ids: [] }] }));

      expect(kanbanFailMock).toHaveBeenCalledWith(1, "worker completed without passing acceptance");
      expect(kanbanCompleteMock).not.toHaveBeenCalled();
    });

    it("#1656 completes the W card when a completed Pi attempt's envelope passes exact acceptance", async () => {
      await runPiStartProjection(1, envelopeWith({}));

      expect(kanbanCompleteMock).toHaveBeenCalledWith(1, null, "worker completed");
      expect(kanbanFailMock).not.toHaveBeenCalled();
    });

    it("#1656 fails the W card when the envelope names a different contract than the attempt", async () => {
      await runPiStartProjection(1, envelopeWith({
        attempt: { id: "a_1", ordinal: 1, contract_id: "c_1", contract_digest: "other", executor_kind: "pi", executor_id: "pi-coding", started_at: "", finished_at: "" },
      }));

      expect(kanbanFailMock).toHaveBeenCalledWith(1, "worker completed without passing acceptance");
      expect(kanbanCompleteMock).not.toHaveBeenCalled();
    });

    it("#1656 fails the W card when a completed attempt has no persisted envelope", async () => {
      await runPiStartProjection(1, undefined);

      expect(kanbanFailMock).toHaveBeenCalledWith(1, "worker completed without passing acceptance");
      expect(kanbanCompleteMock).not.toHaveBeenCalled();
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
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "failed", executor_kind: "agent", executor_id: "spin-local", generation: 1 });
      kanbanGetCardMock.mockReturnValue(makeCard({ status: "failed" }));

      const localMod = await import("./reconciler.js");
      activeTestHandle = await startTestGeneration(localMod);
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

    it("#1638: a proven-no-start deferred observation returns the attempt to pending without settling", async () => {
      deferClaimAfterProvenNoStartMock.mockReturnValue("deferred");
      terminalSettlementMock.mockClear();
      deferClaimAfterProvenNoStartMock.mockClear();
      getLatestAttemptMock.mockReturnValue({ id: "a_1", lifecycle: "pending", executor_kind: "agent", executor_id: "spin-local", generation: 1 });
      cardHasContractMock.mockReturnValue(true);
      getContractForCardMock.mockReturnValue({ id: "c_1" });
      const piCard = { id: 2, parent_id: 100, status: "queued", type: "W", title: "coding", priority: "MEDIUM", created_at: new Date().toISOString() } as any;
      kanbanQueuedDispatchOrderMock.mockReturnValue([piCard]);
      kanbanGetCardMock.mockImplementation((id: number) => {
        if (id === 2) return piCard;
        if (id === 100) return { id: 100, status: "running", max_tokens: null, tokens_used: 0, type: "O" } as any;
        return null;
      });
      // Replace the adapter with a deferred-returning one — the branch is
      // executor-neutral (only Pi emits it today, but any adapter may).
      const mod2 = await import("./reconciler.js");
      await swapTestGeneration({
        workerAdapter: {
          kind: "agent",
          capacity: async () => ({ available: 1, max: 1 }),
          start: async () => ({ kind: "deferred", reason: "resource_busy", provesNoStart: true }),
          cancel: async () => ({ kind: "cancelled", attemptId: "a_1" }),
          inspect: async () => ({ kind: "running", lifecycle: "running" }),
        } as any,
      });
      mod2.requestReconcile(2);
      await flush();
      await new Promise(r => setTimeout(r, 10));
      await flush();
      expect(deferClaimAfterProvenNoStartMock).toHaveBeenCalledWith(expect.objectContaining({
        attemptId: "a_1", expectedGeneration: 1, reason: "resource_busy",
      }));
      expect(terminalSettlementMock).not.toHaveBeenCalled();
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

      it("supervised project with all-terminal children transitions to review_ready and claims one durable Orc review", async () => {
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

      // #1625: review dispatch is coordinator-owned after 0b4504a9 — install a
      // deterministic fake and assert the durable scheduleReview claim.
      const reviewClaims: Array<[number, number, string]> = [];
      await swapTestGeneration({
        coordinator: {
          getStore: makeFakeRunStore,
          scheduleContractAuthoring: () => ({ kind: "busy" as const, activeRunId: "or_unused" }),
          scheduleProjectExecution: () => ({ kind: "busy" as const, activeRunId: "or_unused" }),
          scheduleReview: (projectCardId: number, projectGeneration: number, reviewCaseId: string) => {
            reviewClaims.push([projectCardId, projectGeneration, reviewCaseId]);
            return { kind: "claimed" as const, context: { runId: `or_review_${projectCardId}`, projectCardId } };
          },
        } as never,
      });

      mod.requestReconcile(1);
      await flush();

      expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 }, { authority: { projectCardId: 1, projectGeneration: 1 } });
      expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["review_ready"], "review_requested", undefined, { authority: { projectCardId: 1, projectGeneration: 1 } });
      expect(reviewStoreMock.insertReviewRequest).toHaveBeenCalledWith(1, "rc_test_1", 1, undefined, { projectCardId: 1, projectGeneration: 1 });
      expect(reviewClaims).toEqual([[1, 1, "rc_test_1"]]);
      expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "O", cardId: 1 }));
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
        opts.attemptLifecycle === null ? null : { id: "a_1", lifecycle: opts.attemptLifecycle, executor_kind: "agent", executor_id: "spin-local", generation: 1 },
      );
    }
  }

  async function fakeCoordinator(claims: Array<{ projectCardId: number; goal: string }>) {
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleContractAuthoring: (projectCardId: number) => {
          claims.push({ projectCardId, goal: "contract_authoring" });
          getLiveRunForProjectMock.mockReturnValue({ project_generation: 1, id: `or_${projectCardId}` });
          return { kind: "claimed" as const, context: { runId: `or_${projectCardId}`, projectCardId } };
        },
        scheduleProjectExecution: (projectCardId: number, goal: string) => {
          claims.push({ projectCardId, goal });
          // a real claim creates the durable live Orc row the next pass observes
          getLiveRunForProjectMock.mockReturnValue({ project_generation: 1, id: `or_${projectCardId}` });
          return { kind: "claimed" as const, context: { runId: `or_${projectCardId}`, projectCardId } };
        },
        scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_review" }),
      } as never,
    });
  }

  it("routes a queued due scheduled root to the driver and promotes only after the continuation claim", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    // #1554: no generation = fail closed. A running generation always owns a
    // coordinator; without one, the request façade performs no mutation and
    // never settles.
    await activeTestHandle?.stop();
    activeTestHandle = null;

    mod.requestReconcile(1);
    await flush();
    await flush();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(kanbanPromoteDueRetryMock).not.toHaveBeenCalled();
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("keeps a future-dated queued scheduled root a no-op", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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

  it("leaves an unrelated parentless queued card without supervision on the legacy path", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued", type: "O", source: "agent", next_retry_at: new Date(Date.now() - 1000).toISOString() }));
    reviewStoreMock.hasActiveProjectSupervision.mockReturnValue(false);

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(kanbanPromoteDueRetryMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("#1618 routes a queued supervised peer root to the Orc coordinator, never the legacy drain", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued", type: "O", source: "peer", source_id: "req_1", next_retry_at: null }));
    reviewStoreMock.hasActiveProjectSupervision.mockReturnValue(true);
    reviewStoreMock.contractExists.mockReturnValue(false);
    // #1628: ensureAwaitingContract creates the row before the claim; the
    // ceilings read the supervision generation through getStore().
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "awaiting_contract" }));

    mod.requestReconcile(1);
    await flush();

    // the awaiting-contract authoring claim is owned by the coordinator
    expect(claims).toHaveLength(1);
    expect(claims[0]!.projectCardId).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("#1618 does not silently adopt a peer root without supervision", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    kanbanGetCardMock.mockReturnValue(makeCard({ status: "queued", type: "O", source: "peer", source_id: "req_2", next_retry_at: null }));
    reviewStoreMock.hasActiveProjectSupervision.mockReturnValue(false);
    reviewStoreMock.contractExists.mockReturnValue(false);

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("resumes a pending Worker attempt without a lease (worker_resume owns)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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

    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 }, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    expect(reviewStoreMock.insertReviewRequest).toHaveBeenCalledWith(1, "rc_test_1", 1, undefined, { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" });
    expect(claims).toHaveLength(0); // case creation is the Reconciler owner — no continuation claim
  });

  it("#1604: review_ready crash recovery with a stale gap never dispatches a coverage round or blocks", async () => {
    // A project already in review_ready (crash between the review_ready
    // transition and case insert) must recover through the continuation path.
    // The gate only guards the executing → review_ready ENTRY (design §3);
    // claimCoverageRound pins state='executing', so a stale gap here can never
    // be claimed — the recovery must not deadlock on it.
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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

    expect(reviewStoreMock.recordCoverageReviewable).toHaveBeenCalledWith(1, "cov-sig", ["c1"], { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" });
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 }, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1605: a new gap at the coverage-round cap proceeds to review, not a terminal block", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    expect(reviewStoreMock.recordCoverageReviewable).toHaveBeenCalledWith(1, "cov-sig", ["c1"], { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" });
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 }, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1605: a fully covered project proceeds to review without a coverage round", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 }, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1605: an Orc-only project with zero children proceeds directly to review (no continuation claim, no spawn loop)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 }, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    expect(kanbanFailMock).not.toHaveBeenCalled();
    expect(reviewStoreMock.claimCoverageRound).not.toHaveBeenCalled();
  });

  it("#1605: a zero-child executing project WITH delegated criteria still claims the scheduled continuation (Orc must spawn Workers)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    expect(reviewStoreMock.recordCoverageReviewable).toHaveBeenCalledWith(1, "cov-sig", ["c1"], { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" });
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 }, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    const coverageDispatches = claims.filter(c => c.goal.includes("[COVERAGE GAP]"));
    expect(coverageDispatches).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("classifies reviewing with an open case as review ownership (never a fresh authoring claim)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleProjectExecution: (projectCardId: number, goal: string) => {
          claims.push({ projectCardId, goal });
          return { kind: "claimed" as const, context: { runId: "or_1", projectCardId } };
        },
        scheduleReview: () => ({ kind: "claimed" as const, context: { runId: "or_r", projectCardId: 1 } }),
      } as never,
    });
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
    await fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "reviewing" }));

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
  });

  it("treats a live Orc claim matching the generation as an existing owner — no second claim", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    getLiveRunForProjectMock.mockReturnValue({ project_generation: 1, id: "or_live" });

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("treats a stale-generation live Orc row as not an owner (claim attempt resolves it)", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    getLiveRunForProjectMock.mockReturnValue({ project_generation: 2, id: "or_stale" });

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
  });

  it("#1680 waits under contribution_wait when an accepted contribution proxy is live — repeated wakes create no continuation", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject({ children: [{ ...makeCard({ id: 2, status: "running", type: "contribution" }), parent_id: 1 }] });
    hasLiveContributionForProjectMock.mockReturnValue(true);

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(claims).toHaveLength(0); // no post-contract Orc continuation
    expect(kanbanFailMock).not.toHaveBeenCalled(); // no terminal settlement

    // Repeated resync wakes remain idempotent no-ops.
    mod.requestReconcile(1);
    await flush();
    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();
    expect(claims).toHaveLength(0);
  });

  it("#1680 a live Orc row still owns its turn over contribution_wait", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject({ children: [{ ...makeCard({ id: 2, status: "running", type: "contribution" }), parent_id: 1 }] });
    hasLiveContributionForProjectMock.mockReturnValue(true);
    getLiveRunForProjectMock.mockReturnValue({ project_generation: 1, id: "or_live" });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    // The live Orc wins before contribution_wait — no continuation claim.
    expect(claims).toHaveLength(0);
  });

  it("#1680 applying the terminal event advances the next owner to review — no post-contract continuation", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleProjectExecution: (projectCardId: number, goal: string) => {
          claims.push({ projectCardId, goal });
          return { kind: "claimed" as const, context: { runId: `or_${projectCardId}`, projectCardId } };
        },
        scheduleReview: (projectCardId: number, _gen: number, _caseId: string) => {
          claims.push({ projectCardId, goal: "review" });
          return { kind: "claimed" as const, context: { runId: "or_review", projectCardId } };
        },
      } as never,
    });
    setupExecutingProject({ children: [{ ...makeCard({ id: 2, status: "running", type: "contribution" }), parent_id: 1 }] });
    hasLiveContributionForProjectMock.mockReturnValue(true);
    reviewStoreMock.stateTransition.mockReturnValue(true);

    // While the contribution is live the reconciler waits — no continuation claim.
    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();
    expect(claims.filter(c => c.goal !== "review")).toHaveLength(0);

    // The terminal event settles the ledger and terminalizes the proxy (the
    // reducer's job — simulated here by the durable-state change).
    hasLiveContributionForProjectMock.mockReturnValue(false);
    kanbanGetChildrenMock.mockReturnValue([{ ...makeCard({ id: 2, status: "done", type: "contribution" }), parent_id: 1 }]);

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    // The next owner is terminal-child review — review cases/requests are
    // created and the review is dispatched; no post-contract continuation.
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["executing", "review_ready"], "review_ready", { review_round: 1 }, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    expect(claims.filter(c => c.goal !== "review")).toHaveLength(0);
    expect(claims.filter(c => c.goal === "review").length).toBeGreaterThan(0);
  });

  it("never settles on a busy claim — the existing live run owns the project", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleProjectExecution: (projectCardId: number, _goal: string) => {
          claims.push({ projectCardId, goal: _goal });
          // busy means a live row exists — the next pass observes it as an owner
          getLiveRunForProjectMock.mockReturnValue({ project_generation: 1, id: "or_busy" });
          return { kind: "busy" as const, activeRunId: "or_busy" };
        },
        scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      } as never,
    });
    setupExecutingProject();

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("re-derives ownership once on conflict and settles only when the second pass still finds no owner", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    let conflictFirst = true;
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleProjectExecution: (projectCardId: number, goal: string) => {
          claims.push({ projectCardId, goal });
          if (conflictFirst) {
            conflictFirst = false;
            return { kind: "conflict" as const, reason: "project_generation_mismatch" };
          }
          return { kind: "conflict" as const, reason: "project_generation_mismatch" };
        },
        scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      } as never,
    });
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
      { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } },
    );
  });

  it("does not settle when a conflict re-derive finds an owner", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleProjectExecution: (projectCardId: number, goal: string) => {
          claims.push({ projectCardId, goal });
          // another writer advanced the project during the claim attempt
          reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "accepted" }));
          return { kind: "conflict" as const, reason: "project_generation_mismatch" };
        },
        scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      } as never,
    });
    setupExecutingProject();

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(1);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("terminal roots (accepted/blocked) are no-ops", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "blocked" }));

    mod.requestReconcile(1);
    await flush();

    expect(claims).toHaveLength(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("duplicate wakes do not duplicate work", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "done", type: "W" }), parent_id: 1 }],
    });
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "needs_input" }));
    reviewStoreMock.getAnsweredInputRequests.mockReturnValue([{ id: "ir_1", question: "q", response_text: "a" }]);
    reviewStoreMock.stateTransition.mockReturnValue(true);

    mod.requestReconcile(1);
    await flush();

    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["needs_input"], "executing", undefined, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    expect(claims).toHaveLength(0);
  });

  it("treats pending input requests as the input owner", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
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
    await fakeCoordinator(claims);
    setupExecutingProject();

    let repairState: "repair_planned" | "repairing" = "repair_planned";
    reviewStoreMock.getSupervision.mockImplementation(() => supervision({ state: repairState }));
    reviewStoreMock.stateTransition.mockImplementation((_projectId: number, fromStates: string[], nextState: string) => {
      if (!fromStates.includes(repairState)) return false;
      repairState = nextState as "repair_planned" | "repairing";
      return true;
    });
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_repair_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({
        action: "repair",
        repair: {
          items: [
            { id: "r1", source_contract_id: "c_source1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: { max_tokens: 1000 } },
            { id: "r2", source_contract_id: "c_source2", affected_criterion_ids: ["c2"], strategy: "rewrite", required_evidence: "synthesis", capabilities: [], budget: { max_tokens: 1000 } },
          ],
        },
      }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });
    const sourceContract = (id: string, root: number, supports: string[]) => ({
      id,
      contract_json: JSON.stringify({
        schema_version: 1,
        id,
        digest: "d1",
        goal: "lane",
        criteria: [{ id: "w1", description: "fetch" }],
        expected_artifacts: [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
        verification_commands: [],
        required_capabilities: [],
        supports_root_criteria: supports,
        limits: { max_tokens: 1000 },
        provenance: { root_card_id: root, card_id: 2, authored_by: "orc", created_at: new Date().toISOString() },
      }),
    });
    getContractMock.mockImplementation((id: string) => {
      if (id === "c_source1") return sourceContract("c_source1", 1, ["c1"]);
      if (id === "c_source2") return sourceContract("c_source2", 1, ["c2"]);
      return undefined;
    });
    getContractByCardIdMock.mockImplementation((cardId: number) => {
      if (cardId === 2) {
        return {
          id: "c_existing_repair",
          contract_json: JSON.stringify({
            schema_version: 1,
            id: "c_existing_repair",
            digest: "d2",
            goal: "Repair: rework [repair-item:r1]",
            revision_meta: { revision: 1, root_contract_id: "c_source1", parent_contract_id: "c_source1" },
            criteria: [{ id: "w1", description: "fetch" }],
            expected_artifacts: [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
            verification_commands: [],
            required_capabilities: [],
            supports_root_criteria: ["c1"],
            limits: {},
            provenance: { root_card_id: 1, card_id: 2, authored_by: "orc", created_at: new Date().toISOString() },
          }),
        };
      }
      if (cardId === 3) {
        return {
          id: "c_new_repair",
          contract_json: JSON.stringify({
            schema_version: 1,
            id: "c_new_repair",
            digest: "d3",
            goal: "Repair: rewrite [repair-item:r2]",
            revision_meta: { revision: 1, root_contract_id: "c_source2", parent_contract_id: "c_source2" },
            criteria: [{ id: "w1", description: "fetch" }],
            expected_artifacts: [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
            verification_commands: [],
            required_capabilities: [],
            supports_root_criteria: ["c2"],
            limits: {},
            provenance: { root_card_id: 1, card_id: 3, authored_by: "orc", created_at: new Date().toISOString() },
          }),
        };
      }
      return undefined;
    });

    const existingRepair = { ...makeCard({ id: 2, status: "queued", type: "W", goal: "Repair: rework [repair-item:r1]" }), parent_id: 1 };
    // After the spawn call, the durable children include the new r2 Worker —
    // the reconciler re-reads children before the repair_planned → repairing CAS.
    kanbanGetChildrenMock.mockImplementation(() => {
      const children = [existingRepair];
      if (spawnChildMock.mock.calls.length > 0) {
        children.push({ ...makeCard({ id: 3, status: "queued", type: "W", goal: "Repair: rewrite [repair-item:r2]" }), parent_id: 1 });
      }
      return children;
    });

    mod.requestReconcile(1);
    await flush();
    expect(spawnChildMock).toHaveBeenCalledTimes(1);
    expect(spawnChildMock).toHaveBeenCalledWith(1, expect.objectContaining({
      goal: expect.stringContaining("[repair-item:r2]"),
    }));
    expect(spawnChildMock.mock.calls[0]?.[1]?.goal).not.toContain("r1");
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(
      1,
      ["repair_planned"],
      "repairing",
      undefined,
      { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } },
    );
  });

  it("#1554: repair root resolution uses resolveRootId() directly — no Vitest fallback branch", async () => {
    // A repair round on a child card (1) whose ancestor root is card 7. The
    // spawned repair Worker contract must carry the RESOLVED root (7), never
    // the fallback projectId (1) that the deleted require/catch branch used
    // under Vitest.
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    resolveRootIdMock.mockReturnValue(7);
    let repairState: "repair_planned" | "repairing" = "repair_planned";
    reviewStoreMock.getSupervision.mockImplementation(() => supervision({ state: repairState }));
    reviewStoreMock.stateTransition.mockImplementation((_projectId: number, fromStates: string[], nextState: string) => {
      if (!fromStates.includes(repairState)) return false;
      repairState = nextState as "repair_planned" | "repairing";
      return true;
    });
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_root_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({
        action: "repair",
        repair: {
          items: [
            { id: "r1", source_contract_id: "c_source1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: { max_tokens: 1000 } },
          ],
        },
      }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });
    getContractMock.mockReturnValue({
      id: "c_source1",
      contract_json: JSON.stringify({
        schema_version: 1,
        id: "c_source1",
        digest: "d1",
        goal: "lane",
        criteria: [{ id: "w1", description: "fetch" }],
        expected_artifacts: [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
        verification_commands: [],
        required_capabilities: [],
        supports_root_criteria: ["c1"],
        limits: { max_tokens: 1000 },
        provenance: { root_card_id: 1, card_id: 2, authored_by: "orc", created_at: new Date().toISOString() },
      }),
    });
    getContractByCardIdMock.mockReturnValue(undefined);
    reviewStoreMock.getContractByProjectCardId.mockReturnValue({
      id: "pc_root_1",
      contract_json: JSON.stringify({ schema_version: 2, criteria: [{ id: "c1", description: "d" }] }),
    });
    kanbanGetChildrenMock.mockReturnValue([]);

    mod.requestReconcile(1);
    await flush();

    expect(resolveRootIdMock).toHaveBeenCalledWith(1);
    expect(spawnChildMock).toHaveBeenCalledTimes(1);
    expect(spawnChildMock.mock.calls[0]?.[1]?.contract?.provenance?.root_card_id).toBe(7);
  });

  // ── #1686: truthful, restart-safe repair lifecycle ──────────────────────────

  function sourceContractRow(id: string, supports: string[]) {
    return {
      id,
      contract_json: JSON.stringify({
        schema_version: 1,
        id,
        digest: `digest_${id}`,
        goal: "lane",
        criteria: [{ id: "w1", description: "fetch" }],
        expected_artifacts: [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
        verification_commands: [],
        required_capabilities: [],
        supports_root_criteria: supports,
        limits: { max_tokens: 1000 },
        provenance: { root_card_id: 1, card_id: 2, authored_by: "orc", created_at: new Date().toISOString() },
      }),
    };
  }

  function repairWorkerRow(cardId: number, goal: string, sourceId: string, supports: string[]) {
    return {
      id: `c_repair_${cardId}`,
      contract_json: JSON.stringify({
        schema_version: 1,
        id: `c_repair_${cardId}`,
        digest: `digest_repair_${cardId}`,
        goal,
        revision_meta: { revision: 1, root_contract_id: sourceId, parent_contract_id: sourceId },
        criteria: [{ id: "w1", description: "fetch" }],
        expected_artifacts: [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
        verification_commands: [],
        required_capabilities: [],
        supports_root_criteria: supports,
        limits: {},
        provenance: { root_card_id: 1, card_id: cardId, authored_by: "orc", created_at: new Date().toISOString() },
      }),
    };
  }

  it("#1686: a failed repair dispatch leaves the project in repair_planned — no repairing transition", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "repair_planned" }));
    reviewStoreMock.stateTransition.mockReturnValue(false);
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_partial_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({
        action: "repair",
        repair: {
          items: [
            { id: "r1", source_contract_id: "c_source1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: { max_tokens: 1000 } },
            { id: "r2", source_contract_id: "c_source2", affected_criterion_ids: ["c2"], strategy: "rewrite", required_evidence: "synthesis", capabilities: [], budget: { max_tokens: 1000 } },
          ],
        },
      }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });
    getContractMock.mockImplementation((id: string) => {
      if (id === "c_source1") return sourceContractRow("c_source1", ["c1"]);
      if (id === "c_source2") return sourceContractRow("c_source2", ["c2"]);
      return undefined;
    });
    getContractByCardIdMock.mockReturnValue(undefined);
    // r1's dispatch succeeds (its durable card appears), r2's dispatch fails.
    let spawnCount = 0;
    spawnChildMock.mockImplementation((_parentId: number, req: { goal: string }) => {
      if (req.goal.includes("r2")) throw new Error("transient dispatch failure");
      spawnCount++;
      return 3;
    });
    kanbanGetChildrenMock.mockImplementation(() => {
      const children: Array<ReturnType<typeof makeCard>> = [];
      if (spawnCount >= 1) {
        children.push({ ...makeCard({ id: 2, status: "queued", type: "W", goal: "Repair: rework [repair-item:r1]" }), parent_id: 1 });
      }
      return children;
    });

    mod.requestReconcile(1);
    await flush();

    // r1 was dispatched, r2 failed: partial dispatch must NOT advance state.
    expect(spawnCount).toBe(1);
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalledWith(1, ["repair_planned"], "repairing", undefined, expect.anything());
  });

  it("#1686: repairing with zero current-decision repair children recovers to repair_planned instead of opening another review round", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "repairing" }));
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_zero_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({
        action: "repair",
        repair: {
          items: [
            { id: "r1", source_contract_id: "c_source1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: {} },
          ],
        },
      }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });
    getContractMock.mockImplementation((id: string) => (id === "c_source1" ? sourceContractRow("c_source1", ["c1"]) : undefined));
    getContractByCardIdMock.mockReturnValue(undefined);
    // Only unrelated children exist — an original lane Worker and a repair
    // Worker from an older round without the current lineage.
    kanbanGetChildrenMock.mockReturnValue([
      { ...makeCard({ id: 10, status: "done", type: "W", goal: "Lane 1" }), parent_id: 1 },
      { ...makeCard({ id: 11, status: "done", type: "W", goal: "Repair: rework [repair-item:r-old]" }), parent_id: 1 },
    ]);
    reviewStoreMock.stateTransition.mockImplementation((_pid: number, fromStates: string[], nextState: string) => {
      if (fromStates.includes("repairing") && nextState === "repair_planned") return true;
      return false;
    });

    mod.requestReconcile(1);
    await flush();

    // The absent repair child routes the project back to repair planning —
    // never a new review generation.
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(1, ["repairing"], "repair_planned", undefined, { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } });
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalledWith(1, ["repairing"], "executing", { repair_round: 1 }, expect.anything());
  });

  it("#1686: unrelated children with the item marker but no source lineage do not satisfy a repair item", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    reviewStoreMock.getSupervision.mockReturnValue(supervision({ state: "repair_planned" }));
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_unrelated_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({
        action: "repair",
        repair: {
          items: [
            { id: "r1", source_contract_id: "c_source1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: {} },
          ],
        },
      }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });
    getContractMock.mockImplementation((id: string) => (id === "c_source1" ? sourceContractRow("c_source1", ["c1"]) : undefined));
    // The child carries the exact item marker but no revision lineage — it is
    // a pre-#1686 worker and cannot satisfy the item.
    getContractByCardIdMock.mockReturnValue({
      id: "c_orphan",
      contract_json: JSON.stringify({
        schema_version: 1,
        id: "c_orphan",
        digest: "d_orphan",
        goal: "Repair: rework [repair-item:r1]",
        criteria: [{ id: "w1", description: "fetch" }],
        expected_artifacts: [],
        verification_commands: [],
        required_capabilities: [],
        supports_root_criteria: ["c1"],
        limits: {},
        provenance: { root_card_id: 1, card_id: 5, authored_by: "orc", created_at: new Date().toISOString() },
      }),
    });
    kanbanGetChildrenMock.mockReturnValue([
      { ...makeCard({ id: 5, status: "queued", type: "W", goal: "Repair: rework [repair-item:r1]" }), parent_id: 1 },
    ]);

    mod.requestReconcile(1);
    await flush();

    // The orphan is NOT reused — a new evidence-preserving Worker is created.
    expect(spawnChildMock).toHaveBeenCalledTimes(1);
    expect(spawnChildMock.mock.calls[0]?.[1]?.contract?.revision_meta?.parent_contract_id).toBe("c_source1");
  });

  it("#1686: a legacy repair decision without a usable source contract blocks once with repair_source_contract_invalid", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    // The transition mutates durable state so the card:failed wake observes a
    // terminal project — otherwise the block would re-fire on every pass.
    let projectState: "repair_planned" | "blocked" = "repair_planned";
    reviewStoreMock.getSupervision.mockImplementation(() => supervision({ state: projectState }));
    reviewStoreMock.stateTransition.mockImplementation((_pid: number, fromStates: string[], nextState: string) => {
      if (!fromStates.includes(projectState)) return false;
      projectState = nextState as "repair_planned" | "blocked";
      return true;
    });
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_legacy_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({
        action: "repair",
        repair: {
          items: [
            { id: "r1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: {} },
          ],
        },
      }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });
    getContractMock.mockReturnValue(undefined);
    getContractByCardIdMock.mockReturnValue(undefined);
    kanbanGetChildrenMock.mockReturnValue([]);

    mod.requestReconcile(1);
    await flush();

    // One honest structural blocked outcome — no empty repair, no review loop.
    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(
      1,
      expect.arrayContaining(["repair_planned"]),
      "blocked",
      expect.objectContaining({ blocked_reason: expect.stringContaining("repair_source_contract_invalid") }),
      expect.anything(),
    );
    expect(spawnChildMock).not.toHaveBeenCalled();
    expect(kanbanFailMock).toHaveBeenCalled();
  });

  it("#1686: repairing transitions to a new review round exactly once when every current repair child is terminal", async () => {
    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await fakeCoordinator(claims);
    setupExecutingProject();
    let repairRound = 0;
    reviewStoreMock.getSupervision.mockImplementation(() => supervision({ state: "repairing", repair_round: repairRound }));
    reviewStoreMock.getLatestDecisionForProject.mockReturnValue({
      id: "rd_all_terminal_1",
      review_case_id: "rc_1",
      decision_json: JSON.stringify({
        action: "repair",
        repair: {
          items: [
            { id: "r1", source_contract_id: "c_source1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: {} },
            { id: "r2", source_contract_id: "c_source2", affected_criterion_ids: ["c2"], strategy: "rewrite", required_evidence: "synthesis", capabilities: [], budget: {} },
          ],
        },
      }),
      decision_digest: "d",
      created_at: new Date().toISOString(),
    });
    getContractMock.mockImplementation((id: string) => {
      if (id === "c_source1") return sourceContractRow("c_source1", ["c1"]);
      if (id === "c_source2") return sourceContractRow("c_source2", ["c2"]);
      return undefined;
    });
    getContractByCardIdMock.mockImplementation((cardId: number) => {
      if (cardId === 2) return repairWorkerRow(2, "Repair: rework [repair-item:r1]", "c_source1", ["c1"]);
      if (cardId === 3) return repairWorkerRow(3, "Repair: rewrite [repair-item:r2]", "c_source2", ["c2"]);
      return undefined;
    });
    // Both current repair children are terminal.
    kanbanGetChildrenMock.mockReturnValue([
      { ...makeCard({ id: 2, status: "done", type: "W", goal: "Repair: rework [repair-item:r1]" }), parent_id: 1 },
      { ...makeCard({ id: 3, status: "done", type: "W", goal: "Repair: rewrite [repair-item:r2]" }), parent_id: 1 },
    ]);
    reviewStoreMock.stateTransition.mockImplementation((_pid: number, fromStates: string[], nextState: string) => {
      if (fromStates.includes("repairing") && nextState === "executing") {
        repairRound = 1;
        return true;
      }
      return false;
    });

    mod.requestReconcile(1);
    await flush();

    expect(reviewStoreMock.stateTransition).toHaveBeenCalledWith(
      1,
      ["repairing"],
      "executing",
      { repair_round: 1 },
      { authority: { projectCardId: 1, projectGeneration: 1, scheduledRunId: "run-1" } },
    );
    expect(spawnChildMock).not.toHaveBeenCalled();
  });

  it("#1751: a live Worker owner defers a not_actionable continuation instead of last-resort abort", async () => {
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleProjectExecution: () => ({ kind: "not_actionable" as const, reason: "intent_not_actionable" as const }),
      } as never,
    });
    // Incident shape: the Worker card is still queued between its failed
    // attempt (`.275`) and its terminal transition (`.340`). The attempt is
    // already terminal, so the decision is a continuation claim — and the
    // durable snapshot still shows the Worker owning the project.
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "queued", type: "W" }), parent_id: 1 }],
      attemptLifecycle: "failed",
    });
    readOrcProjectSnapshotMock.mockReturnValue({
      supervisionState: "executing",
      supervisionGeneration: 1,
      contractExists: true,
      projectTerminal: false,
      contributionActive: false,
      openReviewCase: false,
      inputRequestsOutstanding: false,
      ownerReadsComplete: true,
      workerOwnedChild: true,
      acceptedTerminalChildrenReady: false,
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1751: true owner absence still reaches last-resort settlement", async () => {
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleProjectExecution: () => ({ kind: "not_actionable" as const, reason: "intent_not_actionable" as const }),
      } as never,
    });
    // Same setup and same claim result; the snapshot re-read at the decision
    // point shows the owner is gone (its attempt settled and the card
    // transitioned between claim and re-read) — the safety net must still
    // fire. An all-terminal child card would instead route to create_review,
    // so the child stays queued exactly as in the incident.
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "queued", type: "W" }), parent_id: 1 }],
      attemptLifecycle: "failed",
    });
    readOrcProjectSnapshotMock.mockReturnValue({
      supervisionState: "executing",
      supervisionGeneration: 1,
      contractExists: true,
      projectTerminal: false,
      contributionActive: false,
      openReviewCase: false,
      inputRequestsOutstanding: false,
      ownerReadsComplete: true,
      workerOwnedChild: false,
      acceptedTerminalChildrenReady: false,
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(kanbanFailMock).toHaveBeenCalledWith(1, "no scheduled Orc continuation owner after restart");
  });

  it("#1751: an incomplete owner snapshot defers instead of settling", async () => {
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
        scheduleProjectExecution: () => ({ kind: "not_actionable" as const, reason: "intent_not_actionable" as const }),
      } as never,
    });
    setupExecutingProject({
      children: [{ ...makeCard({ id: 2, status: "queued", type: "W" }), parent_id: 1 }],
      attemptLifecycle: "failed",
    });
    readOrcProjectSnapshotMock.mockReturnValue({
      supervisionState: "executing",
      supervisionGeneration: 1,
      contractExists: true,
      projectTerminal: false,
      contributionActive: false,
      openReviewCase: false,
      inputRequestsOutstanding: false,
      ownerReadsComplete: false,
      workerOwnedChild: false,
      acceptedTerminalChildrenReady: false,
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(kanbanFailMock).not.toHaveBeenCalled();
  });
});

// ── #1664: terminal reconcile error boundary ─────────────────────────────────

describe("Reconciler — #1664 error boundary", () => {
  /** A healthy queued W child under a running project, dispatched by the pump. */
  async function healthyChildDispatchScenario() {
    // #1554: earlier tests swapped in custom worker adapters; restore the
    // default mocked adapter so the pump actually starts (and dispatches)
    // the child.
    await swapTestGeneration();
    kanbanGetCardMock.mockImplementation((id: number) => {
      if (id === 1) throw new Error("deterministic failure #1664");
      if (id === 99) return makeCard({ id: 99, status: "running", type: "O", parent_id: null });
      return makeCard({ id: 2, status: "queued", type: "W", parent_id: 99 });
    });
    kanbanQueuedDispatchOrderMock.mockReturnValue([makeCard({ id: 2, status: "queued", type: "W", parent_id: 99 })]);
    kanbanPromoteDueRetryMock.mockReturnValue(true);
    cardHasContractMock.mockReturnValue(true);
    getLatestAttemptMock.mockReturnValue({ id: "a_2", lifecycle: "pending", executor_kind: "agent", executor_id: "spin-local", generation: 1 });
    getContractForCardMock.mockReturnValue({ id: "c_2", limits: {}, schema_version: 1, goal: "g", criteria: [], expected_artifacts: [], verification_commands: [], required_capabilities: [], supports_root_criteria: [], provenance: { root_card_id: 99, card_id: 2 } });
  }

  async function expectNoUnhandledRejection(drive: () => void): Promise<boolean> {
    let unhandled = false;
    const handler = () => { unhandled = true; };
    process.on("unhandledRejection", handler);
    try {
      drive();
      await flush();
    } finally {
      process.off("unhandledRejection", handler);
    }
    return unhandled;
  }

  it("contains a throwing reconcile pass: process survives, no unhandledRejection, healthy card still runs, failure row recorded", async () => {
    await healthyChildDispatchScenario();
    dispatchMock.mockClear();

    const unhandled = await expectNoUnhandledRejection(() => {
      mod.requestReconcile(1); // deterministic throw
      mod.requestReconcile(2); // healthy child
    });

    expect(unhandled).toBe(false);
    expect(quarantineState.recorded).toEqual([
      expect.objectContaining({ cardId: 1, signature: "Error:deterministic failure #1664" }),
    ]);
    // a second healthy card still reconciles in the same generation
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: "W", cardId: 2 }));
  });

  it("a successful pass clears the failure record", async () => {
    await healthyChildDispatchScenario();
    // pre-seed a recorded failure for a card that is about to pass
    quarantineState.recorded.push({ cardId: 2, signature: "Error:old", now: "2026-08-16T10:00:00.000Z" });

    await expectNoUnhandledRejection(() => mod.requestReconcile(2));

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: "W", cardId: 2 }));
    expect(quarantineState.cleared).toContain(2);
  });

  it("store lookup failure fails open and does not stop other cards", async () => {
    await healthyChildDispatchScenario();
    quarantineState.throwOnLookup = true;
    dispatchMock.mockClear();

    const unhandled = await expectNoUnhandledRejection(() => {
      mod.requestReconcile(1);
      mod.requestReconcile(2);
    });

    expect(unhandled).toBe(false);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: "W", cardId: 2 }));
  });

  it("recordFailure failure is contained: original throw logged, healthy card still runs", async () => {
    await healthyChildDispatchScenario();
    quarantineState.throwOnRecord = true;
    dispatchMock.mockClear();

    const unhandled = await expectNoUnhandledRejection(() => {
      mod.requestReconcile(1);
      mod.requestReconcile(2);
    });

    expect(unhandled).toBe(false);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: "W", cardId: 2 }));
  });

  it("clearFailures failure is contained on the success path", async () => {
    await healthyChildDispatchScenario();
    quarantineState.throwOnClear = true;
    dispatchMock.mockClear();

    const unhandled = await expectNoUnhandledRejection(() => mod.requestReconcile(2));

    expect(unhandled).toBe(false);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: "W", cardId: 2 }));
  });

  it("store construction failure fails open — a wake still reconciles behind the boundary", async () => {
    // #1554: the quarantine accessor constructs per generation start, so a
    // throwing constructor fails open at every boundary call. Start a fresh
    // generation under the throwing store on a fresh module instance.
    await activeTestHandle?.stop();
    activeTestHandle = null;
    quarantineState.throwOnConstruct = true;
    vi.resetModules();
    const freshMod = await import("./reconciler.js");
    activeTestHandle = await startTestGeneration(freshMod);
    kanbanGetCardMock.mockImplementation((id: number) => {
      if (id === 2) return makeCard({ id: 2, status: "queued", type: "W", parent_id: 99 });
      return makeCard({ id: 99, status: "running", type: "O", parent_id: null });
    });
    kanbanQueuedDispatchOrderMock.mockReturnValue([makeCard({ id: 2, status: "queued", type: "W", parent_id: 99 })]);
    kanbanPromoteDueRetryMock.mockReturnValue(true);
    cardHasContractMock.mockReturnValue(true);
    getLatestAttemptMock.mockReturnValue({ id: "a_2", lifecycle: "pending", executor_kind: "agent", executor_id: "spin-local", generation: 1 });
    getContractForCardMock.mockReturnValue({ id: "c_2", limits: {}, schema_version: 1, goal: "g", criteria: [], expected_artifacts: [], verification_commands: [], required_capabilities: [], supports_root_criteria: [], provenance: { root_card_id: 99, card_id: 2 } });
    dispatchMock.mockClear();

    let unhandled = false;
    const handler = () => { unhandled = true; };
    process.on("unhandledRejection", handler);
    try {
      freshMod.requestReconcile(2);
      await flush();
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toBe(false);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: "W", cardId: 2 }));
  });

  it("dispatch pump failures are contained with a logged handler, not a silent swallow", async () => {
    // Make the pump throw on its first pass: kanbanQueuedDispatchOrder throws
    // synchronously inside dispatchOnePass, which rejects runWorkerDispatch.
    await healthyChildDispatchScenario();
    kanbanQueuedDispatchOrderMock.mockImplementation(() => { throw new Error("dispatch pump failure"); });
    dispatchMock.mockClear();

    const unhandled = await expectNoUnhandledRejection(() => {
      mod.requestReconcile(1);
      mod.requestReconcile(2);
    });

    expect(unhandled).toBe(false);
  });

  it("three same-signature failures quarantine the card; the next wake is a no-op", async () => {
    // Script the store to quarantine once the third same-signature failure is
    // recorded, mirroring the store's own threshold logic.
    quarantineState.resultFor = (cardId, signature, now) => {
      const count = quarantineState.recorded.filter(r => r.cardId === cardId).length;
      if (count >= 3) quarantineState.quarantined.add(cardId);
      return { cardId, failureCount: count, errorSignature: signature, lastErrorAt: now, quarantinedAt: count >= 3 ? now : null };
    };
    await healthyChildDispatchScenario();
    kanbanGetCardMock.mockImplementation((id: number) => {
      if (id === 1) throw new Error("deterministic failure #1664");
      if (id === 99) return makeCard({ id: 99, status: "running", type: "O", parent_id: null });
      return makeCard({ id: 2, status: "queued", type: "W", parent_id: 99 });
    });
    const getCardCallsFor1 = () => kanbanGetCardMock.mock.calls.filter(c => c[0] === 1).length;

    // Each wake is driven separately so every pass is a fresh failure.
    const callsBefore = getCardCallsFor1();
    await expectNoUnhandledRejection(() => mod.requestReconcile(1));
    expect(getCardCallsFor1()).toBe(callsBefore + 1);
    await expectNoUnhandledRejection(() => mod.requestReconcile(1));
    expect(quarantineState.quarantined.has(1)).toBe(false);

    // third failure crosses the threshold
    await expectNoUnhandledRejection(() => mod.requestReconcile(1));
    expect(quarantineState.quarantined.has(1)).toBe(true);

    // fourth wake is a no-op — the throwing path is never entered again
    const callsBeforeFourth = getCardCallsFor1();
    await expectNoUnhandledRejection(() => mod.requestReconcile(1));
    expect(getCardCallsFor1()).toBe(callsBeforeFourth);
  });

  it("boot recovery does not re-arm a quarantined card and counts woken vs skipped", async () => {
    await healthyChildDispatchScenario();
    kanbanGetCardMock.mockImplementation((id: number) => {
      if (id === 63) return makeCard({ id: 63, status: "running", type: "O", parent_id: null });
      if (id === 99) return makeCard({ id: 99, status: "running", type: "O", parent_id: null });
      return makeCard({ id: 2, status: "queued", type: "W", parent_id: 99 });
    });
    kanbanRunningProjectIdsMock.mockReturnValue([63, 99]);
    kanbanStrandedQueuedProjectIdsMock.mockReturnValue([]);
    quarantineState.quarantined.add(63);
    dispatchMock.mockClear();
    reviewStoreMock.stateTransition.mockClear();
    kanbanFailMock.mockClear();

    const woken = mod.scanActiveProjects();
    await flush();
    await flush();

    expect(woken).toBe(1); // only the healthy card was woken
    // the quarantined card was never re-woken: no derive pass, no mutation calls
    expect(kanbanGetCardMock.mock.calls.filter(c => c[0] === 63).length).toBe(0);
    expect(kanbanFailMock).not.toHaveBeenCalled();
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalled();
    // a healthy card in the same scan still reconciles (unsupervised root
    // dispatches through the legacy Orc lane)
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: "O", cardId: 99 }));
  });

  it("quarantining a card leaves its durable rows untouched (no settlement, no kanban mutation)", async () => {
    // Durable rows (project_supervision, project_review_decisions, kanban
    // state) are store-owned and mocked here; the honest assertion is that no
    // mutation entry point fires while the card is quarantined.
    quarantineState.quarantined.add(1);
    quarantineState.recorded = [{ cardId: 1, signature: "Error:old", now: "2026-08-16T10:00:00.000Z" }];
    kanbanFailMock.mockClear();
    kanbanCompleteMock.mockClear();
    reviewStoreMock.stateTransition.mockClear();

    const unhandled = await expectNoUnhandledRejection(() => mod.requestReconcile(1));

    expect(unhandled).toBe(false);
    expect(kanbanFailMock).not.toHaveBeenCalled();
    expect(kanbanCompleteMock).not.toHaveBeenCalled();
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalled();
    expect(quarantineState.cleared).not.toContain(1); // no success path either
  });

  it("releasing a quarantine re-wakes the card on the next request (operator clear flow)", async () => {
    await healthyChildDispatchScenario();
    kanbanGetCardMock.mockImplementation((id: number) => {
      if (id === 1) throw new Error("deterministic failure #1664");
      if (id === 99) return makeCard({ id: 99, status: "running", type: "O", parent_id: null });
      return makeCard({ id: 2, status: "queued", type: "W", parent_id: 99 });
    });
    const getCardCallsFor1 = () => kanbanGetCardMock.mock.calls.filter(c => c[0] === 1).length;

    // quarantined: a wake is skipped
    quarantineState.quarantined.add(1);
    const callsBefore = getCardCallsFor1();
    await expectNoUnhandledRejection(() => mod.requestReconcile(1));
    expect(getCardCallsFor1()).toBe(callsBefore);

    // operator clears the quarantine (what /project unquarantine does)
    quarantineState.quarantined.delete(1);
    quarantineState.recorded = [];

    // the card reconciles again on the next wake
    await expectNoUnhandledRejection(() => mod.requestReconcile(1));
    expect(getCardCallsFor1()).toBe(callsBefore + 1);
    expect(quarantineState.recorded).toEqual([
      expect.objectContaining({ cardId: 1, signature: "Error:deterministic failure #1664" }),
    ]);
  });
});
