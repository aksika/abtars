import { describe, it, expect, beforeEach } from "vitest";
import { PiCoreContextProjection } from "./pi-core-context.js";
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

  it("durable mode uses orchestrator rows", async () => {
    const seed = makeSeed({
      source: { mode: "durable", sessionKey: "test_session", beforeMessageId: 100, maxContext: 8000 },
    });
    const projection = new PiCoreContextProjection(seed, "system");
    let rowsCalled = false;
    const result = await projection.transform(makeAgentMessages(true), {
      hostGeneration: 0,
      orchestrator: {
        async getContext(_sessionKey: string, _maxContext: number, _opts: { beforeMessageId?: number }) {
          rowsCalled = true;
          return { messages: [{ role: "user", content: "previous message" }] };
        },
      },
    });
    expect(rowsCalled).toBe(true);
    // 1 durable row + 1 suffix message (from marker onward)
    expect(result.messages.length).toBe(2);
    expect(result.messages.some((m) => m.content === "Hello!")).toBe(true);
  });

  it("durable mode without orchestrator returns empty projection", async () => {
    const seed = makeSeed({
      source: { mode: "durable", sessionKey: "test_session", beforeMessageId: 100, maxContext: 8000 },
    });
    const projection = new PiCoreContextProjection(seed, "system");
    const result = await projection.transform(makeAgentMessages(true), { hostGeneration: 0 });
    // No orchestrator → no durable rows, just suffix (marker onward), degraded.
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.role).toBe("abtars_current_turn");
    expect(result.contextDegraded).toBe(true);
  });

  it("projection failure keeps the latest in-flight suffix", async () => {
    const seed = makeSeed({
      source: { mode: "durable", sessionKey: "test_session", beforeMessageId: 100, maxContext: 8000 },
    });
    const projection = new PiCoreContextProjection(seed, "system");
    const first = await projection.transform(makeAgentMessages(true), {
      orchestrator: {
        async getContext() {
          return { messages: [{ role: "user", content: "durable history" }] };
        },
      },
    });
    expect(first.contextDegraded).toBe(false);

    const latest = [
      ...makeAgentMessages(true),
      { role: "assistant", content: [{ type: "text" as const, text: "in-flight" }] },
    ] as import("./pi-core-types.js").AgentMessage[];
    const failed = await projection.transform(latest, {
      orchestrator: {
        async getContext() {
          throw new Error("abmind unavailable");
        },
      },
    });
    expect(failed.contextDegraded).toBe(true);
    expect(failed.messages.at(-1)?.role).toBe("assistant");
  });
});
