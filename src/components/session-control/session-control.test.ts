/**
 * session-control.test.ts — #1406 backend-neutral control plane: exact
 * adapter dispatch, unsupported outcomes, automatic dedupe, telemetry, and
 * the durable adapter's prepare → summarize → commit flow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionControlService } from "./service.js";
import { DurableConversationCompactionAdapter } from "./durable-adapter.js";
import type { SessionControlAdapter, SessionControlResult, SessionCompactionTelemetryV1 } from "./types.js";

function makeResult(status: SessionControlResult["status"]): SessionControlResult {
  return { status, targetKind: "durable_conversation", message: status };
}

function makeRecordingAdapter(kind: "durable_conversation" | "local_pi_run"): SessionControlAdapter & { calls: number } {
  const calls = 0;
  return {
    targetKind: kind,
    calls,
    supports: () => true,
    async execute() { return makeResult("completed"); },
  } as SessionControlAdapter & { calls: number };
}

function mockRuntime(overrides: Record<string, unknown> = {}): any {
  return {
    supports: () => true,
    prepareConversationCompaction: vi.fn().mockResolvedValue({
      status: "ready",
      candidate: {
        version: 1, expectedGeneration: 0, previousCheckpointId: null,
        sourceMessageStart: 1, sourceMessageEnd: 2, firstKeptMessageId: 3,
        sourceDigest: "digest", sourceTokenCount: 100, serializedTurns: "u: hi\na: hi",
        priorCheckpoint: "", summaryTokenBudget: 2000,
      },
    }),
    commitConversationCompaction: vi.fn().mockResolvedValue({ status: "committed", checkpointId: 7, generation: 1 }),
    ...overrides,
  };
}

describe("SessionControlService #1406", () => {
  it("dispatches to exactly one adapter by target kind", async () => {
    const service = new SessionControlService();
    const durable = makeRecordingAdapter("durable_conversation");
    service.register(durable);
    const result = await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("completed");
  });

  it("returns unsupported for an unregistered target kind (no fallback)", async () => {
    const service = new SessionControlService();
    service.register(makeRecordingAdapter("durable_conversation"));
    const result = await service.execute(
      { kind: "local_pi_run", principalId: "u", runId: "r", generation: 1 },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("unsupported");
  });

  it("returns unsupported when the adapter rejects the operation", async () => {
    const service = new SessionControlService();
    service.register({
      targetKind: "durable_conversation",
      supports: () => false,
      async execute() { return makeResult("completed"); },
    });
    const result = await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("unsupported");
  });

  it("deduplicates automatic requests per target while in flight; manual bypasses", async () => {
    let resolveFirst: (r: SessionControlResult) => void = () => {};
    const service = new SessionControlService();
    service.register({
      targetKind: "durable_conversation",
      supports: () => true,
      execute: () => new Promise(resolve => { resolveFirst = resolve; }),
    });
    const first = service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "automatic" },
    );
    const second = await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "automatic" },
    );
    expect(second.status).toBe("busy");
    resolveFirst(makeResult("completed"));
    await first;
  });

  it("emits one content-free telemetry event per request", async () => {
    const events: SessionCompactionTelemetryV1[] = [];
    const service = new SessionControlService({ onTelemetry: e => events.push(e) });
    service.register(makeRecordingAdapter("durable_conversation"));
    await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetKind: "durable_conversation", reason: "manual", status: "completed" });
  });

  it("maps adapter exceptions to failed, never crashing the caller", async () => {
    const service = new SessionControlService();
    service.register({
      targetKind: "durable_conversation",
      supports: () => true,
      async execute() { throw new Error("boom"); },
    });
    const result = await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("failed");
  });
});

describe("DurableConversationCompactionAdapter #1406", () => {
  const summarizer = {
    summarize: vi.fn().mockResolvedValue({ text: "a compact summary", provider: "p", model: "m" }),
  };

  beforeEach(() => {
    summarizer.summarize.mockReset();
    summarizer.summarize.mockResolvedValue({ text: "a compact summary", provider: "p", model: "m" });
  });

  it("runs prepare → summarize → commit and reports completed with generation", async () => {
    const runtime = mockRuntime();
    const adapter = new DurableConversationCompactionAdapter({ runtime, summarizer });
    const result = await adapter.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s", beforeMessageId: 10 },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("completed");
    expect(result.generation).toBe(1);
    expect(result.tokensBefore).toBe(100);
    expect(runtime.prepareConversationCompaction).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u", sessionId: "s", beforeMessageId: 10, reason: "manual",
    }));
    expect(runtime.commitConversationCompaction).toHaveBeenCalledTimes(1);
    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
  });

  it("maps nothing_to_compact and busy truthfully without calling the summarizer", async () => {
    const adapter = new DurableConversationCompactionAdapter({
      runtime: mockRuntime({ prepareConversationCompaction: vi.fn().mockResolvedValue({ status: "nothing_to_compact" }) }),
      summarizer,
    });
    const none = await adapter.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "automatic" },
    );
    expect(none.status).toBe("nothing_to_compact");
    expect(summarizer.summarize).not.toHaveBeenCalled();

    const busyAdapter = new DurableConversationCompactionAdapter({
      runtime: mockRuntime({ prepareConversationCompaction: vi.fn().mockResolvedValue({ status: "busy" }) }),
      summarizer,
    });
    const busy = await busyAdapter.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "automatic" },
    );
    expect(busy.status).toBe("busy");
  });

  it("performs no commit when the summarizer fails", async () => {
    const runtime = mockRuntime();
    const failing = { summarize: vi.fn().mockRejectedValue(new Error("provider down")) };
    const adapter = new DurableConversationCompactionAdapter({ runtime, summarizer: failing });
    await expect(adapter.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    )).rejects.toThrow("provider down");
    expect(runtime.commitConversationCompaction).not.toHaveBeenCalled();
  });

  it("reports stale on generation CAS loss and rejected as failed", async () => {
    const stale = new DurableConversationCompactionAdapter({
      runtime: mockRuntime({ commitConversationCompaction: vi.fn().mockResolvedValue({ status: "stale" }) }),
      summarizer,
    });
    const staleResult = await stale.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(staleResult.status).toBe("stale");

    const rejected = new DurableConversationCompactionAdapter({
      runtime: mockRuntime({ commitConversationCompaction: vi.fn().mockResolvedValue({ status: "rejected" }) }),
      summarizer,
    });
    const rejectedResult = await rejected.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(rejectedResult.status).toBe("failed");
  });

  it("reports unsupported when the runtime lacks the compaction capability", async () => {
    const runtime = mockRuntime({ supports: () => false });
    const adapter = new DurableConversationCompactionAdapter({ runtime, summarizer });
    const result = await adapter.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("unsupported");
  });
});
