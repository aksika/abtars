// The outer StreamFn protocol is tested below with Pi-shaped events. A live
// provider call remains environment-dependent and is covered by the provider
// package's own contract tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Api } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createPiStreamFn } from "./pi-stream-fn.js";
import { saveAvailabilityMemo, loadAvailabilityMemo } from "../pi-session/provider-availability-memo.js";
import type { ModelCandidate } from "./model-candidates.js";
import type { SimpleStreamOptions } from "./pi-core-types.js";

// #1921: StreamFn takes Pi's TranscriptContext since 0.86. The attempt
// factories below ignore context, so every call site shares one normalized
// empty transcript.
const emptyTranscript = () => normalizeContext({ messages: [] });

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

// Full Model<Api> literal (mirrors pi-catalog.test.ts fakeModel): the streamFn
// only reads id/api/provider for error envelopes and maxTokens/contextWindow
// for attempt options, but the signature requires the whole shape.
function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "test",
    name: "test",
    api: "openai-completions" as Api,
    provider: "test-provider",
    baseUrl: "https://api.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 128,
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

function doneStream(text: string): any {
  return makeFakeStream([
    { type: "text_delta", contentIndex: 0, delta: text },
    { type: "done", reason: "stop", message: { role: "assistant", content: text, stopReason: "stop", usage: { input: 10, output: 5 } } },
  ]);
}

describe("createPiStreamFn", () => {
  let candidate: ModelCandidate;

  beforeEach(() => {
    candidate = makeCandidate();
  });

  it("returns a StreamFn", () => {
    const streamFn = createPiStreamFn({ candidate, executionId: "test" });
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
      candidate,
      executionId: "test",
      createPiAiAttempt: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });
    const events: any[] = [];
    for await (const event of await streamFn(model, emptyTranscript())) events.push(event);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.error?.stopReason).toBe("error");
    expect(events.at(-1)?.error?.errorMessage).toBeTruthy();
  });

  it("succeeds with the configured candidate", async () => {
    const attemptFactory = vi.fn().mockResolvedValue(doneStream("Hello"));
    const streamFn = createPiStreamFn({ candidate, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = normalizeContext({ systemPrompt: "You are a bot.", messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    const opts: SimpleStreamOptions = {};

    const stream = await streamFn(makeModel(), ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(attemptFactory.mock.calls[0]?.[0]).toMatchObject({ model: "test-model" });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("preserves candidate API format and thinking metadata", async () => {
    const configured = makeCandidate({
      apiFormat: "responses",
      thinking: { style: "effort", default: "high" },
    });
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));

    const stream = await createPiStreamFn({ candidate: configured, executionId: "test", createPiAiAttempt: attemptFactory })(
      makeModel(), emptyTranscript(), {},
    );
    for await (const _event of stream) { /* consume */ }

    const model = attemptFactory.mock.calls[0]?.[1] as { api: string; reasoning: boolean };
    expect(model.api).toBe("openai-responses");
    expect(model.reasoning).toBe(true);
  });

  it("fails closed on setup failure before commit — exactly one attempt, no silent retry", async () => {
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 500: server failure"));
    const onTerminalFailure = vi.fn();
    const streamFn = createPiStreamFn({ candidate, executionId: "test", createPiAiAttempt: attemptFactory, onTerminalFailure });
    const ctx = normalizeContext({ systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    const opts: SimpleStreamOptions = {};

    const stream = await streamFn(makeModel(), ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "all_candidates_failed",
      retryable: false,
      attemptedCandidates: 1,
    }));
  });

  it("records memoizable terminal failures to the availability memo (#1932)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-wire-"));
    const failCandidate = makeCandidate({ model: "fail", provider: "test-provider", endpoint: "https://fail/v1" });
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 429: rate limited"));
    const streamFn = createPiStreamFn({
      candidate: failCandidate,
      executionId: "memo-test",
      createPiAiAttempt: attemptFactory,
      memoStateDir: stateDir,
    });

    const stream = await streamFn(makeModel(), emptyTranscript(), {});
    for await (const _event of stream) { /* drain to terminal */ }

    const memo = JSON.parse(readFileSync(join(stateDir, "provider-availability-v1.json"), "utf-8")) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(memo.entries).toHaveLength(1);
    expect(memo.entries[0]).toMatchObject({
      authNamespace: "abtars:test-provider",
      provider: "test-provider",
      reason: "rate-limit",
      modelScope: "fail",
    });
  });

  it("clears stale same-namespace observations on success but keeps newer ones (#1932)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-wire-"));
    saveAvailabilityMemo(stateDir, [
      {
        authNamespace: "abtars:test-provider",
        provider: "test-provider",
        reason: "rate-limit",
        observedAt: 1,
        unusableUntil: Date.now() + 5 * 60 * 1000,
      },
      {
        authNamespace: "abtars:test-provider",
        provider: "test-provider",
        reason: "temporary",
        observedAt: Date.now() + 3_600_000,
        unusableUntil: Date.now() + 3_900_000,
      },
    ]);
    const okCandidate = makeCandidate({ model: "ok", provider: "test-provider", endpoint: "https://ok/v1" });
    const attemptFactory = vi.fn().mockResolvedValue(doneStream("Hello"));
    const streamFn = createPiStreamFn({
      candidate: okCandidate,
      executionId: "memo-success-test",
      createPiAiAttempt: attemptFactory,
      memoStateDir: stateDir,
    });

    const stream = await streamFn(makeModel(), emptyTranscript(), {});
    for await (const _event of stream) { /* drain to terminal */ }

    const memo = JSON.parse(readFileSync(join(stateDir, "provider-availability-v1.json"), "utf-8")) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(memo.entries).toHaveLength(1);
    expect(memo.entries[0]).toMatchObject({ reason: "temporary" });
  });

  it("does not retry after semantic commit", async () => {
    let callCount = 0;
    const attemptFactory = vi.fn().mockImplementation(async () => {
      callCount++;
      return makeFakeStream([
        { type: "text_delta", contentIndex: 0, delta: "partial " },
        { type: "done", reason: "stop", message: { role: "assistant", content: "partial", stopReason: "stop", usage: { input: 5, output: 2 } } },
      ]);
    });

    const streamFn = createPiStreamFn({ candidate, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = normalizeContext({ systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    const opts: SimpleStreamOptions = {};

    const stream = await streamFn(makeModel(), ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    expect(callCount).toBe(1);
  });

  it("returns error stream on total exhaustion", async () => {
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 500"));
    const streamFn = createPiStreamFn({ candidate, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = emptyTranscript();
    const opts: SimpleStreamOptions = {};

    const stream = await streamFn(makeModel(), ctx, opts);
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

    const streamFn = createPiStreamFn({ candidate, executionId: "test", createPiAiAttempt: attemptFactory });
    const ctx = emptyTranscript();
    const opts: SimpleStreamOptions = { signal: controller.signal };

    const stream = await streamFn(makeModel(), ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.some((e) => e.type === "error")).toBe(true);
    const errorEv2 = events.find((e) => e.type === "error") as Record<string, unknown> | undefined;
    expect((errorEv2?.error as Record<string, unknown> | undefined)?.stopReason).toBe("aborted");
  });

  it("records no memo observation when the attempt is aborted (#1534)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-abort-"));
    const controller = new AbortController();
    const attemptFactory = vi.fn().mockImplementation(async () => {
      controller.abort();
      return makeFakeStream([
        { type: "text_delta", contentIndex: 0, delta: "x" },
        { type: "done", reason: "stop", message: { role: "assistant", content: "x", stopReason: "stop", usage: { input: 1, output: 1 } } },
      ]);
    });

    const streamFn = createPiStreamFn({ candidate, executionId: "test", createPiAiAttempt: attemptFactory, memoStateDir: stateDir });
    const events: any[] = [];
    for await (const event of await streamFn(makeModel(), emptyTranscript(), { signal: controller.signal })) events.push(event);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect((events.find((e) => e.type === "error")?.error as { stopReason?: string } | undefined)?.stopReason).toBe("aborted");
    // #1534: an operator abort is not a provider failure — a post-cancel
    // continuation must still reach the provider, so nothing is observed.
    expect(loadAvailabilityMemo(stateDir).entries).toHaveLength(0);
  });

  it("times out a provider iterator that never resolves next() before semantic output", async () => {
    const stuckStream = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<any>>(() => {}),
        return: vi.fn(async () => ({ done: true, value: undefined })),
      }),
    };
    let firstSignal: AbortSignal | undefined;
    const attemptFactory = vi.fn().mockImplementation(async (_candidate: unknown, _model: unknown, _ctx: unknown, _opts: unknown, signal: AbortSignal) => {
      firstSignal = signal;
      return stuckStream;
    });

    const streamFn = createPiStreamFn({
      candidate,
      executionId: "stuck-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
    });
    const events: any[] = [];
    for await (const event of await streamFn(makeModel(), emptyTranscript(), {})) events.push(event);

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("times out an attempt factory that never resolves before semantic output (#1506 acquisition)", async () => {
    let firstSignal: AbortSignal | undefined;
    const attemptFactory = vi.fn().mockImplementation(async (_candidate: unknown, _model: unknown, _ctx: unknown, _opts: unknown, signal: AbortSignal) => {
      firstSignal = signal;
      return new Promise<never>(() => {}); // never resolves, ignores abort
    });

    const streamFn = createPiStreamFn({
      candidate,
      executionId: "stuck-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
    });
    const events: any[] = [];
    for await (const event of await streamFn(makeModel(), emptyTranscript(), {})) events.push(event);

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not publish or re-record telemetry when a timed-out factory resolves late (#1506)", async () => {
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

    const attemptFactory = vi.fn().mockImplementation(async () => {
      return new Promise((resolve) => { resolveLate = resolve; });
    });

    const streamFn = createPiStreamFn({
      candidate,
      executionId: "stuck-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
      telemetry: mockTelemetry,
    });
    const events: any[] = [];
    for await (const event of await streamFn(makeModel(), emptyTranscript(), {})) events.push(event);

    expect(events.at(-1)?.type).toBe("error");
    // Exactly one terminal record for the timed-out request.
    expect(telemetryCalls).toEqual(["aborted"]);

    const lateStream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
        return: lateReturn,
      }),
    };
    resolveLate?.(lateStream);
    await vi.waitFor(() => expect(lateReturn).toHaveBeenCalled(), { timeout: 2_000, interval: 10 });

    // The late stream must not publish output or add a record.
    expect(telemetryCalls).toEqual(["aborted"]);
  });

  it("consumes a timed-out factory rejection late (no unhandled rejection, no duplicate telemetry) (#1506)", async () => {
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

    const attemptFactory = vi.fn().mockImplementation(async () => {
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    });

    const streamFn = createPiStreamFn({
      candidate,
      executionId: "stuck-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
      telemetry: mockTelemetry,
    });
    const events: any[] = [];
    for await (const event of await streamFn(makeModel(), emptyTranscript(), {})) events.push(event);

    expect(events.at(-1)?.type).toBe("error");
    rejectLate?.(new Error("late provider failure"));
    // An unhandled rejection would fail the test; telemetry stays exactly-once.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(telemetryCalls).toEqual(["aborted"]);
    expect(attemptFactory).toHaveBeenCalledTimes(1);
  });

  it("does not retry after a stalled provider has emitted semantic output", async () => {
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
      candidate,
      executionId: "partial-provider",
      createPiAiAttempt: attemptFactory,
      providerInactivityTimeoutMs: 20,
    });
    const events: any[] = [];
    for await (const event of await streamFn(makeModel(), emptyTranscript(), {})) events.push(event);

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "text_delta" && event.delta === "partial")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
  });

  // ── Request-identity tests (#1472) ──────────────────────────────────────────

  it("replaces stale caller-provided x-client-request-id with a generated ID", async () => {
    const requestIdFactory = vi.fn()
      .mockReturnValueOnce("gen-req-1")
      .mockReturnValueOnce("gen-req-2");
    const attemptFactory = vi.fn().mockResolvedValue(doneStream("ok"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: requestIdFactory,
    });
    const opts: SimpleStreamOptions = { headers: { "x-client-request-id": "stale-session-value" } };
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), opts)) { /* consume */ }

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
    const attemptFactory = vi.fn().mockResolvedValue(doneStream("ok"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: requestIdFactory,
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }
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
      .mockResolvedValueOnce(doneStream("recovered"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: requestIdFactory,
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

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
    const attemptFactory = vi.fn().mockResolvedValue(doneStream("ok"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "gen-id",
    });
    const opts: SimpleStreamOptions = {
      sessionId: "cache-affinity-session",
      headers: { "x-custom": "custom-value" },
    };
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), opts)) { /* consume */ }

    const passedOptions = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    expect(passedOptions?.sessionId).toBe("cache-affinity-session");
    expect(passedOptions?.headers?.["x-custom"]).toBe("custom-value");
    expect(passedOptions?.headers?.["x-client-request-id"]).toBe("gen-id");
  });

  it("does not add x-client-request-id for anthropic-messages candidates", async () => {
    const anthropicCandidate = makeCandidate({ apiFormat: "anthropic" });
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "done", reason: "stop", message: { role: "assistant", content: "ok", stopReason: "stop", usage: { input: 1, output: 1 } } },
    ]));

    const streamFn = createPiStreamFn({
      candidate: anthropicCandidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "gen-id",
    });
    const opts: SimpleStreamOptions = {};
    for await (const _ev of await streamFn(makeModel({ id: "claude", api: "anthropic-messages" }), emptyTranscript(), opts)) { /* consume */ }

    const passedOptions = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    expect(passedOptions?.headers?.["x-client-request-id"]).toBeUndefined();
  });

  // ── Cache identity + retention (#1748) ─────────────────────────────────────

  it("forwards cacheIdentity as sessionId and cacheRetention to the attempt options", async () => {
    const attemptFactory = vi.fn().mockResolvedValue(doneStream("ok"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      cacheIdentity: "cache-id-1", cacheRetention: "short",
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    const passedOptions = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    expect(passedOptions?.sessionId).toBe("cache-id-1");
    expect(passedOptions?.cacheRetention).toBe("short");
  });

  it("sends the same cache identity on the conflict-recovery retry within one turn", async () => {
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockResolvedValueOnce(doneStream("recovered"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      cacheIdentity: "rotation-stable-id",
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    const opts1 = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    const opts2 = attemptFactory.mock.calls[1]?.[3] as SimpleStreamOptions;
    expect(opts1?.sessionId).toBe("rotation-stable-id");
    expect(opts2?.sessionId).toBe("rotation-stable-id");
  });

  it("uses the candidate's retention policy on the attempt", async () => {
    const retentionCandidate = makeCandidate({ cacheRetention: "long" });
    const attemptFactory = vi.fn().mockResolvedValue(doneStream("ok"));

    const streamFn = createPiStreamFn({
      candidate: retentionCandidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      cacheIdentity: "rotation-stable-id", cacheRetention: "short",
    });
    for await (const _ev of await streamFn(makeModel(), emptyTranscript(), {})) { /* consume */ }

    const passedOptions = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    expect(passedOptions?.cacheRetention).toBe("long");
    expect(passedOptions?.sessionId).toBe("rotation-stable-id");
  });

  it("keeps x-client-request-id fresh per attempt while the cache identity stays stable", async () => {
    const ids: string[] = [];
    const requestIdFactory = vi.fn(() => {
      const id = `req-${ids.length}`;
      ids.push(id);
      return id;
    });
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockResolvedValueOnce(doneStream("recovered"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: requestIdFactory,
      cacheIdentity: "rotation-stable-id",
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    const opts1 = attemptFactory.mock.calls[0]?.[3] as SimpleStreamOptions;
    const opts2 = attemptFactory.mock.calls[1]?.[3] as SimpleStreamOptions;
    expect(opts1?.sessionId).toBe("rotation-stable-id");
    expect(opts2?.sessionId).toBe("rotation-stable-id");
    expect(opts1?.headers?.["x-client-request-id"]).toBe(ids[0]);
    expect(opts2?.headers?.["x-client-request-id"]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  // ── Conflict-recovery tests (#1472) ─────────────────────────────────────────

  it("retries once on thrown idempotency_conflict before commit", async () => {
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict: duplicate request"))
      .mockResolvedValueOnce(doneStream("recovered"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.delta?.includes("recovered"))).toBe(true);
  });

  it("retries once on terminal idempotency_conflict error message", async () => {
    const attemptFactory = vi.fn()
      .mockResolvedValueOnce(makeFakeStream([
        { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "idempotency_conflict: request key reused", usage: { input: 0, output: 0 } } },
      ]))
      .mockResolvedValueOnce(doneStream("ok"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("does not retry a second conflict on the same candidate", async () => {
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockRejectedValueOnce(new Error("idempotency_conflict again"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) events.push(ev);

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
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
    });
    const events: any[] = [];
    for await (const ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) events.push(ev);

    // Only one attempt — no retry after commit
    expect(attemptFactory).toHaveBeenCalledTimes(1);
    // The committed text_delta was yielded before the error
    expect(events.some((e) => e.delta?.includes("committed"))).toBe(true);
  });

  it("reports a terminal failure when the recovery attempt fails", async () => {
    const onTerminalFailure = vi.fn();
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockRejectedValueOnce(new Error("API error 503"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
      onTerminalFailure,
    });
    const events: any[] = [];
    for await (const ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) events.push(ev);

    expect(attemptFactory).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "all_candidates_failed",
      retryable: false,
      attemptedCandidates: 1,
    }));
  });

  // ── Telemetry and observation tests (#1472 §4, #1932) ───────────────────────

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
      .mockResolvedValueOnce(doneStream("ok"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
      telemetry: mockTelemetry,
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    // Two telemetry calls: one failure (conflict), one success (recovery)
    expect(mockTelemetry.beginProviderCall).toHaveBeenCalledTimes(2);
    expect(telemetryCalls).toHaveLength(2);
    expect(telemetryCalls[0]?.result).toBe("failure");
    expect(telemetryCalls[1]?.result).toBe("success");
  });

  it("observes the failure in the memo when the recovery attempt fails", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-recovery-"));
    const attemptFactory = vi.fn()
      .mockRejectedValueOnce(new Error("idempotency_conflict"))
      .mockRejectedValueOnce(new Error("API error 503"));

    const streamFn = createPiStreamFn({
      candidate, createPiAiAttempt: attemptFactory, executionId: "exec_1",
      providerRequestIdFactory: () => "fresh-id",
      memoStateDir: stateDir,
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    // The failed recovery attempt is observed as a temporary failure.
    expect(loadAvailabilityMemo(stateDir).entries).toHaveLength(1);
    expect(loadAvailabilityMemo(stateDir).entries[0]).toMatchObject({ reason: "temporary" });
  });

  // ── Error classification (#1297) ───────────────────────────────────────────

  it.each([
    "402: {\"error\":{\"message\":\"insufficient credits for this model\"}}",
    "OpenAI API error (402): Insufficient Credits for this model",
  ])("observes account-limit (not transient) for Pi-AI 402 format: %s", async (message) => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-402-"));
    const attemptFactory = vi.fn().mockRejectedValue(new Error(message));
    const streamFn = createPiStreamFn({ candidate, executionId: "exec_1", createPiAiAttempt: attemptFactory, memoStateDir: stateDir });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    expect(loadAvailabilityMemo(stateDir).entries).toHaveLength(1);
    expect(loadAvailabilityMemo(stateDir).entries[0]).toMatchObject({ reason: "account-limit" });
  });

  it("observes account-limit for a terminal error event with a 402 credits message", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-402ev-"));
    const attemptFactory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "API error 402: credits exhausted", usage: { input: 0, output: 0 } } },
    ]));
    const streamFn = createPiStreamFn({ candidate, executionId: "exec_1", createPiAiAttempt: attemptFactory, memoStateDir: stateDir });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    expect(loadAvailabilityMemo(stateDir).entries).toHaveLength(1);
    expect(loadAvailabilityMemo(stateDir).entries[0]).toMatchObject({ reason: "account-limit" });
  });

  it("observes temporary (not account-limit) for a 500 error", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-500-"));
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 500: server failure"));
    const streamFn = createPiStreamFn({ candidate, executionId: "exec_1", createPiAiAttempt: attemptFactory, memoStateDir: stateDir });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    expect(loadAvailabilityMemo(stateDir).entries).toHaveLength(1);
    expect(loadAvailabilityMemo(stateDir).entries[0]).toMatchObject({ reason: "temporary" });
  });

  it("observes rate-limit with the retry-after window", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-429-"));
    const attemptFactory = vi.fn().mockRejectedValue(new Error('API error 429: rate limited {"retry_after": 60}'));
    const streamFn = createPiStreamFn({ candidate, executionId: "exec_1", createPiAiAttempt: attemptFactory, memoStateDir: stateDir });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    const entries = loadAvailabilityMemo(stateDir).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reason: "rate-limit" });
    expect(entries[0]?.unusableUntil).toBeGreaterThan(Date.now());
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
    const streamFn = createPiStreamFn({ candidate, executionId: "exec_1", createPiAiAttempt: vi.fn().mockResolvedValue(fakePi) });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions", contextWindow: 128000 }), emptyTranscript(), {})) { /* consume */ }

    // The predicate receives the AssistantMessage (not a stringified error) and
    // the model's context window — the evidence the seam used to discard.
    expect(fakePi.pi.isContextOverflow).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("maximum context length") }),
      128000,
    );
  });

  it("uses the configured candidate's context window for Pi overflow classification", async () => {
    const windowed = makeCandidate({ maxContext: 64_000 });
    const fakePi = overflowAttempt(
      () => true,
      { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "This model's maximum context length is 64000 tokens", usage: { input: 0, output: 0 } } },
    );
    const attemptFactory = vi.fn().mockResolvedValue(fakePi);
    const streamFn = createPiStreamFn({ candidate: windowed, executionId: "exec_1", createPiAiAttempt: attemptFactory });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions", contextWindow: 128_000 }), emptyTranscript(), {})) { /* consume */ }

    expect(attemptFactory.mock.calls[0]?.[1]).toMatchObject({ contextWindow: 64_000 });
    expect(fakePi.pi.isContextOverflow).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("maximum context length") }),
      64_000,
    );
  });

  it("reports context_overflow when the attempt overflows", async () => {
    const onTerminalFailure = vi.fn();
    const overflowEvent = { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "This model's maximum context length is 128000 tokens", usage: { input: 0, output: 0 } } };
    const attemptFactory = vi.fn().mockResolvedValue(overflowAttempt(() => true, overflowEvent));
    const streamFn = createPiStreamFn({ candidate, executionId: "exec_1", createPiAiAttempt: attemptFactory, onTerminalFailure });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "context_overflow",
      retryable: false,
      attemptedCandidates: 1,
    }));
  });

  it("reports all_candidates_failed for a transient failure", async () => {
    const onTerminalFailure = vi.fn();
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 500: server failure"));
    const streamFn = createPiStreamFn({
      candidate, executionId: "exec_1",
      createPiAiAttempt: attemptFactory, onTerminalFailure,
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "all_candidates_failed",
      retryable: false,
      attemptedCandidates: 1,
    }));
  });

  it("reports credits_exhausted for an account-limit failure", async () => {
    const onTerminalFailure = vi.fn();
    const attemptFactory = vi.fn().mockRejectedValue(new Error("API error 402: out of credits"));
    const streamFn = createPiStreamFn({
      candidate, executionId: "exec_1",
      createPiAiAttempt: attemptFactory, onTerminalFailure,
    });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), {})) { /* consume */ }

    expect(attemptFactory).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "credits_exhausted",
      attemptedCandidates: 1,
    }));
  });

  it("reports no terminal code on an aborted execution", async () => {
    const controller = new AbortController();
    const onTerminalFailure = vi.fn();
    const overflowEvent = { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "This model's maximum context length is 128000 tokens", usage: { input: 0, output: 0 } } };
    const attemptFactory = vi.fn().mockImplementation(async () => {
      controller.abort();
      return overflowAttempt(() => true, overflowEvent);
    });
    const streamFn = createPiStreamFn({ candidate, executionId: "exec_1", createPiAiAttempt: attemptFactory, onTerminalFailure });
    for await (const _ev of await streamFn(makeModel({ api: "openai-completions" }), emptyTranscript(), { signal: controller.signal })) { /* consume */ }

    expect(onTerminalFailure).not.toHaveBeenCalled();
  });
});
