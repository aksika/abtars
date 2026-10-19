/**
 * pi-stream-fn-pi-managed.test.ts — dispatch branch for Pi-managed
 * candidates (#1757).
 *
 * Proves Pi-managed candidates route through the Pi runtime (never the
 * abtars-keyed adapter path) and that Pi credential-absence failures are
 * observed in the availability memo as provider-wide auth evidence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Model, Api, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiStreamFn } from "./pi-stream-fn.js";
import type { ModelCandidate } from "./model-candidates.js";
import { loadAvailabilityMemo } from "../pi-session/provider-availability-memo.js";
import { streamPiManaged } from "./pi-runtime.js";
import { createPiAiAssistantStream } from "./pi-ai-adapter.js";

vi.mock("./pi-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-runtime.js")>();
  return { ...actual, streamPiManaged: vi.fn() };
});

vi.mock("./pi-ai-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-ai-adapter.js")>();
  return { ...actual, createPiAiAssistantStream: vi.fn() };
});

function doneEvent(): AssistantMessageEvent {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "piman",
      model: "m",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
}

function authErrorEvent(): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "piman",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: "No API key for provider: opencode-go",
      timestamp: Date.now(),
    },
  };
}

function fakeStream(events: AssistantMessageEvent[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    result: async () => { throw new Error("unused"); },
  };
}

function makeCandidate(): ModelCandidate {
  return {
    model: "m",
    provider: "piman",
    endpoint: "https://pi.test/v1",
    maxContext: 128000,
    authSource: "pi",
    source: "primary",
  };
}

function makeModel(): Model<Api> {
  return {
    id: "m",
    name: "m",
    api: "openai-completions" as Api,
    provider: "piman",
    baseUrl: "https://pi.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 128,
  };
}

async function consume(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("pi-stream-fn → Pi-managed dispatch (#1757)", () => {
  beforeEach(() => {
    vi.mocked(streamPiManaged).mockReset();
    vi.mocked(createPiAiAssistantStream).mockReset();
  });

  it("routes Pi-managed candidates through the Pi runtime, never the keyed adapter", async () => {
    vi.mocked(streamPiManaged).mockResolvedValue(fakeStream([doneEvent()]) as never);
    const streamFn = createPiStreamFn({ candidate: makeCandidate(), executionId: "pi-1" });
    const events = await consume(await streamFn(makeModel(), normalizeContext({ messages: [] }), {}));
    expect(events.at(-1)?.type).toBe("done");
    expect(vi.mocked(streamPiManaged)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPiAiAssistantStream)).not.toHaveBeenCalled();
    const [provider, modelId, , options] = vi.mocked(streamPiManaged).mock.calls[0] as unknown as [
      string, string, unknown, Record<string, unknown>, unknown?,
    ];
    expect(provider).toBe("piman");
    expect(modelId).toBe("m");
    expect(options).not.toHaveProperty("apiKey");
  });

  it("observes Pi credential-absence as provider-wide auth evidence", async () => {
    vi.mocked(streamPiManaged).mockResolvedValue(fakeStream([authErrorEvent()]) as never);
    const stateDir = mkdtempSync(join(tmpdir(), "pi-managed-memo-"));
    const streamFn = createPiStreamFn({ candidate: makeCandidate(), executionId: "pi-2", memoStateDir: stateDir });
    const events = await consume(await streamFn(makeModel(), normalizeContext({ messages: [] }), {}));
    expect(events.at(-1)?.type).toBe("error");
    expect(vi.mocked(createPiAiAssistantStream)).not.toHaveBeenCalled();
    const entries = loadAvailabilityMemo(stateDir).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ provider: "piman", reason: "auth" });
    // Auth evidence is provider-wide, never model-scoped.
    expect(entries[0]).not.toHaveProperty("modelScope");
    expect(entries[0]).not.toHaveProperty("endpoint");
  });

  it("keyed candidates still use the adapter path", async () => {
    vi.mocked(createPiAiAssistantStream).mockResolvedValue({
      stream: fakeStream([doneEvent()]),
      pi: { createProvider: vi.fn(), isContextOverflow: () => false },
    } as never);
    const keyed: ModelCandidate = { ...makeCandidate(), authSource: undefined, apiKey: "k" };
    const streamFn = createPiStreamFn({ candidate: keyed, executionId: "pi-3" });
    const events = await consume(await streamFn(makeModel(), normalizeContext({ messages: [] }), {}));
    expect(events.at(-1)?.type).toBe("done");
    expect(vi.mocked(streamPiManaged)).not.toHaveBeenCalled();
    expect(vi.mocked(createPiAiAssistantStream)).toHaveBeenCalledTimes(1);
  });
});
