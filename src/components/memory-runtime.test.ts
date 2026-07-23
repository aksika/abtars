import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AbmindClient } from "abmind";
import { createClientRuntime, createDisabledRuntime, createUnavailableRuntime } from "./memory-runtime.js";

// ── Normalizer coverage ──────────────────────────────────────────────────

describe("normalizeRecordMessageResult (via createClientRuntime)", () => {
  let client: AbmindClient;
  let runtime: ReturnType<typeof createClientRuntime>;

  function makeClient(recordMessageImpl: () => unknown): AbmindClient {
    return {
      close: vi.fn(),
      privateMemory: {
        recordMessage: vi.fn().mockImplementation(recordMessageImpl),
        recall: vi.fn(),
        assembleSessionContext: vi.fn(),
        getRecentConversation: vi.fn(),
        getRuntimeStatus: vi.fn(),
        getCoreKnowledge: vi.fn(),
        recordFeedback: vi.fn(),
        embed: vi.fn(),
        rebuildFtsIndexes: vi.fn(),
      } as any,
    } as unknown as AbmindClient;
  }

  it("accepts canonical { id: number }", async () => {
    client = makeClient(() => ({ id: 42 }));
    runtime = createClientRuntime(client);
    const result = await runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op1");
    expect(result).toEqual({ id: 42 });
  });

  it("accepts canonical { id: null }", async () => {
    client = makeClient(() => ({ id: null }));
    runtime = createClientRuntime(client);
    const result = await runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op2");
    expect(result).toEqual({ id: null });
  });

  it("accepts legacy raw number", async () => {
    client = makeClient(() => 42);
    runtime = createClientRuntime(client);
    const result = await runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op3");
    expect(result).toEqual({ id: 42 });
  });

  it("accepts legacy raw null", async () => {
    client = makeClient(() => null);
    runtime = createClientRuntime(client);
    const result = await runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op4");
    expect(result).toEqual({ id: null });
  });

  it("handles malformed object missing id", async () => {
    client = makeClient(() => ({}));
    runtime = createClientRuntime(client);
    const result = await runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op5");
    expect(result).toEqual({ id: null });
  });

  it("handles malformed string", async () => {
    client = makeClient(() => "oops");
    runtime = createClientRuntime(client);
    const result = await runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op6");
    expect(result).toEqual({ id: null });
  });

  it("handles negative number", async () => {
    client = makeClient(() => -1);
    runtime = createClientRuntime(client);
    const result = await runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op7");
    expect(result).toEqual({ id: null });
  });

  it("handles NaN", async () => {
    client = makeClient(() => NaN);
    runtime = createClientRuntime(client);
    const result = await runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op8");
    expect(result).toEqual({ id: null });
  });
});

// ── Disabled / unavailable runtime ───────────────────────────────────────

describe("createDisabledRuntime", () => {
  it("returns { id: null } for recordMessage but throws", async () => {
    const runtime = createDisabledRuntime();
    await expect(runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op")).rejects.toThrow("Memory is disabled");
  });
});

describe("createUnavailableRuntime", () => {
  it("returns { id: null } for recordMessage but throws", async () => {
    const runtime = createUnavailableRuntime();
    await expect(runtime.recordMessage({
      userId: "u1", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "op")).rejects.toThrow("Memory unavailable");
  });
});
