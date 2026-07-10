/**
 * #1329 — Lock the duplicate-current-turn bug with a failing integration test.
 *
 * Pre-fix, the DB-backed Direct API path makes the just-persisted raw user
 * message visible to context assembly and then appends the augmented form
 * of the same turn, so the provider sees the current turn twice.
 *
 * This test asserts the GOOD behavior (one current user turn, exactly once
 * in the captured request). It will fail on pre-fix code; the failure names
 * the duplicate, which is the bug. After Tasks 2-4 it turns green.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createHarness, type IntegrationHarness } from "./harness.js";
import { DirectApiTransport } from "../../components/transport/direct-api-transport.js";
import { FallbackPolicy } from "../../components/transport/fallback-policy.js";
import { ModelHealthRegistry } from "../../components/transport/model-health-registry.js";
import { ContextEngine, ContextOrchestrator } from "abmind";

describe("#1329 — Direct API does not duplicate current user turn", () => {
  let h: IntegrationHarness;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const captured: Array<{ url: string; body: string }> = [];

  beforeEach(async () => {
    h = await createHarness();
    captured.length = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockReset();
    h.cleanup();
  });

  function streamResponse(content: string, promptTokens = 50): Response {
    const line = `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: content.length },
    })}\n\ndata: [DONE]\n\n`;
    return new Response(line, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }) as unknown as Response;
  }

  it("captured request contains the current user turn exactly once (RED on pre-fix)", async () => {
    const db = h.memory.getDatabase()!;
    const engine = new ContextEngine(db);

    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy(
      [{ model: "m1", endpoint: "http://ep/v1", maxContext: 100_000 }],
      registry,
    );
    const transport = new DirectApiTransport(
      {
        endpoint: "http://ep/v1", apiKey: "k", model: "m1",
        maxContext: 100_000, maxOutput: 1000, maxTurns: 1,
      },
      policy,
    );

    // Real orchestrator + a no-op summarizer (token budget never exceeded).
    const orchestrator = new ContextOrchestrator({
      contextEngine: engine,
      summarize: async () => "ok",
      getLastAssistantTimestamp: () => null,
      compactionModel: null,
    });
    (transport as unknown as { contextOrchestrator: unknown }).contextOrchestrator = orchestrator;

    // Historical turns already in the DB (conversation BEFORE this turn).
    h.memory.recordMessage({
      role: "user", content: "earlier question alpha", timestamp: 1000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 1,
    });
    h.memory.recordMessage({
      role: "assistant", content: "earlier answer alpha", timestamp: 2000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 2,
    });

    // Pipeline persists the CURRENT raw user row before sendPrompt.
    // (#1329 Task 4 will route this ID through to the orchestrator.)
    h.memory.recordMessage({
      role: "user", content: "current question beta", timestamp: 3000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 3,
    });

    fetchSpy.mockImplementation((input, init) => {
      const i = init as RequestInit | undefined;
      if (i && typeof i === "object" && "body" in i && i.body != null) {
        captured.push({ url: String(input), body: String(i.body) });
      }
      return Promise.resolve(streamResponse("hi", 50));
    });

    // The pipeline hands the AUGMENTED current prompt to the transport
    // (timestamp/recall/session-start context injected by buildPrompt).
    const augmented = "[2026-07-10 21:00] current question beta\n<recall>none</recall>";
    await transport.sendPrompt("sess_1", augmented);

    // Exactly one provider request was made.
    expect(captured.length).toBe(1);
    const body = JSON.parse(captured[0]!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessages = body.messages.filter((m) => m.role === "user");

    // 1 historical user + 1 current user (augmented) = 2 total.
    // Pre-fix: 3 (the raw current row leaks from DB and the augmented
    // current is appended on top).
    expect(userMessages.length).toBe(2);

    // The current raw text "current question beta" should appear EXACTLY
    // ONCE in the conversation — as part of the augmented current turn.
    // Pre-fix: appears twice (raw row from DB + augmented turn).
    const occurrences = userMessages.filter((m) =>
      m.content.includes("current question beta"),
    ).length;
    expect(occurrences).toBe(1);
  });
});
