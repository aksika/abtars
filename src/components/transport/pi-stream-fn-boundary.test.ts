import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Model, Api } from "@earendil-works/pi-ai";
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
      stream: {
        [Symbol.asyncIterator]: async function* () {
          yield { type: "done", reason: "stop", message: { role: "assistant", content: "", stopReason: "stop", usage: { input: 0, output: 0 } } };
        },
      },
      pi: {
        createProvider: vi.fn(),
        isContextOverflow: () => false,
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

// Full Model<Api> literal (same pattern as pi-stream-fn.test.ts makeModel).
function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "test",
    name: "test",
    api: "openai-completions" as Api,
    provider: "test-provider",
    baseUrl: "https://api.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 128,
    ...overrides,
  };
}

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
    // Awaited: StreamFn allows async implementations; abtars' is sync and
    // await is identity there. Keeps the boundary honest about both shapes.
    const stream = await streamFn(makeModel(), { messages: [] }, {});
    for await (const _ev of stream) { /* consume */ }

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
    const stream2 = await streamFn(makeModel({ id: "claude", api: "anthropic-messages" }), { messages: [] }, {});
    for await (const _ev of stream2) { /* consume */ }

    expect(vi.mocked(createPiAiAssistantStream)).toHaveBeenCalledTimes(1);
    const options = vi.mocked(createPiAiAssistantStream).mock.calls[0]?.[3] as SimpleStreamOptions | undefined;
    expect(options?.headers?.["x-client-request-id"]).toBeUndefined();
  });
});
