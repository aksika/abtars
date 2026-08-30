// The outer StreamFn protocol is tested below with Pi-shaped events. A live
// provider call remains environment-dependent and is covered by the provider
// package's own contract tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPiStreamFn } from "./pi-stream-fn.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
import type { ModelCandidate } from "./model-candidates.js";
import type { SimpleStreamOptions } from "./pi-core-types.js";

function makeRegistry() {
  return new ModelHealthRegistry();
}

function makeCandidate(overrides?: Partial<ModelCandidate>): ModelCandidate {
  return {
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
    ...overrides,
  };
}

function makeFakeStream(events: any[]): any {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const ev of events) yield ev;
    },
  };
}

describe("createPiStreamFn", () => {
  let registry: ModelHealthRegistry;
  let candidates: ModelCandidate[];
  let policy: FallbackPolicy;

  beforeEach(() => {
    registry = makeRegistry();
    candidates = [makeCandidate()];
    policy = new FallbackPolicy(candidates, registry);
  });

  it("returns a StreamFn", () => {
    const streamFn = createPiStreamFn({ policy, executionId: "test" });
    expect(typeof streamFn).toBe("function");
  });

  it("keeps the outer stream on Pi's terminal error protocol", async () => {
    const model = {
      id: "test-model",
      name: "test-model",
      api: "openai-completions" as const,
      provider: "test-provider",
      baseUrl: "https://api.test/v1",
      reasoning: false,
      input: ["text"] as ("text")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 128,
    };
    const streamFn = createPiStreamFn({
      policy,
      executionId: "test",
      createPiAiAttempt: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });
    const events: any[] = [];
    for await (const event of streamFn(model, { messages: [] })) events.push(event);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.error?.stopReason).toBe("error");
    expect(events.at(-1)?.error?.errorMessage).toBeTruthy();
  });

  it("succeeds with valid candidate", async () => {
    const fakeStream = makeFakeStream([
      { type: "text_delta", contentIndex: 0, delta: "Hello" },
      { type: "done", reason: "stop", message: { role: "assistant", content: "Hello", stopReason: "stop", usage: { input: 10, output: 5 } } },
    ]);

    const attemptFactory = vi.fn().mockResolvedValue(fakeStream);
    const streamFn = createPiStreamFn({ policy, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = { systemPrompt: "You are a bot.", messages: [{ role: "user", content: "hi" }] };
    const opts: SimpleStreamOptions = {};

    const stream = streamFn({ id: "test" }, ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("preserves candidate API format and thinking metadata", async () => {
    const candidate = makeCandidate({
      apiFormat: "responses",
      thinking: { style: "effort", default: "high" },
    });
    const metadataPolicy = new FallbackPolicy([candidate], registry);
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));

    const stream = createPiStreamFn({ policy: metadataPolicy, executionId: "test", createPiAiAttempt: attemptFactory })(
      { id: "test" }, { messages: [] }, {},
    );
    for await (const _event of stream) { /* consume */ }

    const model = attemptFactory.mock.calls[0]?.[1] as { api: string; reasoning: boolean };
    expect(model.api).toBe("openai-responses");
    expect(model.reasoning).toBe(true);
  });

  it("falls back on setup failure before commit", async () => {
    const failCandidate = makeCandidate({ model: "fail", endpoint: "https://fail/v1" });
    const goodCandidate = makeCandidate({ model: "good", endpoint: "https://good/v1" });
    const failPolicy = new FallbackPolicy([failCandidate, goodCandidate], registry);

    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("API error 500: server failure"))
      .mockResolvedValueOnce(makeFakeStream([
        { type: "text_delta", contentIndex: 0, delta: "Hello from fallback" },
        { type: "done", reason: "stop", message: { role: "assistant", content: "Hello from fallback", stopReason: "stop", usage: { input: 10, output: 5 } } },
      ]));

    const streamFn = createPiStreamFn({ policy: failPolicy, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = { systemPrompt: "", messages: [{ role: "user", content: "hi" }] };
    const opts: SimpleStreamOptions = {};

    const stream = streamFn({ id: "test" }, ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.some((e) => e.delta?.includes("Hello from fallback"))).toBe(true);
  });

  it("falls back to a prior rotation candidate when the selected candidate fails", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const rotatedPolicy = new FallbackPolicy([first, second], registry);
    rotatedPolicy.rotationExcludedKeys.add("first@https://first/v1");

    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("selected candidate unavailable"))
      .mockResolvedValueOnce(makeFakeStream([
        { type: "done", reason: "stop", message: { role: "assistant", content: "recovered", stopReason: "stop", usage: { input: 1, output: 1 } } },
      ]));
    const streamFn = createPiStreamFn({ policy: rotatedPolicy, executionId: "rotation-fallback", createPiAiAttempt: attemptFactory });
    const events: any[] = [];
    for await (const event of streamFn({ id: "test" }, { messages: [] })) events.push(event);

    expect(attemptFactory.mock.calls.map((call) => (call[0] as ModelCandidate).model)).toEqual(["second", "first"]);
    expect(events.some((event) => event.type === "done" && event.message?.content === "recovered")).toBe(true);
    expect(rotatedPolicy.excludedKeys.has("second@https://second/v1")).toBe(true);
    expect(rotatedPolicy.rotationExcludedKeys.size).toBe(0);
  });

  it("does not fall back after semantic commit", async () => {
    const firstCandidate = makeCandidate({ model: "first" });
    const secondCandidate = makeCandidate({ model: "second" });
    const failPolicy = new FallbackPolicy([firstCandidate, secondCandidate], registry);

    let callCount = 0;
    const attemptFactory = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const stream = makeFakeStream([
          { type: "text_delta", contentIndex: 0, delta: "partial " },
          { type: "done", reason: "stop", message: { role: "assistant", content: "partial", stopReason: "stop", usage: { input: 5, output: 2 } } },
        ]);
        return stream;
      }
      return makeFakeStream([
        { type: "text_delta", contentIndex: 0, delta: "should not reach" },
        { type: "done", reason: "stop", message: { role: "assistant", content: "should not reach", stopReason: "stop", usage: { input: 0, output: 0 } } },
      ]);
    });

    const streamFn = createPiStreamFn({ policy: failPolicy, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = { systemPrompt: "", messages: [{ role: "user", content: "hi" }] };
    const opts: SimpleStreamOptions = {};

    const stream = streamFn({ id: "test" }, ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    expect(callCount).toBe(1);
  });

  it("returns error stream on total exhaustion", async () => {
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 500"));
    const streamFn = createPiStreamFn({ policy, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = { systemPrompt: "", messages: [] };
    const opts: SimpleStreamOptions = {};

    const stream = streamFn({ id: "test" }, ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.some((e) => e.type === "error")).toBe(true);
    const errorEv = events.find((e) => e.type === "error") as Record<string, unknown> | undefined;
    expect((errorEv?.error as Record<string, unknown> | undefined)?.stopReason).toBe("error");
  });

  it("returns aborted stream on cancellation", async () => {
    const controller = new AbortController();
    const attemptFactory = vi.fn().mockImplementation(async () => {
      controller.abort();
      return makeFakeStream([]);
    });

    const streamFn = createPiStreamFn({ policy, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = { systemPrompt: "", messages: [] };
    const opts: SimpleStreamOptions = { signal: controller.signal };

    const stream = streamFn({ id: "test" }, ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.some((e) => e.type === "error")).toBe(true);
    const errorEv2 = events.find((e) => e.type === "error") as Record<string, unknown> | undefined;
    expect((errorEv2?.error as Record<string, unknown> | undefined)?.stopReason).toBe("aborted");
  });

  it("does not poison candidate health when the attempt is aborted (#1534)", async () => {
    const controller = new AbortController();
    const attemptFactory = vi.fn().mockImplementation(async () => {
      controller.abort();
      return makeFakeStream([
        { type: "text_delta", contentIndex: 0, delta: "x" },
        { type: "done", reason: "stop", message: { role: "assistant", content: "x", stopReason: "stop", usage: { input: 1, output: 1 } } },
      ]);
    });

    const streamFn = createPiStreamFn({ policy, executionId: "test", createPiAiAttempt: attemptFactory });
    const events: any[] = [];
    for await (const event of streamFn({ id: "test" }, { messages: [] }, { signal: controller.signal })) events.push(event);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect((events.find((e) => e.type === "error")?.error as { stopReason?: string } | undefined)?.stopReason).toBe("aborted");
    // #1534: an operator abort must not exclude the candidate or fill its
    // health bucket — a post-cancel continuation must still reach the provider.
    expect(policy.excludedKeys.size).toBe(0);
    expect(policy.selectModel()).not.toBeNull();
  });

  it("times out a provider iterator that never resolves next() and falls back before semantic output", async () => {
    const first = makeCandidate({ model: "stuck", endpoint: "https://stuck/v1" });
    const second = makeCandidate({ model: "fallback", endpoint: "https://fallback/v1" });
    const fallbackPolicy = new FallbackPolicy([first, second], registry);
    let firstSignal: AbortSignal | undefined;
    const stuckStream = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<any>>(() => {}),
        return: vi.fn(async () => ({ done: true, value: undefined })),
      }),
    };
    const attemptFactory = vi.fn().mockImplementation(async (candidate: ModelCandidate, _model: unknown, _ctx: unknown, _opts: unknown, signal: AbortSignal) => {
      if (candidate.model === "stuck") {
        firstSignal = signal;
        return stuckStream;
      }
      return makeFakeStream([{ type: "done", reason: "stop", message: { role: "assistant", content: "fallback", stopReason: "stop", usage: { input: 1, output: 1 } } }]);
    });

    const streamFn = createPiStreamFn({
      policy: fallbackPolicy,
      executionId: "stuck-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
    });
    const events: any[] = [];
    for await (const event of streamFn({ id: "test" }, { messages: [] }, {})) events.push(event);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(firstSignal?.aborted).toBe(true);
    expect(events.some((event) => event.type === "done" && event.message?.content === "fallback")).toBe(true);
  });

  it("times out an attempt factory that never resolves and falls back before semantic output (#1506 acquisition)", async () => {
    const first = makeCandidate({ model: "stuck", endpoint: "https://stuck/v1" });
    const second = makeCandidate({ model: "fallback", endpoint: "https://fallback/v1" });
    const fallbackPolicy = new FallbackPolicy([first, second], registry);
    let firstSignal: AbortSignal | undefined;
    const attemptFactory = vi.fn().mockImplementation(async (candidate: ModelCandidate, _model: unknown, _ctx: unknown, _opts: unknown, signal: AbortSignal) => {
      if (candidate.model === "stuck") {
        firstSignal = signal;
        return new Promise<never>(() => {}); // never resolves, ignores abort
      }
      return makeFakeStream([{ type: "done", reason: "stop", message: { role: "assistant", content: "fallback", stopReason: "stop", usage: { input: 1, output: 1 } } }]);
    });

    const streamFn = createPiStreamFn({
      policy: fallbackPolicy,
      executionId: "stuck-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
    });
    const events: any[] = [];
    for await (const event of streamFn({ id: "test" }, { messages: [] }, {})) events.push(event);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(firstSignal?.aborted).toBe(true);
    expect(events.some((event) => event.type === "done" && event.message?.content === "fallback")).toBe(true);
  });

  it("does not publish or re-record telemetry when a timed-out factory resolves after fallback (#1506)", async () => {
    const first = makeCandidate({ model: "stuck", endpoint: "https://stuck/v1" });
    const second = makeCandidate({ model: "fallback", endpoint: "https://fallback/v1" });
    const fallbackPolicy = new FallbackPolicy([first, second], registry);
    let resolveLate: ((v: unknown) => void) | undefined;
    const lateReturn = vi.fn(async () => ({ done: true, value: undefined }));
    const telemetryCalls: string[] = [];
    const mockTelemetry = {
      executionId: "exec_1",
      beginProviderCall: vi.fn().mockReturnValue({
        providerCallId: "pc1",
        ordinal: 1,
        end: vi.fn().mockImplementation((t: { result: string }) => { telemetryCalls.push(t.result); }),
      }),
      snapshot: vi.fn(),
      close: vi.fn(),
    };

    const attemptFactory = vi.fn().mockImplementation(async (candidate: ModelCandidate) => {
      if (candidate.model === "stuck") {
        return new Promise((resolve) => { resolveLate = resolve; });
      }
      return makeFakeStream([{ type: "done", reason: "stop", message: { role: "assistant", content: "fallback", stopReason: "stop", usage: { input: 1, output: 1 } } }]);
    });

    const streamFn = createPiStreamFn({
      policy: fallbackPolicy,
      executionId: "stuck-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
      telemetry: mockTelemetry,
    });
    const events: any[] = [];
    for await (const event of streamFn({ id: "test" }, { messages: [] }, {})) events.push(event);

    expect(events.some((event) => event.type === "done" && event.message?.content === "fallback")).toBe(true);
    // Exactly one terminal record per started request: stuck timeout + fallback success.
    expect(telemetryCalls).toEqual(["aborted", "success"]);

    const lateStream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
        return: lateReturn,
      }),
    };
    resolveLate?.(lateStream);
    await vi.waitFor(() => expect(lateReturn).toHaveBeenCalled(), { timeout: 2_000, interval: 10 });

    // The late stream must not publish output, change health, or add a record.
    expect(telemetryCalls).toEqual(["aborted", "success"]);
    expect(fallbackPolicy.excludedKeys.has("stuck@https://stuck/v1")).toBe(true);
    expect(fallbackPolicy.excludedKeys.has("fallback@https://fallback/v1")).toBe(false);
  });

  it("consumes a timed-out factory rejection after fallback (no unhandled rejection, no duplicate telemetry) (#1506)", async () => {
    const first = makeCandidate({ model: "stuck", endpoint: "https://stuck/v1" });
    const second = makeCandidate({ model: "fallback", endpoint: "https://fallback/v1" });
    const fallbackPolicy = new FallbackPolicy([first, second], registry);
    let rejectLate: ((err: Error) => void) | undefined;
    const telemetryCalls: string[] = [];
    const mockTelemetry = {
      executionId: "exec_1",
      beginProviderCall: vi.fn().mockReturnValue({
        providerCallId: "pc1",
        ordinal: 1,
        end: vi.fn().mockImplementation((t: { result: string }) => { telemetryCalls.push(t.result); }),
      }),
      snapshot: vi.fn(),
      close: vi.fn(),
    };

    const attemptFactory = vi.fn().mockImplementation(async (candidate: ModelCandidate) => {
      if (candidate.model === "stuck") {
        return new Promise((_resolve, reject) => { rejectLate = reject; });
      }
      return makeFakeStream([{ type: "done", reason: "stop", message: { role: "assistant", content: "fallback", stopReason: "stop", usage: { input: 1, output: 1 } } }]);
    });

    const streamFn = createPiStreamFn({
      policy: fallbackPolicy,
      executionId: "stuck-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
      telemetry: mockTelemetry,
    });
    const events: any[] = [];
    for await (const event of streamFn({ id: "test" }, { messages: [] }, {})) events.push(event);

    expect(events.some((event) => event.type === "done" && event.message?.content === "fallback")).toBe(true);
    rejectLate?.(new Error("late provider failure"));
    // An unhandled rejection would fail the test; telemetry stays exactly-once.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(telemetryCalls).toEqual(["aborted", "success"]);
    expect(attemptFactory).toHaveBeenCalledTimes(2);
  });

  it("does not fall back after a stalled provider has emitted semantic output", async () => {
    const first = makeCandidate({ model: "partial", endpoint: "https://partial/v1" });
    const second = makeCandidate({ model: "should-not-run", endpoint: "https://unused/v1" });
    const fallbackPolicy = new FallbackPolicy([first, second], registry);
    const partialStream = {
      [Symbol.asyncIterator]: () => {
        let firstEvent = true;
        return {
          next: () => firstEvent
            ? (firstEvent = false, Promise.resolve({ done: false, value: { type: "text_delta", contentIndex: 0, delta: "partial" } }))
            : new Promise<IteratorResult<any>>(() => {}),
          return: vi.fn(async () => ({ done: true, value: undefined })),
        };
      },
    };
    const attemptFactory = vi.fn().mockResolvedValue(partialStream);
    const streamFn = createPiStreamFn({
      policy: fallbackPolicy,
      executionId: "partial-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
    });
    const events: any[] = [];
    for await (const event of streamFn({ id: "test" }, { messages: [] }, {})) events.push(event);

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "text_delta" && event.delta === "partial")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect(fallbackPolicy.excludedKeys.has("partial@https://partial/v1")).toBe(true);
    expect(fallbackPolicy.excludedKeys.has("should-not-run@https://unused/v1")).toBe(false);
  });

  // ── Request-identity tests (#1472) ──────────────────────────────────────────

  it("replaces stale caller-provided x-client-request-id with a generated ID", async () => {
    const usedIds: string[] = [];
    const requestIdFactory = vi.fn()
      .mockReturnValueOnce("gen-req-1")
      .mockReturnValueOnce("gen-req-2");
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: requestIdFactory,
    });
    const opts: SimpleStreamOptions = { headers: { "x-client-request-id": "stale-session-value" } };
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, opts)) { /* consume */ }

    const passedOptions = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    expect(passedOptions?.headers?.["x-client-request-id"]).toBe("gen-req-1");
    // The stale value must NOT appear in the output (Abtars' value wins)
    expect(passedOptions?.headers?.["x-client-request-id"]).not.toBe("stale-session-value");
  });

  it("generates distinct IDs for two stream invocations", async () => {
    const ids: string[] = [];
    const requestIdFactory = vi.fn(() => {
      const id = `req-${ids.length}`;
      ids.push(id);
      return id;
    });
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: requestIdFactory,
    });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("generates a fresh ID for conflict recovery retry", async () => {
    const ids: string[] = [];
    const requestIdFactory = vi.fn(() => {
      const id = `req-${ids.length}`;
      ids.push(id);
      return id;
    });
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockResolvedValueOnce(makeFakeStream([
        { type: "done", reason: "stop", message: { role: "assistant", content: "recovered", stopReason: "stop", usage: { input: 2, output: 2 } } },
      ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: requestIdFactory,
    });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    // Two IDs: one for the conflict attempt, one for the retry
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    // Both attempts got the x-client-request-id header with their respective IDs
    const opts1 = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    const opts2 = attemptFactory.mock.calls[1]?.[3] as SimpleStreamOptions;
    expect(opts1?.headers?.["x-client-request-id"]).toBe(ids[0]);
    expect(opts2?.headers?.["x-client-request-id"]).toBe(ids[1]);
  });

  it("preserves sessionId and unrelated option headers while adding request ID", async () => {
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "gen-id",
    });
    const opts: SimpleStreamOptions = {
      sessionId: "cache-affinity-session",
      headers: { "x-custom": "custom-value" },
    };
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, opts)) { /* consume */ }

    const passedOptions = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    expect(passedOptions?.sessionId).toBe("cache-affinity-session");
    expect(passedOptions?.headers?.["x-custom"]).toBe("custom-value");
    expect(passedOptions?.headers?.["x-client-request-id"]).toBe("gen-id");
  });

  it("does not add x-client-request-id for anthropic-messages candidates", async () => {
    const anthropicCandidate = makeCandidate({ apiFormat: "anthropic" });
    const anthropicPolicy = new FallbackPolicy([anthropicCandidate], registry);
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));

    const streamFn = createPiStreamFn({
      policy: anthropicPolicy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "gen-id",
    });
    const opts: SimpleStreamOptions = {};
    for await (const _ev of streamFn({
      id: "claude", api: "anthropic-messages" as const,
    }, { messages: [] }, opts)) { /* consume */ }

    const passedOptions = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    expect(passedOptions?.headers?.["x-client-request-id"]).toBeUndefined();
  });

  // ── Conflict-recovery tests (#1472) ─────────────────────────────────────────

  it("retries once on thrown idempotency_conflict before commit", async () => {
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict: duplicate request"))
      .mockResolvedValueOnce(makeFakeStream([
        { type: "text_delta", contentIndex: 0, delta: "recovered" },
        { type: "done", reason: "stop", message: { role: "assistant", content: "recovered", stopReason: "stop", usage: { input: 5, output: 3 } } },
      ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.delta?.includes("recovered"))).toBe(true);
  });

  it("retries once on terminal idempotency_conflict error message", async () => {
    const attemptFactory = vi.fn()
      .mockResolvedValueOnce(makeFakeStream([
        { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "idempotency_conflict: request key reused", usage: { input: 0, output: 0 } } },
      ]))
      .mockResolvedValueOnce(makeFakeStream([
        { type: "text_delta", contentIndex: 0, delta: "ok" },
        { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 3, output: 1 } } },
      ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("does not retry a second conflict on the same candidate", async () => {
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockRejectedValueOnce(new Error("idempotency_conflict again"));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) events.push(ev);

    // Called twice: original attempt + retry attempt (both fail)
    expect(attemptFactory).toHaveBeenCalledTimes(2);
    // Falls through to terminal error
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("does not retry conflict after semantic commit", async () => {
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "text_delta", contentIndex: 0, delta: "committed " },
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "idempotency_conflict after output", usage: { input: 0, output: 0 } } },
    ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) events.push(ev);

    // Only one attempt — no retry after commit
    expect(attemptFactory).toHaveBeenCalledTimes(1);
    // The committed text_delta was yielded before the error
    expect(events.some((e) => e.delta?.includes("committed"))).toBe(true);
  });

  it("falls back to next candidate when recovery attempt fails", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const fallbackPolicy = new FallbackPolicy([first, second], registry);

    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockRejectedValueOnce(new Error("API error 503"))
      .mockResolvedValueOnce(makeFakeStream([
        { type: "text_delta", contentIndex: 0, delta: "fallback worked" },
        { type: "done", reason: "stop", message: { role: "assistant", content: "fallback worked", stopReason: "stop", usage: { input: 3, output: 1 } } },
      ]));

    const streamFn = createPiStreamFn({
      policy: fallbackPolicy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) events.push(ev);

    // Two calls for first candidate (conflict + recovery failure) + one for second (success)
    expect(attemptFactory).toHaveBeenCalledTimes(3);
    expect(events.some((e) => e.delta?.includes("fallback worked"))).toBe(true);
  });

  // ── Telemetry and policy settlement tests (#1472 §4) ────────────────────────

  it("records telemetry for both conflict and recovery attempts", async () => {
    const telemetryCalls: Array<{ result: string }> = [];
    const mockTelemetry = {
      executionId: "exec_1",
      beginProviderCall: vi.fn().mockReturnValue({
        providerCallId: "pc1",
        ordinal: 1,
        end: vi.fn().mockImplementation((t: { result: string }) => { telemetryCalls.push({ result: t.result }); }),
      }),
      snapshot: vi.fn(),
      close: vi.fn(),
    };

    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockResolvedValueOnce(makeFakeStream([
        { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 2, output: 1 } } },
      ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
      telemetry: mockTelemetry,
    });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    // Two telemetry calls: one failure (conflict), one success (recovery)
    expect(mockTelemetry.beginProviderCall).toHaveBeenCalledTimes(2);
    expect(telemetryCalls).toHaveLength(2);
    expect(telemetryCalls[0]?.result).toBe("failure");
    expect(telemetryCalls[1]?.result).toBe("success");
  });

  it("does not penalize policy on recoverable conflict", async () => {
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockResolvedValueOnce(makeFakeStream([
        { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 2, output: 1 } } },
      ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    // The candidate should NOT be excluded (recordError was not called for the conflict)
    expect(policy.excludedKeys.size).toBe(0);
  });

  it("penalizes policy when recovery attempt fails", async () => {
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockRejectedValueOnce(new Error("API error 503"));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    // The candidate IS excluded after the recovery attempt fails (one recordError)
    expect(policy.excludedKeys.size).toBe(1);
  });

  // ── Error classification (#1297) ───────────────────────────────────────────

  it.each([
    "402: {\"error\":{\"message\":\"insufficient credits for this model\"}}",
    "OpenAI API error (402): Insufficient Credits for this model",
  ])("records credits (not transient) for Pi-AI 402 format: %s", async (message) => {
    const attemptFactory = vi.fn().mockRejectedValue(new Error(message));
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: attemptFactory });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(registry.isCreditFailed("test-model", "https://api.test/v1")).toBe(true);
    expect(policy.excludedKeys.has("test-model@https://api.test/v1")).toBe(true);
  });

  it("records credits for a terminal error event with a 402 credits message", async () => {
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "API error 402: credits exhausted", usage: { input: 0, output: 0 } } },
    ]));
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: attemptFactory });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(registry.isCreditFailed("test-model", "https://api.test/v1")).toBe(true);
  });

  it("records transient (not credits) for a 500 error", async () => {
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 500: server failure"));
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: attemptFactory });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(registry.isCreditFailed("test-model", "https://api.test/v1")).toBe(false);
    expect(registry.getBucketLevel("test-model", "https://api.test/v1")).toBeGreaterThan(0);
  });

  it("propagates retry-after metadata into the registry cooldown", async () => {
    vi.useFakeTimers();
    const attemptFactory = vi.fn().mockRejectedValue(new Error('API error 429: rate limited {"retry_after": 60}'));
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: attemptFactory });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(registry.shouldSkip("test-model", "https://api.test/v1")).toBe(true);
    vi.advanceTimersByTime(61_000);
    // Cooldown expired — bucket alone (0.5) is below the skip threshold.
    expect(registry.shouldSkip("test-model", "https://api.test/v1")).toBe(false);
    vi.useRealTimers();
  });

  // ── Context-overflow classification (#1745) ────────────────────────────────

  function overflowAttempt(overflow: (message: unknown) => boolean, event: any): any {
    return {
      stream: makeFakeStream([event]),
      pi: {
        createProvider: vi.fn(),
        isContextOverflow: vi.fn().mockImplementation(overflow),
      },
    };
  }

  it("classifies an overflow terminal message as context_exceeded with no status", async () => {
    const fakePi = overflowAttempt(
      () => true,
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "This model's maximum context length is 128000 tokens. However, your messages resulted in 129000 tokens", usage: { input: 0, output: 0 } } },
    );
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: vi.fn().mockResolvedValue(fakePi) });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions", contextWindow: 128000 }, { messages: [] }, {})) { /* consume */ }

    // The predicate receives the AssistantMessage (not a stringified error) and
    // the model's context window — the evidence the seam used to discard.
    expect(fakePi.pi.isContextOverflow).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("maximum context length") }),
      128000,
    );
    // #1326's no-fill handling finally has a producer: bucket level unchanged.
    expect(registry.getBucketLevel("test-model", "https://api.test/v1")).toBe(0);
    expect(registry.isCreditFailed("test-model", "https://api.test/v1")).toBe(false);
  });

  it("uses the attempted candidate's context window for Pi overflow classification", async () => {
    const candidate = makeCandidate({ maxContext: 64_000 });
    const candidatePolicy = new FallbackPolicy([candidate], registry);
    const fakePi = overflowAttempt(
      () => true,
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "This model's maximum context length is 64000 tokens", usage: { input: 0, output: 0 } } },
    );
    const attemptFactory = vi.fn().mockResolvedValue(fakePi);
    const streamFn = createPiStreamFn({ policy: candidatePolicy, executionId: "exec_1", createPiAiAttempt: attemptFactory });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions", contextWindow: 128_000 }, { messages: [] }, {})) { /* consume */ }

    expect(attemptFactory.mock.calls[0]?.[1]).toMatchObject({ contextWindow: 64_000 });
    expect(fakePi.pi.isContextOverflow).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("maximum context length") }),
      64_000,
    );
    expect(registry.getBucketLevel("test-model", "https://api.test/v1")).toBe(0);
  });

  it("keeps bucket level unchanged for context_exceeded (no transient fill)", async () => {
    const fakePi = overflowAttempt(
      () => true,
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "prompt is too long: 200000 tokens > 128000 maximum", usage: { input: 0, output: 0 } } },
    );
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: vi.fn().mockResolvedValue(fakePi) });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(registry.getBucketLevel("test-model", "https://api.test/v1")).toBe(0);
  });

  it("keeps credits sticky when a 402 message also mentions tokens", async () => {
    // The overflow predicate even agrees — a definite credits verdict must win.
    const fakePi = overflowAttempt(
      () => true,
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "API error 402: insufficient credits — token limit exceeded", usage: { input: 0, output: 0 } } },
    );
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: vi.fn().mockResolvedValue(fakePi) });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(registry.isCreditFailed("test-model", "https://api.test/v1")).toBe(true);
    expect(registry.getBucketLevel("test-model", "https://api.test/v1")).toBe(100);
  });

  it("keeps rate_limit when a 429 message mentions token limit (reset-false-positive guard)", async () => {
    const fakePi = overflowAttempt(
      () => true,
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: 'API error 429: token limit reached {"retry_after": 60}', usage: { input: 0, output: 0 } } },
    );
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: vi.fn().mockResolvedValue(fakePi) });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    // rate_limit fills 0.5 and arms the retry-after cooldown — not context_exceeded.
    expect(registry.getBucketLevel("test-model", "https://api.test/v1")).toBe(50);
    expect(registry.shouldSkip("test-model", "https://api.test/v1")).toBe(true);
    expect(registry.isCreditFailed("test-model", "https://api.test/v1")).toBe(false);
  });

  it("keeps content_filter as transient (unchanged from today)", async () => {
    const fakePi = overflowAttempt(
      () => false,
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider finish_reason: content_filter", usage: { input: 0, output: 0 } } },
    );
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: vi.fn().mockResolvedValue(fakePi) });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(registry.getBucketLevel("test-model", "https://api.test/v1")).toBeGreaterThan(0);
    expect(registry.isCreditFailed("test-model", "https://api.test/v1")).toBe(false);
  });

  // ── Terminal credit failure callback (#1297) ───────────────────────────────

  it("reports credits_exhausted when every candidate (including pre-poisoned) is credit-failed", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const exhaustionPolicy = new FallbackPolicy([first, second], registry);
    // Pre-poison both in shared health — the stream never even attempts them.
    registry.recordError("first", "https://first/v1", "credits");
    registry.recordError("second", "https://second/v1", "credits");

    const onTerminalFailure = vi.fn();
    const attemptFactory = vi.fn();
    const streamFn = createPiStreamFn({
      policy: exhaustionPolicy, executionId: "exec_1",
      createPiAiAttempt: attemptFactory, onTerminalFailure,
    });
    const events: any[] = [];
    for await (const ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) events.push(ev);

    expect(attemptFactory).not.toHaveBeenCalled();
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "credits_exhausted",
      retryable: false,
      attemptedCandidates: 0,
    }));
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("reports credits_exhausted when the last viable candidate fails with credits", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const exhaustionPolicy = new FallbackPolicy([first, second], registry);
    registry.recordError("first", "https://first/v1", "credits"); // pre-poisoned

    const onTerminalFailure = vi.fn();
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 402: out of credits"));
    const streamFn = createPiStreamFn({
      policy: exhaustionPolicy, executionId: "exec_1",
      createPiAiAttempt: attemptFactory, onTerminalFailure,
    });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(attemptFactory.mock.calls[0]?.[0]).toMatchObject({ model: "second" });
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "credits_exhausted",
      attemptedCandidates: 1,
    }));
  });

  it("does NOT report credits_exhausted for a mix of credit and transient failures", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const mixedPolicy = new FallbackPolicy([first, second], registry);
    registry.recordError("first", "https://first/v1", "credits"); // pre-poisoned

    const onTerminalFailure = vi.fn();
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 500: server failure"));
    const streamFn = createPiStreamFn({
      policy: mixedPolicy, executionId: "exec_1",
      createPiAiAttempt: attemptFactory, onTerminalFailure,
    });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it("attempts a viable fallback and never reports credits_exhausted when one candidate succeeds", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const recoveryPolicy = new FallbackPolicy([first, second], registry);
    registry.recordError("first", "https://first/v1", "credits"); // pre-poisoned

    const onTerminalFailure = vi.fn();
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "text_delta", contentIndex: 0, delta: "recovered" },
      { type: "done", reason: "stop", message: { role: "assistant", content: "recovered", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));
    const streamFn = createPiStreamFn({
      policy: recoveryPolicy, executionId: "exec_1",
      createPiAiAttempt: attemptFactory, onTerminalFailure,
    });
    const events: any[] = [];
    for await (const ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(attemptFactory.mock.calls[0]?.[0]).toMatchObject({ model: "second" });
    expect(events.some((e) => e.type === "text_delta" && e.delta === "recovered")).toBe(true);
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  // ── Terminal context-overflow failure (#1745) ──────────────────────────────

  it("reports context_overflow when every attempted candidate overflowed", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const overflowPolicy = new FallbackPolicy([first, second], registry);

    const onTerminalFailure = vi.fn();
    const overflowEvent = { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "This model's maximum context length is 128000 tokens", usage: { input: 0, output: 0 } } };
    const attemptFactory = vi.fn().mockResolvedValue(overflowAttempt(() => true, overflowEvent));
    const streamFn = createPiStreamFn({ policy: overflowPolicy, executionId: "exec_1", createPiAiAttempt: attemptFactory, onTerminalFailure });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "context_overflow",
      retryable: false,
      attemptedCandidates: 2,
    }));
  });

  it("does NOT report a terminal code for a mix of overflow and auth failures", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const mixedPolicy = new FallbackPolicy([first, second], registry);

    const onTerminalFailure = vi.fn();
    const overflowEvent = { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "This model's maximum context length is 128000 tokens", usage: { input: 0, output: 0 } } };
    const attemptFactory = vi.fn()
      .mockResolvedValueOnce(overflowAttempt(() => true, overflowEvent))
      .mockRejectedValueOnce(new Error("API error 401: invalid credentials"));
    const streamFn = createPiStreamFn({ policy: mixedPolicy, executionId: "exec_1", createPiAiAttempt: attemptFactory, onTerminalFailure });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it("still reports credits_exhausted when all candidates are credit-failed (#1297 unchanged)", async () => {
    const first = makeCandidate({ model: "first", endpoint: "https://first/v1" });
    const second = makeCandidate({ model: "second", endpoint: "https://second/v1" });
    const creditsPolicy = new FallbackPolicy([first, second], registry);
    registry.recordError("first", "https://first/v1", "credits");
    registry.recordError("second", "https://second/v1", "credits");

    const onTerminalFailure = vi.fn();
    const streamFn = createPiStreamFn({ policy: creditsPolicy, executionId: "exec_1", onTerminalFailure });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "credits_exhausted" }));
  });

  it("reports no terminal code on an aborted execution", async () => {
    const controller = new AbortController();
    const onTerminalFailure = vi.fn();
    const overflowEvent = { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "This model's maximum context length is 128000 tokens", usage: { input: 0, output: 0 } } };
    const attemptFactory = vi.fn().mockImplementation(async () => {
      controller.abort();
      return overflowAttempt(() => true, overflowEvent);
    });
    const streamFn = createPiStreamFn({ policy, executionId: "exec_1", createPiAiAttempt: attemptFactory, onTerminalFailure });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, { signal: controller.signal })) { /* consume */ }

    expect(onTerminalFailure).not.toHaveBeenCalled();
  });
});
