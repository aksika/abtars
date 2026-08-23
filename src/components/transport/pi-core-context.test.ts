import { describe, it, expect, beforeEach } from "vitest";
import { PiCoreContextProjection, DurableContextUnavailableError, shouldEmitProjectionDiagnostic, resetProjectionDiagnosticStateForTest, PROJECTION_DIAGNOSTIC_MIN_INTERVAL_MS } from "./pi-core-context.js";
import type { PiExecutionContextSeed, AbtarsCurrentTurnMessage } from "./pi-core-types.js";

function makeSeed(overrides?: Partial<PiExecutionContextSeed>): PiExecutionContextSeed {
  return {
    source: { mode: "ephemeral", sessionKey: "test_session" },
    executionId: "exec_1",
    currentTurn: {
      role: "abtars_current_turn",
      executionId: "exec_1",
      sessionId: "session_1",
      content: "Hello!",
      timestamp: Date.now(),
    },
    volatileBlocks: [],
    ...overrides,
  };
}

function durableSeed(beforeMessageId = 100): PiExecutionContextSeed {
  return makeSeed({
    source: { mode: "durable", sessionKey: "test_session", beforeMessageId, maxContext: 8000, userId: "user-1" },
  });
}

function makeAgentMessages(withMarker = true): import("./pi-core-types.js").AgentMessage[] {
  const msgs: import("./pi-core-types.js").AgentMessage[] = [
    { role: "assistant", content: "How can I help?" },
  ];
  if (withMarker) {
    msgs.push({
      role: "abtars_current_turn",
      executionId: "exec_1",
      sessionId: "session_1",
      content: "Hello!",
      timestamp: Date.now(),
    } as AbtarsCurrentTurnMessage);
  }
  return msgs;
}

function providerReturning(messages: Array<{ role: string; content: string }>) {
  return {
    async projectContext() {
      return { messages, estimatedTokens: 10, sourceMessageCount: messages.length };
    },
  };
}

describe("PiCoreContextProjection", () => {
  it("builds system prompt from seed", () => {
    const projection = new PiCoreContextProjection(
      makeSeed({ volatileBlocks: [{ kind: "workspace", content: "/home/user/proj" }] }),
      "You are a helpful assistant.",
    );
    const prompt = projection.buildSystemPromptFromSeed();
    expect(prompt).toContain("helpful assistant");
    expect(prompt).toContain("[workspace]");
    expect(prompt).toContain("/home/user/proj");
  });

  it("ephemeral transform preserves suffix from marker", async () => {
    const projection = new PiCoreContextProjection(makeSeed(), "system");
    const agentMessages = makeAgentMessages();
    const result = await projection.transform(agentMessages, { hostGeneration: 0 });
    expect(result.contextDegraded).toBe(false);
    // Suffix starts at the marker, so only the marker message is included (no durable projection)
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages[0]?.role).toBe("abtars_current_turn");
  });

  it("fallback on missing marker uses safe baseline", async () => {
    const projection = new PiCoreContextProjection(makeSeed(), "system");
    const result = await projection.transform(makeAgentMessages(true), { hostGeneration: 0 });
    expect(result.contextDegraded).toBe(false);

    const result2 = await projection.transform(makeAgentMessages(false), { hostGeneration: 0 });
    expect(result2.contextDegraded).toBe(true);
    expect(result2.messages.length).toBeGreaterThan(0);
  });

  it("returns empty fallback on first transform with no marker", async () => {
    const projection = new PiCoreContextProjection(makeSeed(), "system");
    const result = await projection.transform(makeAgentMessages(false), { hostGeneration: 0 });
    expect(result.contextDegraded).toBe(true);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.content).toBe("Hello!");
  });

  it("aborts transform when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const projection = new PiCoreContextProjection(makeSeed(), "system");
    const result = await projection.transform(makeAgentMessages(true), {
      signal: controller.signal,
      hostGeneration: 0,
    });
    expect(result.contextDegraded).toBe(true);
  });

  it("durable mode projects history through the provider and appends the suffix exactly once", async () => {
    let captured: unknown = null;
    const projection = new PiCoreContextProjection(durableSeed(100), "system");
    const provider = {
      async projectContext(input: unknown) {
        captured = input;
        return { messages: [
          { role: "user", content: "first turn" },
          { role: "assistant", content: "first answer" },
        ], estimatedTokens: 10, sourceMessageCount: 2 };
      },
    };
    const result = await projection.transform(makeAgentMessages(true), { hostGeneration: 0, contextProvider: provider });
    expect(captured).toEqual({ userId: "user-1", sessionId: "test_session", beforeMessageId: 100, maxContext: 8000 });
    // 2 durable rows + 1 suffix message (marker onward)
    expect(result.messages.length).toBe(3);
    expect(result.messages[0]?.content).toBe("first turn");
    expect((result.messages[1]?.content as Array<{ text: string }>)[0]?.text).toBe("first answer");
    expect(result.messages.some((m) => m.content === "Hello!")).toBe(true);
    expect(result.contextDegraded).toBe(false);
  });

  it("durable mode without a provider throws — never a suffix-only degraded success", async () => {
    const projection = new PiCoreContextProjection(durableSeed(), "system");
    await expect(projection.transform(makeAgentMessages(true), { hostGeneration: 0 }))
      .rejects.toBeInstanceOf(DurableContextUnavailableError);
    await expect(projection.transform(makeAgentMessages(true), { hostGeneration: 0 }))
      .rejects.toMatchObject({ reason: "no_provider" });
  });

  it("provider rejection throws a typed durable error (no fallback)", async () => {
    const projection = new PiCoreContextProjection(durableSeed(), "system");
    const provider = {
      async projectContext() { throw Object.assign(new Error("route lost"), { code: "unavailable" }); },
    };
    await expect(projection.transform(makeAgentMessages(true), { hostGeneration: 0, contextProvider: provider }))
      .rejects.toMatchObject({ reason: "provider_rejected" });
  });

  it("malformed provider output throws a typed durable error", async () => {
    const projection = new PiCoreContextProjection(durableSeed(), "system");
    const provider = {
      async projectContext() { return { messages: "nope" }; },
    };
    await expect(projection.transform(makeAgentMessages(true), { hostGeneration: 0, contextProvider: provider }))
      .rejects.toMatchObject({ reason: "malformed_response" });
  });

  it("cancellation between projection and suffix retains non-provider fallback semantics", async () => {
    const controller = new AbortController();
    const projection = new PiCoreContextProjection(durableSeed(), "system");
    const provider = {
      async projectContext() {
        return { messages: [{ role: "user", content: "history" }], estimatedTokens: 4, sourceMessageCount: 1 };
      },
    };
    const promise = projection.transform(makeAgentMessages(true), { hostGeneration: 0, contextProvider: provider, signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.contextDegraded).toBe(true);
  });

  it("abort of an in-flight provider call falls back instead of throwing (#1527)", async () => {
    const controller = new AbortController();
    const projection = new PiCoreContextProjection(durableSeed(), "system");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = {
      async projectContext() {
        await gate;
        throw Object.assign(new Error("aborted"), { code: "aborted" });
      },
    };
    const promise = projection.transform(makeAgentMessages(true), { hostGeneration: 0, contextProvider: provider, signal: controller.signal });
    controller.abort();
    release();
    const result = await promise;
    expect(result.contextDegraded).toBe(true);
  });
});

describe("#1705 context_projection diagnostic containment", () => {
  beforeEach(() => resetProjectionDiagnosticStateForTest());

  it("rate-limits one line per session per interval — a runaway hour stays under the target", () => {
    let emitted = 0;
    const start = 1_000_000;
    // Simulate one hot session transforming every few ms for a full hour:
    // the incident shape (per-transform DEBUG flood) must be impossible.
    for (let t = start; t < start + 3_600_000; t += 50) {
      if (shouldEmitProjectionDiagnostic("runaway_session", t)) emitted++;
    }
    expect(emitted).toBeLessThan(100);
    expect(emitted).toBe(60); // exactly one per 60s interval in the hour
  });

  it("deduplicates per session, not globally", () => {
    expect(shouldEmitProjectionDiagnostic("session-a", 1000)).toBe(true);
    expect(shouldEmitProjectionDiagnostic("session-b", 1000)).toBe(true);
    expect(shouldEmitProjectionDiagnostic("session-a", 2000)).toBe(false);
    expect(shouldEmitProjectionDiagnostic("session-b", 2000)).toBe(false);
    expect(shouldEmitProjectionDiagnostic("session-a", 1000 + PROJECTION_DIAGNOSTIC_MIN_INTERVAL_MS)).toBe(true);
  });

  it("a transform burst emits at most one success diagnostic (deterministic log-volume regression)", async () => {
    resetProjectionDiagnosticStateForTest();
    const provider = { async projectContext() { return { messages: [], estimatedTokens: 0, sourceMessageCount: 0 }; } };
    for (let i = 0; i < 500; i++) {
      const projection = new PiCoreContextProjection(durableSeed(), "system");
      const result = await projection.transform(makeAgentMessages(true), { hostGeneration: 0, contextProvider: provider });
      expect(result.contextDegraded).toBe(false);
    }
    // The 500 transforms above consumed this session's emission budget: the
    // gate is still rate-limiting, so the burst produced at most one line —
    // deterministically under the hourly bound.
    expect(shouldEmitProjectionDiagnostic("test_session", Date.now())).toBe(false);
  });
});
