/**
 * #1311 Phase 1 — gate behavior for DirectApiTransport.
 * Verifies: (a) flag off → L0 only; (b) flag on + pi absent → falls through to L0
 * (independence A2); (c) flag on + pi present → pi path used, no L0 fetch;
 * (d) /emergency pins to L0 even with the flag on (D5).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── mock the pi-ai adapter so we never hit lazyRequire/auto-install ──────────
vi.mock("./pi-ai-adapter.js", () => {
  class PiAiUnavailableError extends Error {
    constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "PiAiUnavailableError"; }
  }
  return { PiAiUnavailableError, streamPiAiCompletion: vi.fn() };
});

import { DirectApiTransport } from "./direct-api-transport.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { ModelHealthRegistry, type ErrorKind } from "./model-health-registry.js";
import { streamPiAiCompletion, PiAiUnavailableError } from "./pi-ai-adapter.js";

const mockedStream = vi.mocked(streamPiAiCompletion);

function sseResponse(chunks: string[], usage = { prompt_tokens: 5, completion_tokens: 2 }): Response {
  const body = [
    ...chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }], usage })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function makeTransport(useProviderLib: boolean): DirectApiTransport {
  const registry = new ModelHealthRegistry();
  const policy = new FallbackPolicy([{ model: "m", endpoint: "https://api.test/v1", maxContext: 8000 }], registry);
  return new DirectApiTransport({
    endpoint: "https://api.test/v1", model: "m", maxContext: 8000, maxOutput: 1024, maxTurns: 4,
    apiFormat: "chat", useProviderLib,
  }, policy);
}

describe("DirectApiTransport — pi-ai gate (#1311)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockedStream.mockReset();
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("flag off → L0 reptile floor only (pi path never attempted)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["Hello from L0"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const t = makeTransport(false);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("Hello from L0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it("flag on + pi ABSENT → falls through to L0 (independence A2)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["L0 fallback"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    // pi load fails inside the adapter (generator throws on first iteration)
    mockedStream.mockImplementation(async function* () { throw new PiAiUnavailableError("pi not installed"); } as never);
    const t = makeTransport(true);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("L0 fallback");
    expect(mockedStream).toHaveBeenCalledTimes(1);   // attempted…
    expect(fetchMock).toHaveBeenCalledTimes(1);        // …then fell through to L0
  });

  it("flag on + pi PRESENT → pi path used, L0 fetch not touched", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["should not be used"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    mockedStream.mockImplementation(async function* () {
      yield { type: "chunk", content: "from pi" } as never;
      yield { type: "done", usage: { prompt_tokens: 3, completion_tokens: 2 }, cacheRead: 7, cacheWrite: 1 } as never;
    } as never);
    const t = makeTransport(true);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("from pi");
    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // cache totals plumbed through lastUsage (Task 3)
    expect(t.lastUsage()).toMatchObject({ input: 3, output: 2, cacheRead: 7, cacheWrite: 1 });
    expect(t.getRuntimeStatus()).toMatchObject({ model: "m", contextWindow: 8000, lastTurnUsage: { input: 3, output: 2, cacheRead: 7, cacheWrite: 1 } });
  });

  it("flag on + pi request error → propagates as 'API error <status>' to L2 (no L0 fetch)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["x"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    mockedStream.mockImplementation(async function* () {
      throw new Error("API error 429: rate limited");
    } as never);
    const t = makeTransport(true);
    // #1386: With a single candidate, L2 exhausts and returns a bounded transport-authored message.
    const result = await t.sendPrompt("s", "hi");
    expect(result).toContain("All available models failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("D5 — /emergency pins to L0 even with the flag on (pi never attempted)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["emergency L0"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    // If emergency ever reached the pi path, this throw would exhaust L2 and fail the prompt.
    mockedStream.mockImplementation(async function* () { throw new PiAiUnavailableError("must not be called"); } as never);
    const t = makeTransport(true);
    t.setEmergencyMode({ endpoint: "https://api.test/v1", model: "m", maxContext: 8000 });
    expect(t.isEmergencyMode).toBe(true);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("emergency L0");
    expect(mockedStream).not.toHaveBeenCalled();   // emergency bypassed pi entirely
    expect(fetchMock).toHaveBeenCalledTimes(1);     // …and used the L0 reptile floor
  });

  // #1311 Task 7 / W2 — endpoint-override at the integration level: when useProviderLib
  // is on, the pi-ai adapter must be called with the abtars candidate's endpoint, not
  // pi's catalog baseUrl. The candidate's endpoint comes from transport.json's provider
  // config, so a custom 9Router/OpenRouter-gateway/Ollama endpoint must reach the gateway,
  // not the upstream provider. We assert it by capturing the candidate.endpoint the
  // streamPiAiCompletion mock is called with.
  it("W2 — pi path is invoked with the abtars candidate's endpoint, not pi's catalog baseUrl", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse(["x"])) as unknown as typeof globalThis.fetch;
    const customEndpoint = "https://9router.example.com/v1";
    mockedStream.mockImplementation(async function* () {
      yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} as never } as never;
      yield { type: "done", reason: "stop", message: { usage: { prompt_tokens: 1, completion_tokens: 1 } } } as never;
    } as never);
    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy([{ model: "m", endpoint: customEndpoint, maxContext: 8000 }], registry);
    const t = new DirectApiTransport({
      endpoint: customEndpoint, model: "m", maxContext: 8000, maxOutput: 1024, maxTurns: 4,
      apiFormat: "chat", useProviderLib: true,
    }, policy);
    await t.sendPrompt("s", "hi");
    expect(mockedStream).toHaveBeenCalledTimes(1);
    const candidate = mockedStream.mock.calls[0]![0] as { endpoint: string };
    expect(candidate.endpoint).toBe(customEndpoint);
  });

  // #1311 Task 7 — L2 rotation over L0 when L1 is absent. pi throws PiAiUnavailableError
  // (independence A2 — pi not installed), so the gate falls through to L0. L0 fetch on
  // the primary candidate returns a non-retryable error (429), L2 rotates, the second
  // candidate's L0 fetch succeeds. Independence means the whole rotation chain works
  // without pi. (We use 429 because the L0 fetch's withRetry skips 429/401/402/403 —
  // the bucket loop must handle them, not the local retry.)
  it("L2 rotation over L0 when L1 is absent (independence A2 + rotation)", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockImplementationOnce(async () => new Response("rate limited", { status: 429 }))
      .mockImplementationOnce(async () => sseResponse(["fallback L0 ok"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    mockedStream.mockImplementation(async function* () { throw new PiAiUnavailableError("pi not installed"); } as never);
    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy([
      { model: "primary", endpoint: "https://api.test/v1", maxContext: 8000 },
      { model: "fallback", endpoint: "https://api.test/v1", maxContext: 8000 },
    ], registry);
    const t = new DirectApiTransport({
      endpoint: "https://api.test/v1", model: "primary", maxContext: 8000, maxOutput: 1024, maxTurns: 4,
      apiFormat: "chat", useProviderLib: true,
    }, policy);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("fallback L0 ok");
    // pi path attempted for both candidates (both throw PiAiUnavailableError, which the
    // gate catches → L0 fallthrough). The mock is called twice.
    expect(mockedStream).toHaveBeenCalledTimes(2);
    // L0 was hit twice: first 429 (non-retryable → L2 rotates), second 200 success.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both candidates recorded: primary got rate_limit (bucket increased but not skipped
    // at 0.5 with 0.7 threshold), fallback succeeded (bucket 0).
    expect(registry.shouldSkip("primary", "https://api.test/v1")).toBe(false);
    expect(registry.shouldSkip("fallback", "https://api.test/v1")).toBe(false);
  });

  // #1311 Task 7 / W4 — mid-stream throw (after at least one chunk) on a single pi
  // candidate must surface as 'API error <status>' so L2 records the error and rotates
  // to the next candidate. A bare throw (before any chunk) is also caught by L2, but
  // the contract is that L2 sees a tagged "API error <status>" Error so classifyError
  // maps it correctly. This test exercises the mid-stream throw path on candidate 1
  // and verifies L2 rotates to candidate 2 (success).
  it("W4 — mid-stream pi throw (after a chunk) → 'API error <status>' → L2 rotates to next candidate", async () => {
    const fetchMock = vi.fn(); globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    let call = 0;
    mockedStream.mockImplementation(async function* () {
      call++;
      if (call === 1) {
        // Mid-stream: one chunk, then a tagged API error throw (simulates pi-ai's SSE
        // stream dying mid-response with a 502). The chunk was already delivered
        // before the throw, so consumePiAi accumulated "half " and then the throw
        // propagates to streamCompletion → sendWithPolicy for rotation.
        yield { type: "chunk", content: "half " } as never;
        throw new Error("API error 502: bad gateway mid-stream");
      }
      // Candidate 2 succeeds.
      yield { type: "chunk", content: "candidate 2 ok" } as never;
      yield { type: "done", usage: { prompt_tokens: 1, completion_tokens: 1 }, cacheRead: 0, cacheWrite: 0 } as never;
    } as never);
    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy([
      { model: "primary", endpoint: "https://api.test/v1", maxContext: 8000 },
      { model: "fallback", endpoint: "https://api.test/v1", maxContext: 8000 },
    ], registry);
    const t = new DirectApiTransport({
      endpoint: "https://api.test/v1", model: "primary", maxContext: 8000, maxOutput: 1024, maxTurns: 4,
      apiFormat: "chat", useProviderLib: true,
    }, policy);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("candidate 2 ok");
    // pi path tried for both candidates (1 mid-stream throw, 1 success). L0 is never hit.
    expect(mockedStream).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // #1425 review — "pi classifies, abtars decides." The pi-ai adapter tags errors
  // it raises with piKind/piRetryAfterMs. L2 must honor that classification
  // instead of re-deriving it from the formatted status, because classifyError(status)
  // cannot express context_exceeded (HTTP 400 → transient). A context-overflow from
  // the pi path must reach recordError as context_exceeded (no bucket fill, no
  // cooldown) — otherwise a healthy model is penalized for our own oversized request.
  // The pair below proves context_exceeded and transient diverge at the bucket.
  it("#1425 — pi context-overflow (piKind=context_exceeded) does NOT fill the bucket", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse(["x"])) as unknown as typeof globalThis.fetch;
    const err = new Error("API error 400: This model's maximum context length is 262144 tokens.");
    (err as Error & { piKind?: ErrorKind }).piKind = "context_exceeded";
    mockedStream
      .mockImplementationOnce(async function* () { throw err; } as never)
      .mockImplementationOnce(async function* () {
        yield { type: "chunk", content: "candidate 2 ok" } as never;
        yield { type: "done", usage: { prompt_tokens: 1, completion_tokens: 1 }, cacheRead: 0, cacheWrite: 0 } as never;
      } as never);
    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy([
      { model: "primary", endpoint: "https://api.test/v1", maxContext: 8000 },
      { model: "fallback", endpoint: "https://api.test/v1", maxContext: 8000 },
    ], registry);
    const t = new DirectApiTransport({
      endpoint: "https://api.test/v1", model: "primary", maxContext: 8000, maxOutput: 1024, maxTurns: 4,
      apiFormat: "chat", useProviderLib: true,
    }, policy);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("candidate 2 ok");
    // context_exceeded is a static misconfiguration, not live model health → bucket stays 0.
    expect(registry.getBucketLevel("primary", "https://api.test/v1")).toBe(0);
  });

  it("#1425 — pi transient error (piKind=transient) DOES fill the bucket", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse(["x"])) as unknown as typeof globalThis.fetch;
    const err = new Error("API error 503: overloaded");
    (err as Error & { piKind?: ErrorKind }).piKind = "transient";
    mockedStream
      .mockImplementationOnce(async function* () { throw err; } as never)
      .mockImplementationOnce(async function* () {
        yield { type: "chunk", content: "candidate 2 ok" } as never;
        yield { type: "done", usage: { prompt_tokens: 1, completion_tokens: 1 }, cacheRead: 0, cacheWrite: 0 } as never;
      } as never);
    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy([
      { model: "primary", endpoint: "https://api.test/v1", maxContext: 8000 },
      { model: "fallback", endpoint: "https://api.test/v1", maxContext: 8000 },
    ], registry);
    const t = new DirectApiTransport({
      endpoint: "https://api.test/v1", model: "primary", maxContext: 8000, maxOutput: 1024, maxTurns: 4,
      apiFormat: "chat", useProviderLib: true,
    }, policy);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("candidate 2 ok");
    // transient fills the bucket (0.1 on the first hit) — proving the two kinds diverge.
    expect(registry.getBucketLevel("primary", "https://api.test/v1")).toBeGreaterThan(0);
  });

  // #1425 review — only context_exceeded is taken from the adapter's piKind tag.
  // For every other kind, classifyError(status) stays authoritative so abtars-specific
  // policy is preserved. The adapter coarsely maps quota/credit to rate_limit, but a
  // 402 "credits" error must still classify as the sticky `credits` kind (stays full
  // until manual /model reset) — NOT rate_limit (0.5, auto-recovers via leak).
  it("#1441 — PiAiUnavailableError alone (L0 succeeds) does not fill health bucket", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["L0 ok"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    mockedStream.mockImplementation(async function* () { throw new PiAiUnavailableError("pi not installed"); } as never);
    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy([
      { model: "primary", endpoint: "https://api.test/v1", maxContext: 8000 },
    ], registry);
    const t = new DirectApiTransport({
      endpoint: "https://api.test/v1", model: "primary", maxContext: 8000, maxOutput: 1024, maxTurns: 4,
      apiFormat: "chat", useProviderLib: true,
    }, policy);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("L0 ok");
    // PiAiUnavailableError is a pre-request loader failure — the gate falls through
    // to L0 without recording any error in the health registry.
    expect(registry.getBucketLevel("primary", "https://api.test/v1")).toBe(0);
  });

  it("#1425 — pi 402 credits error keeps the sticky `credits` kind (not the adapter's rate_limit tag)", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse(["x"])) as unknown as typeof globalThis.fetch;
    // The adapter would tag a quota/credit error as rate_limit; L2 must override to credits.
    const err = new Error("API error 402: insufficient credits");
    (err as Error & { piKind?: ErrorKind }).piKind = "rate_limit";
    mockedStream
      .mockImplementationOnce(async function* () { throw err; } as never)
      .mockImplementationOnce(async function* () {
        yield { type: "chunk", content: "candidate 2 ok" } as never;
        yield { type: "done", usage: { prompt_tokens: 1, completion_tokens: 1 }, cacheRead: 0, cacheWrite: 0 } as never;
      } as never);
    const registry = new ModelHealthRegistry();
    const policy = new FallbackPolicy([
      { model: "primary", endpoint: "https://api.test/v1", maxContext: 8000 },
      { model: "fallback", endpoint: "https://api.test/v1", maxContext: 8000 },
    ], registry);
    const t = new DirectApiTransport({
      endpoint: "https://api.test/v1", model: "primary", maxContext: 8000, maxOutput: 1024, maxTurns: 4,
      apiFormat: "chat", useProviderLib: true,
    }, policy);
    const out = await t.sendPrompt("s", "hi");
    expect(out).toBe("candidate 2 ok");
    // credits sets the bucket to 100 (sticky); rate_limit would only fill to 50.
    expect(registry.getBucketLevel("primary", "https://api.test/v1")).toBe(100);
  });
});
