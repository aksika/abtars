import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPiStreamFn } from "./pi-stream-fn.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
import type { ModelCandidate } from "./model-candidates.js";
import type { SimpleStreamOptions } from "./pi-core-types.js";

vi.mock("./pi-ai-adapter.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual!,
    createPiAiAssistantStream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "", stopReason: "stop", usage: { input: 0, output: 0 } } };
      },
    }),
  };
});

function makeRegistry() {
  return new ModelHealthRegistry();
}

function makeCandidate(overrides?: Partial<ModelCandidate>): ModelCandidate {
  return {
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
    ...overrides,
  };
}

const { createPiAiAssistantStream } = await import("./pi-ai-adapter.js");

describe("pi-stream-fn → createPiAiAssistantStream boundary", () => {
  let registry: ModelHealthRegistry;
  let candidates: ModelCandidate[];
  let policy: FallbackPolicy;

  beforeEach(() => {
    registry = makeRegistry();
    candidates = [makeCandidate()];
    policy = new FallbackPolicy(candidates, registry);
    vi.mocked(createPiAiAssistantStream).mockClear();
  });

  it("passes generated x-client-request-id header to createPiAiAssistantStream for OpenAI-compatible", async () => {
    const streamFn = createPiStreamFn({
      policy, executionId: "exec_1",
      providerRequestIdFactory: () => "boundary-test-id",
    });
    for await (const _ev of streamFn({ id: "test", api: "openai-completions" }, { messages: [] }, {})) { /* consume */ }

    expect(vi.mocked(createPiAiAssistantStream)).toHaveBeenCalledTimes(1);
    const options = vi.mocked(createPiAiAssistantStream).mock.calls[0]?.[3] as SimpleStreamOptions;
    expect(options?.headers?.["x-client-request-id"]).toBe("boundary-test-id");
  });

  it("omits x-client-request-id header for anthropic-messages API", async () => {
    const anthropicCandidate = makeCandidate({ apiFormat: "anthropic" });
    const anthropicPolicy = new FallbackPolicy([anthropicCandidate], registry);
    const streamFn = createPiStreamFn({
      policy: anthropicPolicy, executionId: "exec_2",
      providerRequestIdFactory: () => "no-anthropic-id",
    });
    for await (const _ev of streamFn({ id: "claude", api: "anthropic-messages" }, { messages: [] }, {})) { /* consume */ }

    expect(vi.mocked(createPiAiAssistantStream)).toHaveBeenCalledTimes(1);
    const options = vi.mocked(createPiAiAssistantStream).mock.calls[0]?.[3] as SimpleStreamOptions | undefined;
    expect(options?.headers?.["x-client-request-id"]).toBeUndefined();
  });
});
