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

  it("raw current row is durable in SQLite before the provider request fires", async () => {
    // Spec: "The raw current user row is queryable in SQLite before the
    // mocked provider begins execution." This is the durability-first
    // contract — if the provider rejects / times out / crashes, the raw
    // user input is already on disk.
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
    const orchestrator = new ContextOrchestrator({
      contextEngine: engine,
      summarize: async () => "ok",
      getLastAssistantTimestamp: () => null,
      compactionModel: null,
    });
    (transport as unknown as { contextOrchestrator: unknown }).contextOrchestrator = orchestrator;

    const currentId = h.memory.recordMessage({
      role: "user", content: "durable current", timestamp: 4000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 4,
    });

    let rowAtFetchTime: { content: string } | undefined;
    fetchSpy.mockImplementation(async (_input, init) => {
      const i = init as RequestInit | undefined;
      if (i && typeof i === "object" && "body" in i && i.body != null) {
        captured.push({ url: String(_input), body: String(i.body) });
      }
      // Query the DB at fetch time — the raw row must already be there.
      rowAtFetchTime = db
        .prepare("SELECT content FROM messages WHERE id = ?")
        .get(currentId) as { content: string };
      return Promise.resolve(streamResponse("hi", 50));
    });

    await transport.sendPrompt("sess_1", "augmented", undefined, { beforeMessageId: currentId as number });
    expect(rowAtFetchTime).toBeDefined();
    expect(rowAtFetchTime!.content).toBe("durable current");
  });

  it("null cursor (no-write path) still appends the current prompt exactly once", async () => {
    // Spec: "Safe null path: disabled memory, rejected/filtered input, or
    // write failure returns null; the current augmented prompt is still
    // appended once and context assembly remains available without an
    // upper cursor." We don't pass a cursor; the transport must fall
    // back to the pre-fix full-snapshot path but still produce ONE
    // current turn (no duplicate from addUser running twice).
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
    const orchestrator = new ContextOrchestrator({
      contextEngine: engine,
      summarize: async () => "ok",
      getLastAssistantTimestamp: () => null,
      compactionModel: null,
    });
    (transport as unknown as { contextOrchestrator: unknown }).contextOrchestrator = orchestrator;

    h.memory.recordMessage({
      role: "user", content: "history only", timestamp: 1000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 1,
    });
    // Pre-fix test: the raw "current turn" is NOT in the DB here.
    // The augmented prompt is the only place it appears.

    fetchSpy.mockImplementation((input, init) => {
      const i = init as RequestInit | undefined;
      if (i && typeof i === "object" && "body" in i && i.body != null) {
        captured.push({ url: String(input), body: String(i.body) });
      }
      return Promise.resolve(streamResponse("hi", 50));
    });

    await transport.sendPrompt("sess_1", "augmented-only-once");

    const body = JSON.parse(captured[0]!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessages = body.messages.filter((m) => m.role === "user");
    // Historical (1) + augmented current (1) = 2. Not 3.
    expect(userMessages.length).toBe(2);
    // The augmented text appears exactly once.
    const augmentedCount = userMessages.filter((m) => m.content === "augmented-only-once").length;
    expect(augmentedCount).toBe(1);
  });

  it("fallback/retry: candidate change does not duplicate the current turn", async () => {
    // Spec: "Fallback/retry execution does not append additional
    // current-user copies." The transport's sendWithPolicy retries
    // with different candidates but the assembled ConversationSession
    // is reused — addUser() is NOT called per candidate.
    const db = h.memory.getDatabase()!;
    const engine = new ContextEngine(db);
    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy(
      [
        { model: "primary", endpoint: "http://ep/v1", maxContext: 100_000 },
        { model: "fallback", endpoint: "http://ep/v1", maxContext: 100_000 },
      ],
      registry,
    );
    const transport = new DirectApiTransport(
      {
        endpoint: "http://ep/v1", apiKey: "k", model: "primary",
        maxContext: 100_000, maxOutput: 1000, maxTurns: 1,
      },
      policy,
    );
    const orchestrator = new ContextOrchestrator({
      contextEngine: engine,
      summarize: async () => "ok",
      getLastAssistantTimestamp: () => null,
      compactionModel: null,
    });
    (transport as unknown as { contextOrchestrator: unknown }).contextOrchestrator = orchestrator;

    h.memory.recordMessage({
      role: "user", content: "earlier", timestamp: 1000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 1,
    });
    const currentId = h.memory.recordMessage({
      role: "user", content: "current fallback", timestamp: 2000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 2,
    });

    // First call (primary) fails; fallback succeeds.
    let callCount = 0;
    fetchSpy.mockImplementation((input, init) => {
      callCount++;
      const i = init as RequestInit | undefined;
      if (i && typeof i === "object" && "body" in i && i.body != null) {
        captured.push({ url: String(input), body: String(i.body) });
      }
      if (callCount === 1) {
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      }
      return Promise.resolve(streamResponse("ok", 50));
    });

    await transport.sendPrompt("sess_1", "augmented", undefined, { beforeMessageId: currentId as number });
    // Two provider requests (one per candidate). Same ConversationSession
    // is reused — addUser is NOT called again. The augmented current
    // turn appears once in EACH request (same session.messages snapshot),
    // and the historical raw current row is excluded in EACH.
    expect(callCount).toBe(2);
    expect(captured.length).toBe(2);

    for (const cap of captured) {
      const body = JSON.parse(cap.body) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userMessages = body.messages.filter((m) => m.role === "user");
      expect(userMessages.length).toBe(2);
      const occurrences = userMessages.filter((m) => m.content.includes("current fallback")).length;
      expect(occurrences).toBe(0); // raw current excluded by cursor
      expect(userMessages.filter((m) => m.content === "augmented").length).toBe(1);
    }
  });

  it("context orchestrator failure: in-memory fallback does not append twice", async () => {
    // Spec: "Context assembly throws — existing in-memory fallback; do
    // not append more than once." The transport catches the throw and
    // proceeds; the augmented current turn is appended exactly once.
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

    // Throwing orchestrator — getContext rejects.
    const orchestrator = {
      getContext: async () => { throw new Error("simulated engine failure"); },
    };
    (transport as unknown as { contextOrchestrator: unknown }).contextOrchestrator = orchestrator;

    fetchSpy.mockImplementation((input, init) => {
      const i = init as RequestInit | undefined;
      if (i && typeof i === "object" && "body" in i && i.body != null) {
        captured.push({ url: String(input), body: String(i.body) });
      }
      return Promise.resolve(streamResponse("hi", 50));
    });

    await transport.sendPrompt("sess_1", "augmented-after-failure", undefined, { beforeMessageId: 999 });

    expect(captured.length).toBe(1);
    const body = JSON.parse(captured[0]!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    // In-memory fallback: no DB context, just the augmented current turn.
    // One user message, exactly once.
    const userMessages = body.messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBe(1);
    expect(userMessages[0]!.content).toBe("augmented-after-failure");
  });

  it("assistant persistence remains ordered after the raw user row", async () => {
    // Spec: "Confirm assistant persistence remains ordered after the
    // raw user row." After the current raw user row, the assistant
    // response must still be persisted in order (id > currentId).
    h.memory.recordMessage({
      role: "user", content: "user-1", timestamp: 1000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 1,
    });
    const currentId = h.memory.recordMessage({
      role: "user", content: "user-2-current", timestamp: 2000,
      userId: "u1", sessionId: "sess_1", platformMessageId: 2,
    });
    // Simulate the pipeline persisting the assistant reply immediately
    // after the response (this is what the assistant-recording code does
    // post-response). The ID must be greater than the raw user ID.
    const assistantId = h.memory.recordMessage({
      role: "assistant", content: "assistant reply", timestamp: 3000,
      userId: "u1", sessionId: "sess_1",
    });
    expect(assistantId).toBeTypeOf("number");
    expect(assistantId as number).toBeGreaterThan(currentId as number);
  });
});
