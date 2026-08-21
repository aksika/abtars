import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderAttemptRunner } from "./provider-attempt-runner.js";
import type { ProviderAttemptExit, ProviderAttemptFactory, ProviderAttemptPhase } from "./provider-attempt-runner.js";
import type { ModelCandidate } from "./model-candidates.js";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

function makeCandidate(): ModelCandidate {
  return {
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
  };
}

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

const context = { messages: [] as unknown[] };

function makeIteratorStream(events: Array<{ delayMs: number; event?: AssistantMessageEvent; done?: boolean }>) {
  let idx = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (idx >= events.length) return Promise.resolve({ done: true, value: undefined });
        const step = events[idx++]!;
        return new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
          setTimeout(() => {
            if (step.done) resolve({ done: true, value: undefined });
            else resolve({ done: false, value: step.event! });
          }, step.delayMs);
        });
      },
      return: vi.fn(async () => ({ done: true, value: undefined })),
    }),
  };
}

function makeNeverYieldingStream() {
  const iterator = {
    next: () => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}),
    return: vi.fn(async () => ({ done: true, value: undefined })),
  };
  return {
    iterator,
    stream: { [Symbol.asyncIterator]: () => iterator },
  };
}

function makeDoneStream() {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
      return: vi.fn(async () => ({ done: true, value: undefined })),
    }),
  };
}

async function collect(runner: ProviderAttemptRunner): Promise<ProviderAttemptExit[]> {
  const exits: ProviderAttemptExit[] = [];
  for await (const exit of runner.run()) exits.push(exit);
  return exits;
}

function makeRunner(overrides: Partial<ConstructorParameters<typeof ProviderAttemptRunner>[0]> = {}) {
  const signal = new AbortController();
  return {
    signal,
    runner: new ProviderAttemptRunner({
      executionId: "e1",
      requestId: "r1",
      candidate: makeCandidate(),
      model,
      context,
      options: {},
      attemptFactory: (async () => makeDoneStream()) as unknown as ProviderAttemptFactory,
      signal: signal.signal,
      inactivityTimeoutMs: 20,
      ...overrides,
    }),
  };
}

describe("ProviderAttemptRunner", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("times out an attempt factory that never resolves and ignores abort (acquisition)", async () => {
    let candidateSignal: AbortSignal | undefined;
    const factory = vi.fn(async (_c: unknown, _m: unknown, _ctx: unknown, _o: unknown, s: AbortSignal) => {
      candidateSignal = s;
      return new Promise<never>(() => {});
    }) as unknown as ProviderAttemptFactory;
    const phases: ProviderAttemptPhase[] = [];
    const { runner } = makeRunner({
      attemptFactory: factory,
      onPhase: (phase) => phases.push(phase),
    });

    const exits = await collect(runner);

    expect(exits).toHaveLength(1);
    expect(exits[0]?.kind).toBe("timeout");
    if (exits[0]?.kind === "timeout") expect(exits[0].phase).toBe("acquiring");
    expect(candidateSignal?.aborted).toBe(true);
    expect(phases[0]).toBe("acquiring");
    expect(phases.at(-1)).toBe("terminal");
  });

  it("closes a factory that resolves only after acquisition timeout won (late settle)", async () => {
    let resolveFactory: ((stream: unknown) => void) | undefined;
    const returnSpy = vi.fn(async () => ({ done: true, value: undefined }));
    const lateStream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
        return: returnSpy,
      }),
    };
    const factory = vi.fn(async () => new Promise((resolve) => { resolveFactory = resolve; })) as unknown as ProviderAttemptFactory;

    const { runner } = makeRunner({ attemptFactory: factory });
    const exits = await collect(runner);

    expect(exits[0]?.kind).toBe("timeout");
    // A later factory settlement must be observed and its stream closed
    // best-effort — it can never publish an event.
    resolveFactory?.(lateStream);
    await vi.waitFor(() => expect(returnSpy).toHaveBeenCalled(), { timeout: 2_000, interval: 10 });
  });

  it("consumes a factory rejection that arrives after acquisition timeout (no unhandled rejection)", async () => {
    let rejectFactory: ((err: Error) => void) | undefined;
    const factory = vi.fn(async () => new Promise((_resolve, reject) => { rejectFactory = reject; })) as unknown as ProviderAttemptFactory;

    const { runner } = makeRunner({ attemptFactory: factory });
    const exits = await collect(runner);

    expect(exits[0]?.kind).toBe("timeout");
    rejectFactory?.(new Error("late provider failure"));
    // Give the detached observation a tick; an unhandled rejection would fail the test.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("times out an iterator that never yields and aborts the candidate-local signal", async () => {
    const stuck = makeNeverYieldingStream();
    let candidateSignal: AbortSignal | undefined;
    const factory = vi.fn(async (_c: unknown, _m: unknown, _ctx: unknown, _o: unknown, s: AbortSignal) => {
      candidateSignal = s;
      return stuck.stream;
    }) as unknown as ProviderAttemptFactory;

    const { runner } = makeRunner({ attemptFactory: factory });
    const exits = await collect(runner);

    expect(exits).toHaveLength(1);
    expect(exits[0]?.kind).toBe("timeout");
    if (exits[0]?.kind === "timeout") expect(exits[0].phase).toBe("streaming");
    expect(candidateSignal?.aborted).toBe(true);
    // The stalled iterator is closed best-effort.
    await vi.waitFor(() => expect(stuck.iterator.return).toHaveBeenCalled(), { timeout: 2_000, interval: 10 });
  });

  it("resets inactivity on every event and does not time out on progress", async () => {
    const stream = makeIteratorStream([
      { delayMs: 5, event: { type: "text_delta", contentIndex: 0, delta: "a" } },
      { delayMs: 5, event: { type: "text_delta", contentIndex: 0, delta: "b" } },
      { delayMs: 5, event: { type: "done", reason: "stop", message: { role: "assistant", content: "ab", stopReason: "stop", usage: { input: 1, output: 1 } } } },
    ]);
    const factory = vi.fn(async () => stream) as unknown as ProviderAttemptFactory;

    const { runner } = makeRunner({ attemptFactory: factory });
    const exits = await collect(runner);

    const events = exits.filter((e): e is Extract<ProviderAttemptExit, { kind: "event" }> => e.kind === "event");
    expect(events.map((e) => (e.event as { delta?: string }).delta).filter(Boolean)).toEqual(["a", "b"]);
    expect(exits.at(-1)?.kind).toBe("ended");
  });

  it("caps the inactivity bound by the remaining absolute deadline (deadline already passed)", async () => {
    const factory = vi.fn(async () => new Promise<never>(() => {})) as unknown as ProviderAttemptFactory;
    const started = Date.now();
    const { runner } = makeRunner({
      attemptFactory: factory,
      deadlineAt: Date.now() - 1,
      inactivityTimeoutMs: 50_000,
    });
    const exits = await collect(runner);
    expect(exits[0]?.kind).toBe("timeout");
    if (exits[0]?.kind === "timeout") expect(exits[0].phase).toBe("acquiring");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("yields aborted (phase acquiring) when the execution signal aborts during acquisition", async () => {
    const { signal, runner } = makeRunner({
      attemptFactory: (async () => new Promise<never>(() => {})) as unknown as ProviderAttemptFactory,
      inactivityTimeoutMs: 5_000,
    });
    setTimeout(() => signal.abort(), 10);
    const exits = await collect(runner);
    expect(exits[0]?.kind).toBe("aborted");
    if (exits[0]?.kind === "aborted") expect(exits[0].phase).toBe("acquiring");
  });

  it("yields aborted (phase streaming) when the execution signal aborts during streaming", async () => {
    const stuck = makeNeverYieldingStream();
    const { signal, runner } = makeRunner({
      attemptFactory: (async () => stuck.stream) as unknown as ProviderAttemptFactory,
      inactivityTimeoutMs: 5_000,
    });
    setTimeout(() => signal.abort(), 10);
    const exits = await collect(runner);
    expect(exits[0]?.kind).toBe("aborted");
    if (exits[0]?.kind === "aborted") expect(exits[0].phase).toBe("streaming");
  });

  it("reports a factory rejection as failed (phase acquiring)", async () => {
    const factory = vi.fn(async () => { throw new Error("provider unavailable"); }) as unknown as ProviderAttemptFactory;
    const { runner } = makeRunner({ attemptFactory: factory });
    const exits = await collect(runner);
    expect(exits[0]?.kind).toBe("failed");
    if (exits[0]?.kind === "failed") {
      expect(exits[0].phase).toBe("acquiring");
      expect((exits[0].error as Error).message).toBe("provider unavailable");
    }
  });

  it("reports an iterator next() rejection as failed (phase streaming)", async () => {
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("stream died")),
        return: vi.fn(async () => ({ done: true, value: undefined })),
      }),
    };
    const factory = vi.fn(async () => stream) as unknown as ProviderAttemptFactory;
    const { runner } = makeRunner({ attemptFactory: factory });
    const exits = await collect(runner);
    expect(exits[0]?.kind).toBe("failed");
    if (exits[0]?.kind === "failed") {
      expect(exits[0].phase).toBe("streaming");
      expect((exits[0].error as Error).message).toBe("stream died");
    }
  });

  it("yields ended when the stream completes without a terminal event", async () => {
    const factory = vi.fn(async () => makeDoneStream()) as unknown as ProviderAttemptFactory;
    const { runner } = makeRunner({ attemptFactory: factory });
    const exits = await collect(runner);
    expect(exits.at(-1)?.kind).toBe("ended");
  });
});
