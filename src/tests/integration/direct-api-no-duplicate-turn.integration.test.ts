/**
 * #1329 — Direct API does not duplicate the current user turn.
 *
 * Pipeline ordering under test:
 *   1. recordMessage() persists the raw current row and returns its ID.
 *   2. buildPrompt() augments the user input and exposes the ID as
 *      `currentMessageId`.
 *   3. The chokepoint at spin.ts#sendPrompt converts it into
 *      `PromptRequestContext.beforeMessageId`.
 *   4. DirectApiTransport passes the cursor into
 *      ContextOrchestrator.getContext(); the raw current row is excluded
 *      from the historical snapshot.
 *   5. The transport appends the augmented current turn exactly once.
 *
 * The captured provider request must therefore contain historical turns
 * plus ONE augmented current user turn — never the raw current row.
 *
 * Originally written as a RED test (pre-fix) that failed with
 * "expected 3 to be 2" — three user messages in the request instead
 * of two. After Tasks 2-4 it passes; the reproduction lives in the
 * commit log of task 1.
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

  it("captured request contains the current user turn exactly once", async () => {
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
    // #1329 Task 2 returns the inserted ID; the pipeline carries it
    // through to the transport as the exclusive beforeMessageId cursor.
    const currentId = h.memory.recordMessage({
      role: "user", content: "current question beta", timestamp: 3000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 3,
    });
    expect(currentId).toBeTypeOf("number");

    fetchSpy.mockImplementation((input, init) => {
      const i = init as RequestInit | undefined;
      if (i && typeof i === "object" && "body" in i && i.body != null) {
        captured.push({ url: String(input), body: String(i.body) });
      }
      return Promise.resolve(streamResponse("hi", 50));
    });

    // The pipeline hands the AUGMENTED current prompt to the transport
    // (timestamp/recall/session-start context injected by buildPrompt).
    // The 4th arg mirrors the post-Task-4 chokepoint: PromptRequestContext
    // carries the just-persisted message ID as the exclusive cursor so
    // DB-backed context assembly excludes the raw current row.
    const augmented = "[2026-07-10 21:00] current question beta\n<recall>none</recall>";
    await transport.sendPrompt("sess_1", augmented, undefined, { beforeMessageId: currentId as number });

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
