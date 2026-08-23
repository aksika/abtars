import { describe, it, expect, vi } from "vitest";
import {
  RecomposableMemoryRuntime,
  MemoryRecompositionSupervisor,
  createUnrefTimeoutScheduler,
  type CompositionAttemptResult,
} from "./memory-recomposition.js";
import type {
  AbtarsMemoryRuntime,
  MemoryCompositionDiagnostics,
} from "./memory-runtime.js";

vi.mock("./logger.js", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logTrace: vi.fn(),
}));

function makeReadyRuntime(overrides: Partial<AbtarsMemoryRuntime> = {}): AbtarsMemoryRuntime {
  return {
    state: "ready",
    capabilities: new Set(["recall", "recordMessage"]),
    routeSnapshot: { version: 1, state: "ready", generation: 7, retryEligible: 0, terminalUnknown: 0 },
    supports: vi.fn(() => true),
    recordMessage: vi.fn(async () => ({ id: 42 })),
    recall: vi.fn(async () => ({ hits: [], context: "" })),
    assembleSessionContext: vi.fn(async () => ({
      wakeUp: "",
      recall: "",
      coreKnowledge: "",
      soulBundle: { soul: "", profile: "", notes: "", memoryTools: "", coreFacts: "" },
    })),
    getRecentConversation: vi.fn(async () => []),
    getStatus: vi.fn(async () => ({
      totalMessages: 1, extractedMemories: 0, extractedByType: {},
      consolidationFiles: { daily: 0, weekly: 0, quarterly: 0 },
      ingestedDocuments: 0, preservedKeywords: 0, dbSizeBytes: 0, rejectedByScanner: 0,
    })),
    getSleepStatus: vi.fn(async () => ({ state: "idle" })),
    getCoreKnowledge: vi.fn(async () => ""),
    recordFeedback: vi.fn(async () => ({ ok: true })),
    embed: vi.fn(async () => ({ vectors: [], model: "m" })),
    runMaintenance: vi.fn(async () => ({ ok: true, summary: "ok" })),
    instantStore: vi.fn(async () => ({ stored: true as const, memoriesCount: 1, memoryId: 5, semanticRevision: 1 })),
    editMemory: vi.fn(async () => ({ ok: true as const, semanticRevision: 2 })),
    rebuildFtsIndexes: vi.fn(async () => ({ rebuilt: [] })),
    projectDurableContext: vi.fn(async () => ({ messages: [], estimatedTokens: 0, sourceMessageCount: 0 })),
    prepareConversationCompaction: vi.fn(async () => ({ status: "nothing_to_compact" as const })),
    commitConversationCompaction: vi.fn(async () => ({ status: "committed" as const, checkpointId: 1, generation: 1 })),
    dreamQuestions: {
      nextPending: vi.fn(async () => null),
      list: vi.fn(async () => ({ questions: [] })),
      markAsked: vi.fn(async () => ({ status: "asked" as const })),
      dismiss: vi.fn(async () => ({ status: "dismissed" as const })),
    },
    findSealedSecrets: vi.fn(async () => []),
    resolveSealedSecret: vi.fn(async () => ({ ok: true as const, value: "v", semanticRevision: 3 })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("RecomposableMemoryRuntime — stable reference across upgrade (#1706)", () => {
  it("starts unavailable and fail-closed with idle diagnostics", async () => {
    const controller = new RecomposableMemoryRuntime();
    const rt = controller.runtime;

    expect(rt.state).toBe("unavailable");
    expect(rt.supports("recall")).toBe(false);
    expect(rt.capabilities.size).toBe(0);
    await expect(rt.recall({ query: "q", userId: "u", limit: 1 })).rejects.toThrow(/unavailable/i);
    expect(rt.compositionDiagnostics).toEqual({ state: "idle", attempts: 0 });
  });

  it("upgraded delegate serves getters captured before the upgrade", () => {
    const controller = new RecomposableMemoryRuntime();
    const rt = controller.runtime;
    const ready = makeReadyRuntime();
    const capturedState = rt.state;
    const capturedRoute = rt.routeSnapshot;

    expect(controller.upgrade(ready)).toBe(true);

    expect(capturedState).toBe("unavailable"); // pre-upgrade reads stay honest
    expect(capturedRoute.state).toBe("unavailable");
    expect(rt.state).toBe("ready");
    expect(rt.capabilities.has("recall")).toBe(true);
    expect(rt.routeSnapshot.generation).toBe(7);
  });

  it("forwards representative read/write/nested calls to the current delegate", async () => {
    const controller = new RecomposableMemoryRuntime();
    const rt = controller.runtime;
    const capturedDreams = rt.dreamQuestions;
    const ready = makeReadyRuntime();

    controller.upgrade(ready);

    await rt.recordMessage({ userId: "u", sessionId: "s", role: "user", content: "hi", timestamp: Date.now() }, "op-1");
    expect(ready.recordMessage).toHaveBeenCalledTimes(1);

    await rt.recall({ query: "q", userId: "u", limit: 5 });
    expect(ready.recall).toHaveBeenCalledTimes(1);

    // Nested object captured BEFORE upgrade still reaches the ready runtime.
    await capturedDreams.nextPending("u");
    expect(ready.dreamQuestions.nextPending).toHaveBeenCalledWith("u");
    await capturedDreams.markAsked("u", "q1", "d1");
    expect(ready.dreamQuestions.markAsked).toHaveBeenCalledWith("u", "q1", "d1");

    await rt.commitConversationCompaction({
      userId: "u", sessionId: "s",
      candidate: {
        version: 1, expectedGeneration: 0, previousCheckpointId: null,
        sourceMessageStart: 0, sourceMessageEnd: 1, firstKeptMessageId: 0,
        sourceDigest: "d", sourceTokenCount: 10,
      },
      summary: "sum", summaryTokenCount: 3,
      summarizer: { provider: null, model: null }, activeRequestModel: null,
      reason: "manual",
    }, "op-key");
    expect(ready.commitConversationCompaction).toHaveBeenCalledTimes(1);

    await rt.close();
    expect(ready.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a second upgrade and leaves the first delegate installed", async () => {
    const controller = new RecomposableMemoryRuntime();
    const first = makeReadyRuntime();
    const second = makeReadyRuntime();

    expect(controller.upgrade(first)).toBe(true);
    expect(controller.upgrade(second)).toBe(false);

    await controller.runtime.recall({ query: "q", userId: "u", limit: 1 });
    expect(first.recall).toHaveBeenCalledTimes(1);
    expect(second.recall).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled(); // disposal is the caller's job
  });

  it("closes exactly once and only the installed runtime", async () => {
    const controller = new RecomposableMemoryRuntime();
    const ready = makeReadyRuntime();
    controller.upgrade(ready);

    await controller.runtime.close();
    await controller.runtime.close();

    expect(ready.close).toHaveBeenCalledTimes(1);
  });

  it("setDiagnostics replaces the snapshot immutably", () => {
    const controller = new RecomposableMemoryRuntime();
    const snapshot: MemoryCompositionDiagnostics = {
      state: "retrying",
      attempts: 3,
      lastAttemptAt: 1234,
      lastFailure: "endpoint_unavailable",
    };
    controller.setDiagnostics(snapshot);
    snapshot.attempts = 99;

    expect(controller.runtime.compositionDiagnostics).toEqual({
      state: "retrying",
      attempts: 3,
      lastAttemptAt: 1234,
      lastFailure: "endpoint_unavailable",
    });
  });
});

// ── Supervisor (#1706 Task 2) ───────────────────────────────────────────────

interface ManualTimer { fn: () => void; delayMs: number; cleared: boolean }

class ManualScheduler {
  readonly timers: ManualTimer[] = [];

  schedule(fn: () => void, delayMs: number): () => void {
    const t: ManualTimer = { fn, delayMs, cleared: false };
    this.timers.push(t);
    return () => { t.cleared = true; };
  }

  get pending(): ManualTimer[] {
    return this.timers.filter(t => !t.cleared);
  }

  fire(delayMs?: number): void {
    const t = this.pending.find(x => delayMs === undefined || x.delayMs === delayMs);
    if (!t) throw new Error(`no pending timer${delayMs === undefined ? "" : ` at ${delayMs}ms`}`);
    t.cleared = true;
    t.fn();
  }
}

function makeResult(): CompositionAttemptResult {
  return {
    mode: "local",
    client: { close: vi.fn(async () => undefined), negotiate: vi.fn() } as unknown as CompositionAttemptResult["client"],
    runtime: makeReadyRuntime({ state: "ready" }),
    abmindModule: null,
  };
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe("MemoryRecompositionSupervisor — backoff progression", () => {
  it("escalates 5s → 15s → 60s → 120s → 120s and stops after success", async () => {
    const scheduler = new ManualScheduler();
    let calls = 0;
    const supervisor = new MemoryRecompositionSupervisor({
      attempt: vi.fn(async () => {
        calls++;
        if (calls < 5) throw new Error("connection failed");
        return makeResult();
      }),
      classifyFailure: () => "endpoint_unavailable",
      publish: vi.fn(),
      dispose: vi.fn(async () => undefined),
      onDiagnostics: () => {},
      schedule: (fn, ms) => scheduler.schedule(fn, ms),
      delaysMs: [5_000, 15_000, 60_000],
      repeatDelayMs: 120_000,
    });

    supervisor.start();
    expect(supervisor.diagnostics.state).toBe("retrying");

    for (const expectedDelay of [5_000, 15_000, 60_000, 120_000]) {
      expect(scheduler.pending).toHaveLength(1);
      expect(scheduler.pending[0]!.delayMs).toBe(expectedDelay);
      scheduler.fire();
      await flush(); // settle the failed attempt + next arm
    }
    // fifth attempt succeeds at the second 120s tick
    expect(scheduler.pending[0]!.delayMs).toBe(120_000);
    scheduler.fire();
    await flush();

    expect(calls).toBe(5);
    expect(scheduler.pending).toHaveLength(0); // chain stopped after upgrade
    expect(supervisor.diagnostics.state).toBe("upgraded");
    expect(supervisor.diagnostics.upgradedAt).toBeDefined();
  });

  it("start is idempotent", async () => {
    const scheduler = new ManualScheduler();
    const supervisor = new MemoryRecompositionSupervisor({
      attempt: vi.fn(async () => { throw new Error("x"); }),
      classifyFailure: () => "endpoint_unavailable",
      publish: vi.fn(),
      dispose: vi.fn(async () => undefined),
      onDiagnostics: () => {},
      schedule: (fn, ms) => scheduler.schedule(fn, ms),
    });

    supervisor.start();
    supervisor.start();
    supervisor.start();

    expect(scheduler.pending).toHaveLength(1);
  });

  it("never overlaps attempts: a coalesced tick waits instead of stacking", async () => {
    const scheduler = new ManualScheduler();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    const supervisor = new MemoryRecompositionSupervisor({
      attempt: vi.fn(async () => {
        started++;
        await gate;
        throw new Error("slow negotiation");
      }),
      classifyFailure: () => "negotiation_failed",
      publish: vi.fn(),
      dispose: vi.fn(async () => undefined),
      onDiagnostics: () => {},
      schedule: (fn, ms) => scheduler.schedule(fn, ms),
    });

    supervisor.start();
    scheduler.fire(); // consumes T1 via the scheduler (marks it cleared)
    await flush();
    expect(started).toBe(1);

    // Forced duplicate tick while attempt 1 is in flight must coalesce.
    const tickFn = scheduler.timers[0]!.fn;
    tickFn();
    await flush();
    expect(started).toBe(1); // no second concurrent attempt

    release();
    await flush();
    await flush();
    // original chain rearmed itself exactly once; no attempt ran concurrently
    expect(started).toBe(1);
    expect(scheduler.pending).toHaveLength(1);

    scheduler.pending[0]!.fn();
    await flush();
    expect(started).toBe(2);
  });
});

describe("MemoryRecompositionSupervisor — cancellation precedence", () => {
  it("cancel before any timer fires: no attempt ever runs", async () => {
    const scheduler = new ManualScheduler();
    const attempt = vi.fn(async () => makeResult());
    const supervisor = new MemoryRecompositionSupervisor({
      attempt,
      classifyFailure: () => "endpoint_unavailable",
      publish: vi.fn(),
      dispose: vi.fn(async () => undefined),
      onDiagnostics: () => {},
      schedule: (fn, ms) => scheduler.schedule(fn, ms),
    });

    supervisor.start();
    const armed = scheduler.timers[0]!;
    await supervisor.cancel();

    expect(attempt).not.toHaveBeenCalled();
    expect(scheduler.pending).toHaveLength(0);
    expect(armed.cleared).toBe(true);
    expect(supervisor.diagnostics.state).toBe("cancelled");

    armed.fn(); // even a forced late tick must be terminal
    await flush();
    expect(attempt).not.toHaveBeenCalled();
  });

  it("cancel during a successful in-flight attempt: no publication, client disposed once", async () => {
    const scheduler = new ManualScheduler();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const result = makeResult();
    const publish = vi.fn();
    // Production dispose contract: close the negotiated client.
    const dispose = vi.fn(async (r: CompositionAttemptResult) => { await r.client.close(); });

    const supervisor = new MemoryRecompositionSupervisor({
      attempt: vi.fn(async () => { await gate; return result; }),
      classifyFailure: () => "endpoint_unavailable",
      publish,
      dispose,
      onDiagnostics: () => {},
      schedule: (fn, ms) => scheduler.schedule(fn, ms),
    });

    supervisor.start();
    scheduler.fire();
    await flush();
    expect(publish).not.toHaveBeenCalled(); // still gated

    const drained = supervisor.cancel();
    release();
    await drained;

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose.mock.calls[0]![0]).toBe(result);
    expect(result.client.close).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(supervisor.diagnostics.state).toBe("cancelled");
    expect(scheduler.pending).toHaveLength(0);
  });

  it("cancel after upgrade keeps upgraded diagnostics and publishes nothing twice", async () => {
    const scheduler = new ManualScheduler();
    const publish = vi.fn();
    const result = makeResult();
    const supervisor = new MemoryRecompositionSupervisor({
      attempt: vi.fn(async () => result),
      classifyFailure: () => "endpoint_unavailable",
      publish,
      dispose: vi.fn(async () => undefined),
      onDiagnostics: () => {},
      schedule: (fn, ms) => scheduler.schedule(fn, ms),
    });

    supervisor.start();
    scheduler.fire();
    await flush();
    expect(publish).toHaveBeenCalledWith(result);

    await supervisor.cancel();
    expect(supervisor.diagnostics.state).toBe("upgraded");
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("MemoryRecompositionSupervisor — diagnostics stream", () => {
  it("emits immutable snapshots with bounded failure codes", async () => {
    const scheduler = new ManualScheduler();
    const snapshots: MemoryCompositionDiagnostics[] = [];
    let calls = 0;
    const supervisor = new MemoryRecompositionSupervisor({
      attempt: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("pin mismatch");
        if (calls === 2) throw new Error("auth failed");
        return makeResult();
      }),
      classifyFailure: (err) => /pin/i.test(err instanceof Error ? err.message : "") ? "pin_mismatch" : "authentication_failed",
      publish: vi.fn(),
      dispose: vi.fn(async () => undefined),
      onDiagnostics: s => snapshots.push(s),
      schedule: (fn, ms) => scheduler.schedule(fn, ms),
      now: () => 42,
    });

    supervisor.start();
    scheduler.fire();
    await flush();
    scheduler.fire();
    await flush();
    scheduler.fire(); // third attempt succeeds
    await flush();

    const states = snapshots.map(s => s.state);
    expect(states[0]).toBe("retrying");
    expect(states[states.length - 1]).toBe("upgraded");
    // lastFailure is sticky across emissions; assert the ordered unique codes
    const failures = [...new Set(snapshots.filter(s => s.lastFailure !== undefined).map(s => s.lastFailure))];
    expect(failures).toEqual(["pin_mismatch", "authentication_failed"]);
    const final = supervisor.diagnostics;
    expect(final.attempts).toBe(3); // two failures + one success
    expect(final.lastAttemptAt).toBe(42);
    expect(final.state).toBe("upgraded");
    // snapshot immutability: mutating a returned copy must not corrupt internals
    final.attempts = 999;
    expect(supervisor.diagnostics.attempts).toBe(3);
  });
});

describe("createUnrefTimeoutScheduler — production timer factory", () => {
  it("schedules a real unref-ed timeout and clears it without leaving a live timer", () => {
    vi.useFakeTimers();
    try {
      const schedule = createUnrefTimeoutScheduler();
      const fired: number[] = [];
      const clear = schedule(() => fired.push(1), 10_000);
      clear();
      vi.advanceTimersByTime(20_000);
      expect(fired).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
