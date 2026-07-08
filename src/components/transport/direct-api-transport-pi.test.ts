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
import { ModelHealthRegistry } from "./model-health-registry.js";
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
  });

  it("flag on + pi request error → propagates as 'API error <status>' to L2 (no L0 fetch)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["x"]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    mockedStream.mockImplementation(async function* () {
      throw new Error("API error 429: rate limited");
    } as never);
    const t = makeTransport(true);
    // With a single candidate, L2 exhausts and rethrows — surface the mapped status.
    await expect(t.sendPrompt("s", "hi")).rejects.toThrow(/All models exhausted/);
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
});
