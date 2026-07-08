import { describe, it, expect } from "vitest";
import {
  pickPiApi, buildPiModel, buildPiContext, resolveReasoning,
  translatePiAiEvents, mapPiAiError, streamPiAiCompletion,
  PiAiUnavailableError,
  type PiAiCandidate, type PiAiConversation, type PiAssistantMessageEvent,
  type PiAssistantMessage, type PiAiModule, type PiProviderStreams,
} from "./pi-ai-adapter.js";
import type { SSEEvent } from "./sse-parser.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function assistant(over: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return {
    role: "assistant", content: [], usage: ZERO_USAGE, stopReason: "stop",
    ...over,
  } as PiAssistantMessage;
}

/** Drive an async generator to completion, collecting yielded values (rethrows). */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

function fakeEventStream(events: PiAssistantMessageEvent[]): PiProviderStreams["streamSimple"] {
  return async function* _fake() { for (const e of events) yield e; };
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
    const ctx = buildPiContext(conv);
    expect(ctx.systemPrompt).toBe("be brief");
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]!.role).toBe("user");
    // assistant: one text block + one toolCall block with parsed object args
    const a = ctx.messages[1]!;
    expect(a.role).toBe("assistant");
    expect(a.content[0]).toEqual({ type: "text", text: "hello" });
    expect(a.content[1]).toEqual({ type: "toolCall", id: "t1", name: "run", arguments: { cmd: "ls" } });
    // tool message → toolResult
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
    const events: PiAssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "Hel", partial: assistant() },
      { type: "text_delta", contentIndex: 0, delta: "lo", partial: assistant() },
      { type: "done", reason: "stop", message: assistant({ usage: { input: 12, output: 2, cacheRead: 5, cacheWrite: 3 } }) },
    ];
    const out = await collect(translatePiAiEvents(fakeAsync(events)));
    expect(out).toEqual<SSEEvent[]>([
      { type: "chunk", content: "Hel" },
      { type: "chunk", content: "lo" },
      { type: "done", usage: { prompt_tokens: 12, completion_tokens: 2 }, cacheRead: 5, cacheWrite: 3 },
    ]);
  });

  it("routes thinking deltas to 'thinking' events (never chunks)", async () => {
    const out = await collect(translatePiAiEvents(fakeAsync([
      { type: "thinking_delta", contentIndex: 0, delta: "hm", partial: assistant() },
      { type: "text_delta", contentIndex: 1, delta: "ans", partial: assistant() },
    ])));
    expect(out).toEqual<SSEEvent[]>([
      { type: "thinking", content: "hm" },
      { type: "chunk", content: "ans" },
    ]);
  });

  it("emits one complete tool_call_delta per toolcall_end", async () => {
    const out = await collect(translatePiAiEvents(fakeAsync([
      { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } }, partial: assistant() },
      { type: "done", reason: "stop", message: assistant() },
    ])));
    expect(out[0]).toMatchObject({ type: "tool_call_delta", index: 0, id: "c1", name: "bash" });
    expect((out[0] as { arguments?: string }).arguments).toBe(JSON.stringify({ cmd: "ls" }));
  });

  it("flushes delta-only tool calls (no toolcall_end) before done", async () => {
    const out = await collect(translatePiAiEvents(fakeAsync([
      { type: "toolcall_start", contentIndex: 0, partial: assistant({ content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }] }) },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"a":1', partial: assistant() },
      { type: "toolcall_delta", contentIndex: 0, delta: "}", partial: assistant() },
      { type: "done", reason: "stop", message: assistant() },
    ])));
    // The toolcall_start partial carries the id/name via the running partial — we surface them.
    expect(out[0]).toMatchObject({ type: "tool_call_delta", name: "bash", arguments: '{"a":1}' });
    const last = out[out.length - 1]!;
    expect(last.type).toBe("done");
  });

  it("throws an 'API error <status>' Error on a retryable error event", async () => {
    const gen = translatePiAiEvents(fakeAsync([
      { type: "error", reason: "error", error: assistant({ errorMessage: "overloaded (529): try again", stopReason: "error" }) },
    ]), () => true); // pi says retryable
    await expect(collect(gen)).rejects.toThrow(/API error 529/);
  });
});

// ── mapPiAiError ─────────────────────────────────────────────────────────────

describe("mapPiAiError", () => {
  it("retryable → transient (default 500 when no status)", () => {
    expect(mapPiAiError(assistant({ errorMessage: "overloaded" }), true))
      .toMatchObject({ status: 500, kind: "transient" });
  });
  it("retryable preserves an extracted status", () => {
    expect(mapPiAiError(assistant({ errorMessage: "stream ended (503)" }), true))
      .toMatchObject({ status: 503, kind: "transient" });
  });
  it("non-retryable quota → rate_limit + rotate (429)", () => {
    expect(mapPiAiError(assistant({ errorMessage: "insufficient quota / GoUsageLimitError" }), false))
      .toMatchObject({ status: 429, kind: "rate_limit" });
  });
  it("non-retryable auth (401) → auth", () => {
    expect(mapPiAiError(assistant({ errorMessage: "401 invalid api key" }), false))
      .toMatchObject({ status: 401, kind: "auth" });
  });
  it("non-retryable generic → rate_limit (safe rotate default)", () => {
    expect(mapPiAiError(assistant({ errorMessage: "something broke" }), false))
      .toMatchObject({ status: 429, kind: "rate_limit" });
  });
  it("detects a retry-after cooldown from the message text", () => {
    const m = mapPiAiError(assistant({ errorMessage: "rate limited; retry_after: 12 daily limit" }), true);
    expect(m.retryAfterMs).toBeGreaterThan(0);
  });
  it("emits text in the 'API error <status>: …' shape parseErrorStatus reads", () => {
    expect(mapPiAiError(assistant({ errorMessage: "boom" }), true).text).toMatch(/^API error 500: boom/);
  });
});

// ── streamPiAiCompletion orchestration (injected fakes — no pi-ai needed) ─────

describe("streamPiAiCompletion", () => {
  const candidate: PiAiCandidate = { model: "glm-4.6", endpoint: "https://api.z.ai/api/v1", apiKey: "k", apiFormat: "chat", maxOutput: 1024, sessionId: "s1" };
  const conv: PiAiConversation = { messages: [{ role: "user", content: "hi" }], tools: [] };

  function fakePi(streamSimple: PiProviderStreams["streamSimple"], isRetryable = () => false): PiAiModule {
    return {
      createProvider: (input) => {
        const api = input.api as PiProviderStreams;
        return { streamSimple: (model, ctx, opts) => api.streamSimple(model, ctx, opts) };
      },
      isRetryableAssistantError: isRetryable,
    };
  }

  it("builds a provider from the candidate and translates the stream end-to-end", async () => {
    const events: PiAssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "hi back", partial: assistant() },
      { type: "done", reason: "stop", message: assistant({ usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 } }) },
    ];
    const api: PiProviderStreams = { stream: fakeEventStream(events), streamSimple: fakeEventStream(events) };
    const out = await collect(streamPiAiCompletion(candidate, conv, new AbortController().signal, {
      loadPi: async () => fakePi(api.streamSimple),
      loadApi: async () => api,
    }));
    expect(out.map(e => e.type)).toEqual(["chunk", "done"]);
  });

  it("throws PiAiUnavailableError when pi cannot be loaded", async () => {
    const gen = streamPiAiCompletion(candidate, conv, new AbortController().signal, {
      loadPi: async () => { throw new Error("ENOENT: cannot resolve @earendil-works/pi-ai"); },
      loadApi: async () => { throw new Error("not reached"); },
    });
    await expect(collect(gen)).rejects.toBeInstanceOf(PiAiUnavailableError);
  });

  it("propagates a request error as 'API error <status>' (→ L2 rotation)", async () => {
    const events: PiAssistantMessageEvent[] = [
      { type: "error", reason: "error", error: assistant({ errorMessage: "429 rate limit", stopReason: "error" }) },
    ];
    const api: PiProviderStreams = { stream: fakeEventStream(events), streamSimple: fakeEventStream(events) };
    const gen = streamPiAiCompletion(candidate, conv, new AbortController().signal, {
      loadPi: async () => fakePi(api.streamSimple, () => false),
      loadApi: async () => api,
    });
    await expect(collect(gen)).rejects.toThrow(/API error 429/);
  });
});

/** Wrap a plain array as the minimal AsyncIterable the translator iterates. */
function fakeAsync<T>(items: T[]): AsyncIterable<T> {
  return { [Symbol.asyncIterator]() { let i = 0; return { async next() { return i < items.length ? { value: items[i++]!, done: false } : { value: undefined, done: true }; } }; } };
}
