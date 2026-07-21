// TEST DEFICIENCY: Real-package StreamFn conformance test (using actual pi-ai from the
// npm installation) is deferred — requires a full Pi installation. The deferred test should:
//   1. Create a real StreamFn via createPiStreamFn with actual fallback policy
//   2. Feed it a model and context
//   3. Verify the returned stream yields valid AssistantMessageEventStream events
// Smallest future verification path: add to the real-package test from pi-core-host.test.ts.

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

    expect(events.some((e) => e.type === "done")).toBe(true);
    const doneEv = events.find((e) => e.type === "done") as Record<string, unknown> | undefined;
    expect((doneEv?.message as Record<string, unknown> | undefined)?.stopReason).toBe("error");
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

    expect(events.some((e) => e.type === "done")).toBe(true);
    const doneEv2 = events.find((e) => e.type === "done") as Record<string, unknown> | undefined;
    expect((doneEv2?.message as Record<string, unknown> | undefined)?.stopReason).toBe("aborted");
  });

  it("attempts emergency L0 when all candidates exhausted", async () => {
    const emergency = makeCandidate({ model: "emergency-model", source: "emergency" });
    const failPolicy = new FallbackPolicy([makeCandidate({ model: "fail-model" })], registry);

    failPolicy.recordError(makeCandidate({ model: "fail-model" }), "auth");
    failPolicy.excludedKeys.add("fail-model@https://api.test/v1");

    const l0Factory = vi.fn().mockResolvedValue(makeFakeStream([
      { type: "text_delta", contentIndex: 0, delta: "Emergency response" },
      { type: "done", reason: "stop", message: { role: "assistant", content: "Emergency response", stopReason: "stop", usage: { input: 10, output: 5 } } },
    ]));

    const streamFn = createPiStreamFn({ policy: failPolicy, emergencyCandidate: emergency, createL0Attempt: l0Factory });
    const ctx = { systemPrompt: "", messages: [{ role: "user", content: "help" }] };
    const opts: SimpleStreamOptions = {};

    const stream = streamFn({ id: "test" }, ctx, opts);
    const events: any[] = [];
    for await (const ev of stream) events.push(ev);

    expect(l0Factory).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.delta === "Emergency response")).toBe(true);
  });
});
