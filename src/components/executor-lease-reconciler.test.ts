/**
 * executor-lease-reconciler.test.ts — #1801 Task 2: generation-captured
 * cancellation wake notifies only from the durable terminal verdict.
 */
import { describe, it, expect, vi } from "vitest";
import { LeaseReconciliationService } from "./executor-lease-reconciler.js";

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    attemptId: "a_1",
    cardId: 1,
    claimGeneration: 1,
    executorKind: "agent",
    executorId: "spin-local",
    highWaterSequence: 1,
    stateVersion: 1,
    semanticState: "stalled",
    lastReceivedAt: now,
    lastLivenessAt: now,
    lastMeaningfulProgressAt: now,
    livenessDeadlineAt: now,
    progressDeadlineAt: now,
    evaluation: { phase: "healthy", inspectionCount: 0, version: 1 },
    updatedAt: now,
    ...overrides,
  } as never;
}

function makeAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "a_1",
    card_id: 1,
    contract_id: "c_1",
    ordinal: 1,
    executor_kind: "agent",
    executor_id: "spin-local",
    generation: 1,
    lifecycle: "running",
    claimed_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    hard_deadline_at: null,
    ...overrides,
  } as never;
}

function setupService(opts: {
  snapshot?: never;
  attempt?: never;
  latest?: { id: string; generation: number; lifecycle: string } | undefined;
  adapterCancel?: (claim: never, reason: never) => Promise<never>;
  terminalSettlementKind?: string;
  onTerminalAttempt?: (info: never) => void;
}) {
  const leaseStore = {
    getSnapshot: vi.fn().mockReturnValue(opts.snapshot ?? makeSnapshot()),
    updateEvaluation: vi.fn().mockReturnValue(true),
    setUpcomingEvaluation: vi.fn(),
    recordCancelIntent: vi.fn().mockReturnValue(true),
    closeLease: vi.fn(),
  };
  const supervisionStore = {
    getAttempt: vi.fn().mockReturnValue(opts.attempt ?? makeAttempt()),
    getLatestAttempt: vi.fn().mockReturnValue(
      opts.latest === undefined
        ? { id: "a_1", generation: 1, lifecycle: "cancelled" }
        : opts.latest,
    ),
    isAttemptTerminal: vi.fn(
      (lc: string) => ["completed", "failed", "cancelled", "timed_out"].includes(lc),
    ),
    terminalSettlement: vi
      .fn()
      .mockReturnValue({ kind: opts.terminalSettlementKind ?? "settled" }),
  };
  const adapter = {
    kind: "agent",
    schedulingPolicy: { recovery: "process_bound" },
    capacity: async () => ({ available: 3, max: 3 }),
    start: async () => ({ kind: "start_failed", reason: "x", retryable: false }),
    cancel: vi.fn().mockImplementation(
      opts.adapterCancel ??
        (async () => ({ kind: "cancelled", attemptId: "a_1" })),
    ),
    inspect: async () => ({ kind: "running", lifecycle: "running" }),
  };
  const onTerminalAttempt = vi.fn();
  const service = new LeaseReconciliationService(
    () => adapter as never,
    leaseStore as never,
    supervisionStore as never,
    undefined,
    { onTerminalAttempt: (opts.onTerminalAttempt as never) ?? (onTerminalAttempt as never) },
  );
  return { service, leaseStore, supervisionStore, adapter, onTerminalAttempt };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("#1801 cancellation wake", () => {
  it("notifies after adapter cancel settles a terminal attempt", async () => {
    const { service, onTerminalAttempt } = setupService({});
    service.evaluateAndAct("a_1", 1);
    await flush();
    expect(onTerminalAttempt).toHaveBeenCalledTimes(1);
    expect(onTerminalAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: 1, attemptId: "a_1" }),
    );
  });

  it("cancel_failed with a live attempt notifies nothing", async () => {
    const { service, onTerminalAttempt } = setupService({
      adapterCancel: (async () => ({ kind: "cancel_failed", reason: "x" })) as never,
      latest: { id: "a_1", generation: 1, lifecycle: "running" },
    });
    service.evaluateAndAct("a_1", 1);
    await flush();
    expect(onTerminalAttempt).not.toHaveBeenCalled();
  });

  it("rejection after a durable commit still notifies the winning verdict", async () => {
    const { service, onTerminalAttempt } = setupService({
      adapterCancel: (async () => {
        throw new Error("transport lost after commit");
      }) as never,
      latest: { id: "a_1", generation: 1, lifecycle: "cancelled" },
    });
    service.evaluateAndAct("a_1", 1);
    await flush();
    expect(onTerminalAttempt).toHaveBeenCalledTimes(1);
  });

  it("a terminal winner notifies even when the adapter reports cancel_failed", async () => {
    const { service, onTerminalAttempt } = setupService({
      adapterCancel: (async () => ({ kind: "cancel_failed", reason: "x" })) as never,
      latest: { id: "a_1", generation: 1, lifecycle: "completed" },
    });
    service.evaluateAndAct("a_1", 1);
    await flush();
    // Durable state — not the adapter observation — is the verdict.
    expect(onTerminalAttempt).toHaveBeenCalledTimes(1);
    expect(onTerminalAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "a_1" }),
    );
  });

  it("a replacement attempt is untouched by a stale callback", async () => {
    const { service, onTerminalAttempt } = setupService({
      latest: { id: "a_2", generation: 1, lifecycle: "pending" },
    });
    service.evaluateAndAct("a_1", 1);
    await flush();
    expect(onTerminalAttempt).not.toHaveBeenCalled();
  });

  it("hard-deadline settlement notifies without calling adapter.cancel", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const snapshot = makeSnapshot({ semanticState: "running" });
    const attempt = makeAttempt({ hard_deadline_at: past, lifecycle: "running" });
    const { service, adapter, onTerminalAttempt } = setupService({
      snapshot: snapshot as never,
      attempt: attempt as never,
      latest: { id: "a_1", generation: 1, lifecycle: "timed_out" },
      terminalSettlementKind: "settled",
    });
    service.evaluateAndAct("a_1", 1);
    await flush();
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(onTerminalAttempt).toHaveBeenCalledTimes(1);
  });

  it("missing adapter with a live attempt notifies nothing", async () => {    const leaseStore = {
      getSnapshot: vi.fn().mockReturnValue(makeSnapshot()),
      updateEvaluation: vi.fn().mockReturnValue(true),
      setUpcomingEvaluation: vi.fn(),
      recordCancelIntent: vi.fn().mockReturnValue(true),
      closeLease: vi.fn(),
    };
    const supervisionStore = {
      getAttempt: vi.fn().mockReturnValue(makeAttempt()),
      getLatestAttempt: vi
        .fn()
        .mockReturnValue({ id: "a_1", generation: 1, lifecycle: "running" }),
      isAttemptTerminal: vi.fn(
        (lc: string) => ["completed", "failed", "cancelled", "timed_out"].includes(lc),
      ),
      terminalSettlement: vi.fn().mockReturnValue({ kind: "settled" }),
    };
    const onTerminalAttempt = vi.fn();
    const service = new LeaseReconciliationService(
      () => undefined,
      leaseStore as never,
      supervisionStore as never,
      undefined,
      { onTerminalAttempt: onTerminalAttempt as never },
    );
    service.evaluateAndAct("a_1", 1);
    await flush();
    expect(onTerminalAttempt).not.toHaveBeenCalled();
  });
});
