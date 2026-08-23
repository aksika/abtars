import { describe, it, expect, vi } from "vitest";
import { RecomposableMemoryRuntime } from "./memory-recomposition.js";
import type {
  AbtarsMemoryRuntime,
  MemoryCompositionDiagnostics,
} from "./memory-runtime.js";

vi.mock("./logger.js", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
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
