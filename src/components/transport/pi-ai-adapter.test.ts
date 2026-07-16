import { describe, it, expect } from "vitest";
import type {
  Api, ThinkingLevel, Model, AssistantMessage, AssistantMessageEvent,
  ProviderStreams, CreateProviderOptions, Provider,
} from "@earendil-works/pi-ai";

import {
  pickPiApi, buildPiModel, buildPiContext, resolveReasoning,
  translatePiAiEvents, mapPiAiError, streamPiAiCompletion,
  PiAiUnavailableError,
  type PiAiCandidate, type PiAiConversation, type PiAiModule,
} from "./pi-ai-adapter.js";
import type { SSEEvent } from "./sse-parser.js";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function makeAssistantMessage(over: Partial<AssistantMessage> & { content?: AssistantMessage["content"] } = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions" as Api,
    provider: "test",
    model: "",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 0,
    ...over,
  } as AssistantMessage;
}

/** Drive an async generator to completion, collecting yielded values (rethrows). */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

function fakeEventStream(events: AssistantMessageEvent[]): ProviderStreams["streamSimple"] {
  return async function* _fake() { for (const e of events) yield e; };
}

/** Wrap a plain array as the minimal AsyncIterable the translator iterates. */
function fakeAsync<T>(items: T[]): AsyncIterable<T> {
  return { [Symbol.asyncIterator]() { let i = 0; return { async next() { return i < items.length ? { value: items[i++]!, done: false } : { value: undefined, done: true }; } }; } };
}

// ── pickPiApi ────────────────────────────────────────────────────────────────

describe("pickPiApi", () => {
  it("maps abtars apiFormat → pi Api family", () => {
    expect(pickPiApi("responses")).toBe("openai-responses");
    expect(pickPiApi("anthropic")).toBe("anthropic-messages");
    expect(pickPiApi("chat")).toBe("openai-completions");
    expect(pickPiApi(undefined)).toBe("openai-completions");
  });
});

// ── resolveReasoning ─────────────────────────────────────────────────────────

describe("resolveReasoning", () => {
  const base: PiAiCandidate = { model: "m", endpoint: "https://x/v1", maxOutput: 1024 };

  it("enables reasoning from a session override", () => {
    expect(resolveReasoning({ ...base, reasoningEffort: "high" })).toEqual({ reasoning: true, level: "high" });
  });
  it("enables reasoning from effort-style thinking config", () => {
    expect(resolveReasoning({ ...base, thinking: { style: "effort", default: "medium" } })).toEqual({ reasoning: true, level: "medium" });
  });
  it("clamps an unknown effort string to medium", () => {
    expect(resolveReasoning({ ...base, thinking: { style: "effort", default: "bogus" } })).toEqual({ reasoning: true, level: "medium" });
  });
  it("does not enable reasoning for extended-budget style (deferred to bake)", () => {
    expect(resolveReasoning({ ...base, thinking: { style: "extended", default: 4096 } })).toEqual({ reasoning: false, level: undefined });
  });
  it("disables reasoning when nothing is configured", () => {
    expect(resolveReasoning(base)).toEqual({ reasoning: false, level: undefined });
  });
  it('thinking.style: "default" → reasoning: true, level: undefined (no override)', () => {
    expect(resolveReasoning({ ...base, thinking: { style: "default" } })).toEqual({ reasoning: true, level: undefined });
  });
  it('thinking.style: "default" wins over a stale session.reasoningEffort (default takes precedence for the agent\'s mode)', () => {
    expect(resolveReasoning({ ...base, thinking: { style: "default" }, reasoningEffort: "high" })).toEqual({ reasoning: true, level: undefined });
  });
  it('reasoningEffort: "off" → reasoning disabled (ThinkingLevel excludes "off")', () => {
    expect(resolveReasoning({ ...base, reasoningEffort: "off" })).toEqual({ reasoning: false, level: undefined });
  });
});

// ── buildPiModel ─────────────────────────────────────────────────────────────

describe("buildPiModel", () => {
  it("constructs a single Model from the candidate (not a catalog)", () => {
    const m = buildPiModel({ model: "glm-4.6", endpoint: "https://api.z.ai/api/v1", maxOutput: 2048, apiFormat: "chat" }, "openai-completions", false, "api-z-ai");
    expect(m.id).toBe("glm-4.6");
    expect(m.baseUrl).toBe("https://api.z.ai/api/v1");
    expect(m.api).toBe("openai-completions");
    expect(m.provider).toBe("api-z-ai");
    expect(m.maxTokens).toBe(2048);
    expect(m.input).toEqual(["text"]);
    expect(m.reasoning).toBe(false);
  });
  it("advertises image input when the conversation has an image", () => {
    const m = buildPiModel({ model: "m", endpoint: "https://x/v1", maxOutput: 512 }, "openai-completions", true, "x");
    expect(m.input).toEqual(["text", "image"]);
  });
  it("W2 — Model.baseUrl is the candidate's endpoint (abtars gateway wins)", () => {
    const m = buildPiModel(
      { model: "gpt-4o", endpoint: "https://9router.example.com/v1", maxOutput: 2048, apiFormat: "chat" },
      "openai-completions", false, "9router-example-com",
    );
    expect(m.baseUrl).toBe("https://9router.example.com/v1");
  });
  it("#1326 — Model.contextWindow reflects candidate.contextWindow when present", () => {
    const m = buildPiModel(
      { model: "m", endpoint: "https://x/v1", maxOutput: 1024, contextWindow: 262144 },
      "openai-completions", false, "x",
    );
    expect(m.contextWindow).toBe(262144);
  });
  it("#1326 — Model.contextWindow defaults to 0 when candidate omits the field (legacy fixtures)", () => {
    const m = buildPiModel(
      { model: "m", endpoint: "https://x/v1", maxOutput: 1024 },
      "openai-completions", false, "x",
    );
    expect(m.contextWindow).toBe(0);
  });
});

// ── buildPiContext ───────────────────────────────────────────────────────────

describe("buildPiContext", () => {
  it("collapses system messages into systemPrompt and translates the rest", () => {
    const conv: PiAiConversation = {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: '{"cmd":"ls"}' } }] },
        { role: "tool", content: "ok", tool_call_id: "t1", name: "run" },
      ],
      tools: [],
    };
    const ctx = buildPiContext(conv, "openai-completions", "test-provider");
    expect(ctx.systemPrompt).toBe("be brief");
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]!.role).toBe("user");
    const a = ctx.messages[1]!;
    expect(a.role).toBe("assistant");
    if (a.role === "assistant") {
      expect(a.content[0]).toEqual({ type: "text", text: "hello" });
      expect(a.content[1]).toEqual({ type: "toolCall", id: "t1", name: "run", arguments: { cmd: "ls" } });
    }
    const t = ctx.messages[2]!;
    expect(t.role).toBe("toolResult");
    expect(t).toMatchObject({ toolCallId: "t1", toolName: "run", isError: false });
  });

  it("parses data-URL image parts into pi image content", () => {
    const conv: PiAiConversation = {
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
          { type: "text", text: "what is this" },
        ],
      }],
      tools: [],
    };
    const ctx = buildPiContext(conv);
    const u = ctx.messages[0]!;
    expect(u.role).toBe("user");
    expect(Array.isArray(u.content)).toBe(true);
    expect((u.content as [{ type: string }])[0]).toEqual({ type: "image", data: "QUJDRA==", mimeType: "image/png" });
  });

  it("maps OpenAI tool schemas to pi Tool shape", () => {
    const conv: PiAiConversation = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } }],
    };
    expect(buildPiContext(conv).tools).toEqual([{ name: "bash", description: "run", parameters: { type: "object" } }]);
  });
});

// ── translatePiAiEvents ──────────────────────────────────────────────────────

describe("translatePiAiEvents", () => {
  it("turns text deltas into chunks and done into usage+cache", async () => {
    const events: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "Hel", partial: makeAssistantMessage() },
      { type: "text_delta", contentIndex: 0, delta: "lo", partial: makeAssistantMessage() },
      { type: "done", reason: "stop", message: makeAssistantMessage({ usage: { input: 12, output: 2, cacheRead: 5, cacheWrite: 3, totalTokens: 22, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) },
    ];
    const out = await collect(translatePiAiEvents(fakeAsync(events)));
    expect(out).toEqual<SSEEvent[]>([
      { type: "chunk", content: "Hel" },
      { type: "chunk", content: "lo" },
      { type: "done", usage: { prompt_tokens: 20, completion_tokens: 2 }, cacheRead: 5, cacheWrite: 3 },
    ]);
  });

  it("R1 — done prompt_tokens = input + cacheRead + cacheWrite (cache is ADDITIVE, not a subset of input)", async () => {
    const out = await collect(translatePiAiEvents(fakeAsync([
      { type: "done", reason: "stop", message: makeAssistantMessage({ usage: { input: 100, output: 4, cacheRead: 60, cacheWrite: 40, totalTokens: 204, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) },
    ])));
    const done = out[0]!;
    expect(done.type).toBe("done");
    expect((done as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(200);
  });

  it("routes thinking deltas to 'thinking' events (never chunks)", async () => {
    const out = await collect(translatePiAiEvents(fakeAsync([
      { type: "thinking_delta", contentIndex: 0, delta: "hm", partial: makeAssistantMessage() },
      { type: "text_delta", contentIndex: 1, delta: "ans", partial: makeAssistantMessage() },
    ])));
    expect(out).toEqual<SSEEvent[]>([
      { type: "thinking", content: "hm" },
      { type: "chunk", content: "ans" },
    ]);
  });

  it("emits one complete tool_call_delta per toolcall_end", async () => {
    const out = await collect(translatePiAiEvents(fakeAsync([
      { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } }, partial: makeAssistantMessage() },
      { type: "done", reason: "stop", message: makeAssistantMessage() },
    ])));
    expect(out[0]).toMatchObject({ type: "tool_call_delta", index: 0, id: "c1", name: "bash" });
    expect((out[0] as { arguments?: string }).arguments).toBe(JSON.stringify({ cmd: "ls" }));
  });

  it("flushes delta-only tool calls (no toolcall_end) before done", async () => {
    const out = await collect(translatePiAiEvents(fakeAsync([
      { type: "toolcall_start", contentIndex: 0, partial: makeAssistantMessage({ content: [{ type: "toolCall" as const, id: "x", name: "bash", arguments: {} }] }) },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"a":1', partial: makeAssistantMessage() },
      { type: "toolcall_delta", contentIndex: 0, delta: "}", partial: makeAssistantMessage() },
      { type: "done", reason: "stop", message: makeAssistantMessage() },
    ])));
    expect(out[0]).toMatchObject({ type: "tool_call_delta", name: "bash", arguments: '{"a":1}' });
    const last = out[out.length - 1]!;
    expect(last.type).toBe("done");
  });

  it("throws an 'API error <status>' Error on a retryable error event", async () => {
    const gen = translatePiAiEvents(fakeAsync([
      { type: "error", reason: "error", error: makeAssistantMessage({ errorMessage: "overloaded (529): try again", stopReason: "error" }) },
    ]), () => true);
    await expect(collect(gen)).rejects.toThrow(/API error 529/);
  });

  it("W4 — a mid-stream throw (after chunks) surfaces as an 'API error <status>' Error", async () => {
    const stream: AsyncIterable<AssistantMessageEvent> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i++ === 0) return { value: { type: "text_delta", contentIndex: 0, delta: "Hel", partial: makeAssistantMessage() } as AssistantMessageEvent, done: false };
            throw new Error("API error 502: bad gateway mid-stream");
          },
        };
      },
    };
    const out: SSEEvent[] = [];
    await expect((async () => { for await (const e of translatePiAiEvents(stream)) out.push(e); })()).rejects.toThrow(/API error 502/);
    expect(out[0]).toMatchObject({ type: "chunk", content: "Hel" });
  });
});

// ── mapPiAiError ─────────────────────────────────────────────────────────────

describe("mapPiAiError", () => {
  const errMsg = (errorMessage: string, over: Partial<AssistantMessage> = {}): AssistantMessage =>
    makeAssistantMessage({ errorMessage, stopReason: "error", ...over });

  it("retryable → transient (default 500 when no status)", () => {
    expect(mapPiAiError(errMsg("overloaded"), true))
      .toMatchObject({ status: 500, kind: "transient" });
  });
  it("retryable preserves an extracted status", () => {
    expect(mapPiAiError(errMsg("stream ended (503)"), true))
      .toMatchObject({ status: 503, kind: "transient" });
  });
  it("non-retryable quota → rate_limit + rotate (429)", () => {
    expect(mapPiAiError(errMsg("insufficient quota / GoUsageLimitError"), false))
      .toMatchObject({ status: 429, kind: "rate_limit" });
  });
  it("non-retryable auth (401) → auth", () => {
    expect(mapPiAiError(errMsg("401 invalid api key"), false))
      .toMatchObject({ status: 401, kind: "auth" });
  });
  it("non-retryable generic → rate_limit (safe rotate default)", () => {
    expect(mapPiAiError(errMsg("something broke"), false))
      .toMatchObject({ status: 429, kind: "rate_limit" });
  });
  it("non-retryable context-length 400 → context_exceeded (NOT rate_limit)", () => {
    const m = mapPiAiError(
      errMsg("400: {\"message\":\"This endpoint's maximum context length is 262144 tokens. However, you requested about 277597 tokens (11...\""),
      false,
    );
    expect(m.kind).toBe("context_exceeded");
    expect(m.status).toBe(400);
  });
  it("context-length 400 with isRetryable=true → still context_exceeded (regex wins over isRetryable)", () => {
    const m = mapPiAiError(
      errMsg("maximum context length exceeded"),
      true,
    );
    expect(m.kind).toBe("context_exceeded");
  });
  it("context_length_exceeded (snake_case variant) → context_exceeded", () => {
    expect(mapPiAiError(errMsg("context_length_exceeded"), false))
      .toMatchObject({ kind: "context_exceeded" });
  });
  it("detects a retry-after cooldown from the message text", () => {
    const m = mapPiAiError(errMsg("rate limited; retry_after: 12 daily limit"), true);
    expect(m.retryAfterMs).toBeGreaterThan(0);
  });
  it("emits text in the 'API error <status>: …' shape parseErrorStatus reads", () => {
    expect(mapPiAiError(errMsg("boom"), true).text).toMatch(/^API error 500: boom/);
  });
});

// ── streamPiAiCompletion orchestration (injected fakes — no pi-ai needed) ─────

describe("streamPiAiCompletion", () => {
  const candidate: PiAiCandidate = { model: "glm-4.6", endpoint: "https://api.z.ai/api/v1", apiKey: "k", apiFormat: "chat", maxOutput: 1024, sessionId: "s1" };
  const conv: PiAiConversation = { messages: [{ role: "user", content: "hi" }], tools: [] };

  function fakePi(streamSimple: ProviderStreams["streamSimple"], isRetryable = () => false): PiAiModule {
    return {
      createProvider: (input) => {
        const api = input.api as ProviderStreams;
        return {
          id: input.id,
          name: input.name ?? input.id,
          getModels: () => input.models as Model<Api>[],
          auth: input.auth,
          stream: (m, ctx, opts) => api.stream(m, ctx, opts as Record<string, unknown>),
          streamSimple: (m, ctx, opts) => api.streamSimple(m, ctx, opts as Record<string, unknown>),
        } as unknown as Provider;
      },
      isRetryableAssistantError: isRetryable,
    };
  }

  it("builds a provider from the candidate and translates the stream end-to-end", async () => {
    const events: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "hi back", partial: makeAssistantMessage() },
      { type: "done", reason: "stop", message: makeAssistantMessage({ usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) },
    ];
    const api: ProviderStreams = { stream: fakeEventStream(events), streamSimple: fakeEventStream(events) };
    const out = await collect(streamPiAiCompletion(candidate, conv, new AbortController().signal, {
      loadPi: () => fakePi(api.streamSimple),
      loadApi: () => api,
    }));
    expect(out.map(e => e.type)).toEqual(["chunk", "done"]);
  });

  it("throws PiAiUnavailableError when pi cannot be loaded", async () => {
    const gen = streamPiAiCompletion(candidate, conv, new AbortController().signal, {
      loadPi: () => { throw new Error("ENOENT: cannot resolve @earendil-works/pi-ai"); },
      loadApi: () => { throw new Error("not reached"); },
    });
    await expect(collect(gen)).rejects.toBeInstanceOf(PiAiUnavailableError);
  });

  it("propagates a request error as 'API error <status>' (→ L2 rotation)", async () => {
    const events: AssistantMessageEvent[] = [
      { type: "error", reason: "error", error: makeAssistantMessage({ errorMessage: "429 rate limit", stopReason: "error" }) },
    ];
    const api: ProviderStreams = { stream: fakeEventStream(events), streamSimple: fakeEventStream(events) };
    const gen = streamPiAiCompletion(candidate, conv, new AbortController().signal, {
      loadPi: () => fakePi(api.streamSimple, () => false),
      loadApi: () => api,
    });
    await expect(collect(gen)).rejects.toThrow(/API error 429/);
  });

  it("W2 — createProvider is called with candidate.endpoint as baseUrl", async () => {
    const customCandidate: PiAiCandidate = { model: "gpt-4o", endpoint: "https://9router.example.com/v1", apiKey: "k", apiFormat: "chat", maxOutput: 1024 };
    const events: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "ok", partial: makeAssistantMessage() },
      { type: "done", reason: "stop", message: makeAssistantMessage() },
    ];
    const api: ProviderStreams = { stream: fakeEventStream(events), streamSimple: fakeEventStream(events) };
    let captured: Record<string, unknown> | null = null;
    const piModule: PiAiModule = {
      createProvider: (input) => {
        captured = input as unknown as Record<string, unknown>;
        const a = input.api as ProviderStreams;
        return {
          id: input.id,
          name: input.name ?? input.id,
          getModels: () => input.models as Model<Api>[],
          auth: input.auth,
          stream: (m, ctx, opts) => a.stream(m, ctx, opts as Record<string, unknown>),
          streamSimple: (m, ctx, opts) => a.streamSimple(m, ctx, opts as Record<string, unknown>),
        } as unknown as Provider;
      },
      isRetryableAssistantError: () => false,
    };
    await collect(streamPiAiCompletion(customCandidate, conv, new AbortController().signal, {
      loadPi: () => piModule,
      loadApi: () => api,
    }));
    expect(captured).not.toBeNull();
    expect(captured!.baseUrl).toBe("https://9router.example.com/v1");
    expect((captured!.models as Array<{ id: string; baseUrl: string }>)[0]!.baseUrl).toBe("https://9router.example.com/v1");
  });

  it("L1 single call invokes streamSimple exactly once (L2 fallback policy not engaged)", async () => {
    let streamCount = 0;
    const events: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "single", partial: makeAssistantMessage() },
      { type: "done", reason: "stop", message: makeAssistantMessage() },
    ];
    const api: ProviderStreams = {
      stream: fakeEventStream(events),
      streamSimple: (() => {
        const inner = fakeEventStream(events);
        return ((model, ctx, opts) => { streamCount++; return inner(model, ctx, opts); }) as ProviderStreams["streamSimple"];
      })(),
    };
    const out = await collect(streamPiAiCompletion(candidate, conv, new AbortController().signal, {
      loadPi: () => fakePi(api.streamSimple),
      loadApi: () => api,
    }));
    expect(out.map(e => e.type)).toEqual(["chunk", "done"]);
    expect(streamCount).toBe(1);
  });

  // #1425 Task 5 — prove the options CONTRACT actually passed to pi-ai's streamSimple.
  // Not a source grep: capture the live options object and assert every field the
  // boundary depends on. abtars owns candidate/config translation + retry budget;
  // pi-ai must see maxRetries:0 (no retry authority beneath L2), the clamped
  // maxTokens, short cache retention, the session id for prompt-cache affinity,
  // the api key, the abort signal, and the resolved reasoning level.
  it("passes the verified options contract to pi-ai (maxRetries:0, cache/session, maxTokens, reasoning)", async () => {
    const events: AssistantMessageEvent[] = [
      { type: "done", reason: "stop", message: makeAssistantMessage() },
    ];
    let capturedOpts: Record<string, unknown> | null = null;
    const inner = fakeEventStream(events);
    const api: ProviderStreams = {
      stream: fakeEventStream(events),
      streamSimple: ((m, _ctx, opts) => { capturedOpts = opts as Record<string, unknown>; return inner(m, _ctx, opts); }) as ProviderStreams["streamSimple"],
    };
    const ac = new AbortController();
    const cand: PiAiCandidate = {
      model: "glm-4.6", endpoint: "https://api.z.ai/api/v1", apiKey: "sekret",
      apiFormat: "chat", maxOutput: 2048, contextWindow: 131072, sessionId: "sess-42",
      reasoningEffort: "high",
    };
    await collect(streamPiAiCompletion(cand, conv, ac.signal, {
      loadPi: () => fakePi(api.streamSimple),
      loadApi: () => api,
    }));
    expect(capturedOpts).not.toBeNull();
    // Retry budget: abtars L2 is the single authority.
    expect(capturedOpts!.maxRetries).toBe(0);
    // Candidate/config translation.
    expect(capturedOpts!.maxTokens).toBe(2048);
    expect(capturedOpts!.apiKey).toBe("sekret");
    expect(capturedOpts!.signal).toBe(ac.signal);
    // Cache/session (prompt-cache affinity is pi-ai's to wire).
    expect(capturedOpts!.cacheRetention).toBe("short");
    expect(capturedOpts!.sessionId).toBe("sess-42");
    // Reasoning level flows through ("high" from reasoningEffort).
    expect(capturedOpts!.reasoning).toBe("high");
  });

  it("omits reasoning from options when nothing is configured (no override)", async () => {
    const events: AssistantMessageEvent[] = [{ type: "done", reason: "stop", message: makeAssistantMessage() }];
    let capturedOpts: Record<string, unknown> | null = null;
    const inner = fakeEventStream(events);
    const api: ProviderStreams = {
      stream: fakeEventStream(events),
      streamSimple: ((m, _ctx, opts) => { capturedOpts = opts as Record<string, unknown>; return inner(m, _ctx, opts); }) as ProviderStreams["streamSimple"],
    };
    await collect(streamPiAiCompletion(candidate, conv, new AbortController().signal, {
      loadPi: () => fakePi(api.streamSimple),
      loadApi: () => api,
    }));
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.maxRetries).toBe(0);
    expect("reasoning" in capturedOpts!).toBe(false);
  });
});
