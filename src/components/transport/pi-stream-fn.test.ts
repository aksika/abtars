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
    const streamFn = createPiStreamFn({ policy });
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
    const streamFn = createPiStreamFn({ policy, createPiAiAttempt: attemptFactory });
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

    const stream = createPiStreamFn({ policy: metadataPolicy, createPiAiAttempt: attemptFactory })(
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

    const streamFn = createPiStreamFn({ policy: failPolicy, createPiAiAttempt: attemptFactory });
    const ctx = { systemPrompt: "", messages: [{ role: "user", content: "hi" }] };
    const opts: SimpleStreamOptions = {};

    const stream = streamFn({ id: "test" }, ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.some((e) => e.delta?.includes("Hello from fallback"))).toBe(true);
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

    const streamFn = createPiStreamFn({ policy: failPolicy, createPiAiAttempt: attemptFactory });
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
    const streamFn = createPiStreamFn({ policy, createPiAiAttempt: attemptFactory });
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

    const streamFn = createPiStreamFn({ policy, createPiAiAttempt: attemptFactory });
    const ctx = { systemPrompt: "", messages: [] };
    const opts: SimpleStreamOptions = { signal: controller.signal };

    const stream = streamFn({ id: "test" }, ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.some((e) => e.type === "error")).toBe(true);
    const errorEv2 = events.find((e) => e.type === "error") as Record<string, unknown> | undefined;
    expect((errorEv2?.error as Record<string, unknown> | undefined)?.stopReason).toBe("aborted");
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
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));

    const streamFn = createPiStreamFn({
      policy, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "gen-id",
    });
    const opts: SimpleStreamOptions = {};
    for await (const _ev of streamFn({
      id: "claude", api: "anthropic-messages" as const,
    }, { messages: [] }, opts)) { /* consume */ }

    const passedOptions = attemptFactory.mock.calls[0]?.[2] as SimpleStreamOptions;
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
});
