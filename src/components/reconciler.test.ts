/**
 * reconciler.test.ts — #1792 cutover: unsupervised dispatch, executor recovery and error boundaries.
 *
 * Supervised-brain code was deleted from reconciler.ts (O-type roots are now
 * runner-owned: deriveAction returns early). Deleted exports: scanActiveProjects,
 * retryPendingReviewRequests, abortProjectById.
 *
 * Disposition per abproject/specs/1792/design.md "Test disposition and dead-code removal":
 * supervised progression, zero-child failure and scheduled-root scenarios were ported
 * to runner tests; this file retains unsupervised, executor recovery and unrelated
 * error-boundary behavior. Scan assumptions were replaced by bounded-audit scenarios.
 *
 * Replacement evidence (already passing, do not re-add here):
 *  - src/components/orc-project/orc-workflow-driver.test.ts (bounded audit)
 *  - src/components/orc-project/orc-workflow-runner.test.ts (settlement/progression)
 *  - src/tests/e2e/orc-workflow.e2e.test.ts journeys 1-10 (1/4/6 scheduled roots,
 *    2/3 zero-child/failure, 5 settlement, 8/9/10 input/repair/delivery)
 *
 * Retained: unsupervised W/B invisibility, W-child dispatch pump, #1656 Pi envelope
 * projection, #1638 proven-no-start defer, Pi lane, classification fail-closed,
 * O-type no-op (runner-owned), executor leases/recovery, #1664 quarantine/error boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const { logErrorMock } = vi.hoisted(() => ({ logErrorMock: vi.fn() }));
vi.mock("./logger.js", async () => {
  const actual = await vi.importActual<typeof import("./logger.js")>("./logger.js");
  return { ...actual, logError: logErrorMock };
});

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
const kanbanTransitionMock = vi.fn();
const sqliteNowMock = vi.fn().mockReturnValue("2026-09-07 00:00:00");
const kanbanRunningProjectIdsMock = vi.fn().mockReturnValue([]);
const kanbanStrandedQueuedProjectIdsMock = vi.fn().mockReturnValue([]);
const kanbanQueuedDispatchOrderMock = vi.fn().mockReturnValue([]);
const kanbanPromoteDueRetryMock = vi.fn().mockReturnValue(false);
const resolveRootIdMock = vi.fn().mockReturnValue(undefined);
vi.mock("./tasks/kanban-board.js", () => ({
  kanbanFail: kanbanFailMock,
  kanbanComplete: kanbanCompleteMock,
  kanbanTransition: kanbanTransitionMock,
  sqliteNow: sqliteNowMock,
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
let reviewStoreMock: ReturnType<typeof makeReviewStoreMock>;

// ── #1554: deterministic generation startup for the mocked environment ─────

let testGenerationCounter = 0;
let activeTestHandle: import("./reconciler.js").ReconcilerHandle | null = null;

function makeTestCoordinator(overrides: Record<string, unknown> = {}) {
  return {
    getStore: makeFakeRunStore,
    bootRecovery: () => [] as number[],
    onOwnershipReleased: () => () => {},
    // #1792: the coordinator schedule path is retired — the reconciler never
    // calls schedule* (only bootRecovery). No schedule fakes: any attempt
    // would throw on the missing method.
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
  kanbanTransitionMock.mockReset();
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
    allLanesTerminal: false,
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
        // #1778: attempt-correlated projections ride kanbanTransition now.
        kanbanTransitionMock.mockImplementation((req: { cardId: number; to: string }) => {
          if (req.cardId === cardId) card.status = req.to;
          return { kind: "applied", from: "queued" };
        });
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

      // #1778: the projection carries the deciding attempt identity.
      expect(kanbanTransitionMock).toHaveBeenCalled();
      expect(kanbanTransitionMock.mock.calls[0]?.[0]).toMatchObject(
        { cardId: 1, to: "failed", attemptId: "a_1", claimGeneration: 1 },
      );
      expect(kanbanCompleteMock).not.toHaveBeenCalled();
    });

    it("#1656 completes the W card when a completed Pi attempt's envelope passes exact acceptance", async () => {
      await runPiStartProjection(1, envelopeWith({}));

      expect(kanbanTransitionMock).toHaveBeenCalled();
      expect(kanbanTransitionMock.mock.calls[0]?.[0]).toMatchObject(
        { cardId: 1, to: "done", attemptId: "a_1", claimGeneration: 1 },
      );
      expect(kanbanFailMock).not.toHaveBeenCalled();
    });

    it("#1656 fails the W card when the envelope names a different contract than the attempt", async () => {
      await runPiStartProjection(1, envelopeWith({
        attempt: { id: "a_1", ordinal: 1, contract_id: "c_1", contract_digest: "other", executor_kind: "pi", executor_id: "pi-coding", started_at: "", finished_at: "" },
      }));

      expect(kanbanTransitionMock).toHaveBeenCalled();
      expect(kanbanTransitionMock.mock.calls[0]?.[0]).toMatchObject(
        { cardId: 1, to: "failed", attemptId: "a_1", claimGeneration: 1 },
      );
      expect(kanbanCompleteMock).not.toHaveBeenCalled();
    });

    it("#1656 fails the W card when a completed attempt has no persisted envelope", async () => {
      await runPiStartProjection(1, undefined);

      expect(kanbanTransitionMock).toHaveBeenCalled();
      expect(kanbanTransitionMock.mock.calls[0]?.[0]).toMatchObject(
        { cardId: 1, to: "failed", attemptId: "a_1", claimGeneration: 1 },
      );
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

  // #1792: the coordinator schedule path is retired — the reconciler owns no
  // Orc continuation claims, so the fake carries no schedule methods. The
  // `claims` array each test threads through stays empty by construction;
  // the behavioral asserts below (dispatch/kanban mocks) are what pin the
  // no-continuation cutover contract.
  async function fakeCoordinator(_claims: Array<{ projectCardId: number; goal: string }>) {
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
      } as never,
    });
  }

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

  it("#1751: a live Worker owner defers a not_actionable continuation instead of last-resort abort", async () => {
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
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
      allLanesTerminal: false,
    });

    mod.requestReconcile(1);
    await flush();
    await new Promise(r => setTimeout(r, 10));
    await flush();

    expect(kanbanFailMock).not.toHaveBeenCalled();
  });

  it("#1751: an incomplete owner snapshot defers instead of settling", async () => {
    await swapTestGeneration({
      coordinator: {
        getStore: makeFakeRunStore,
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
      allLanesTerminal: false,
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
    const lookupDiagnostics = logErrorMock.mock.calls.filter(([, message]) =>
      typeof message === "string" && message.startsWith("Quarantine lookup failed for card "),
    );
    expect(lookupDiagnostics).toHaveLength(1);
    expect(lookupDiagnostics[0]?.[1]).toContain("card 1");
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

  it("does not clear failures when shutdown cancels a queued wake", async () => {
    quarantineState.recorded.push({ cardId: 2, signature: "Error:prior", now: "2026-08-16T10:00:00.000Z" });
    mod.requestReconcile(2);

    await activeTestHandle!.stop();
    activeTestHandle = null;

    expect(quarantineState.cleared).not.toContain(2);
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

  it("boot recovery does not re-arm a quarantined card (quarantine retained post-#1792)", async () => {
    // Quarantine survives the #1792 cutover: wakeCard still fails closed on
    // quarantined cards, and startReconciler's active-project scan skips them.
    // O-type roots are runner-owned (deriveAction early-returns), so the healthy
    // root wakes as a no-op — no dispatch, no fail, no review mutation.
    await activeTestHandle?.stop();
    activeTestHandle = null;
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
    kanbanGetCardMock.mockClear();

    activeTestHandle = await startTestGeneration();
    await flush();
    await flush();

    // the quarantined card was never re-woken: no derive pass, no mutation calls
    expect(kanbanGetCardMock.mock.calls.filter(c => c[0] === 63).length).toBe(0);
    // the healthy root in the same scan did wake (proving woken-vs-skipped),
    // but as a runner-owned O-type no-op
    expect(kanbanGetCardMock.mock.calls.some(c => c[0] === 99)).toBe(true);
    expect(kanbanFailMock).not.toHaveBeenCalled();
    expect(reviewStoreMock.stateTransition).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ cardId: 99 }));
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
