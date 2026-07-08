import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FallbackPolicy } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
import { normalizeToolCalls } from "./transport-utils.js";
import { DirectApiTransport } from "./direct-api-transport.js";

// Test the policy-driven fallback logic through the policy itself,
// since DirectApiTransport.sendWithPolicy is tightly coupled to HTTP streaming.
// The policy is the unit under test; transport integration is verified manually.

describe("FallbackPolicy — fallback sequence", () => {
  let registry: ModelHealthRegistry;

  beforeEach(() => { registry = new ModelHealthRegistry(); });

  it("simulates full fallback: primary fails, secondary succeeds", () => {
    const policy = new FallbackPolicy([
      { model: "kimi", endpoint: "ep1", maxContext: 128000 },
      { model: "nemotron", endpoint: "ep1", maxContext: 128000 },
    ], registry);

    // First select: kimi
    const first = policy.selectModel();
    expect(first?.model).toBe("kimi");

    // kimi fails
    policy.recordError(first!, "rate_limit", 5000);

    // Second select: skips kimi (bucketed), picks nemotron
    const second = policy.selectModel();
    expect(second?.model).toBe("nemotron");
    expect(policy.lastDecision?.skipped.length).toBe(1);

    // nemotron succeeds
    policy.recordSuccess(second!);
    expect(registry.getBucketLevel("nemotron", "ep1")).toBe(0);
  });

  it("simulates all-exhausted: both candidates fail", () => {
    const policy = new FallbackPolicy([
      { model: "kimi", endpoint: "ep1", maxContext: 128000 },
      { model: "nemotron", endpoint: "ep1", maxContext: 128000 },
    ], registry);

    // Both fail with auth
    policy.recordError({ model: "kimi", endpoint: "ep1", maxContext: 128000 }, "auth");
    policy.recordError({ model: "nemotron", endpoint: "ep1", maxContext: 128000 }, "auth");

    expect(policy.selectModel()).toBeNull();
    expect(policy.survivingCandidates()).toEqual([]);
  });

  it("shared registry: error on kimi affects all policies", () => {
    const policy1 = new FallbackPolicy([
      { model: "kimi", endpoint: "ep1", maxContext: 128000 },
    ], registry);
    const policy2 = new FallbackPolicy([
      { model: "kimi", endpoint: "ep1", maxContext: 128000 },
      { model: "backup", endpoint: "ep2", maxContext: 64000 },
    ], registry);

    // policy1 records auth error on kimi
    policy1.recordError({ model: "kimi", endpoint: "ep1", maxContext: 128000 }, "auth");

    // policy2 sees kimi as exhausted, falls back to backup
    const selected = policy2.selectModel();
    expect(selected?.model).toBe("backup");
  });
});

describe("DirectApiTransport.switchProvider", () => {
  it("updates endpoint+model+policy", async () => {
    const reg = new ModelHealthRegistry();
    const oldPolicy = new FallbackPolicy([{ model: "old", endpoint: "ep1", maxContext: 128000 }], reg);
    const { DirectApiTransport } = await import("./direct-api-transport.js");
    const transport = new DirectApiTransport({ endpoint: "ep1", model: "old", maxContext: 128000, maxOutput: 4096, maxTurns: 1 }, oldPolicy);

    const newPolicy = new FallbackPolicy([{ model: "new", endpoint: "ep2", maxContext: 200000 }], reg);
    transport.switchProvider({ endpoint: "ep2", apiKey: "k2", model: "new", maxContext: 200000, policy: newPolicy });

    expect(transport.currentModel).toBe("new");
  });
});

describe("normalizeToolCalls — model fragmentation handling", () => {
  function tc(name: string, args: string, id = "call_0"): { id: string; type: "function"; function: { name: string; arguments: string } } {
    return { id, type: "function", function: { name, arguments: args } };
  }

  it("passes well-formed calls through unchanged", () => {
    const input = [tc("execute_bash", '{"command":"ls"}', "c1"), tc("memory_recall", '{"query":"test"}', "c2")];
    const result = normalizeToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.function.name).toBe("execute_bash");
    expect(result[1]!.function.name).toBe("memory_recall");
  });

  it("single call passes through", () => {
    const input = [tc("execute_bash", '{"command":"ls"}')];
    expect(normalizeToolCalls(input)).toEqual(input);
  });

  it("merges adjacent unnamed entry args into preceding named entry", () => {
    const input = [
      tc("execute_bash", "{}", "c1"),
      tc("", "", "c2"),
      tc("", '{"command":"gws-cli gmail list"}', "c3"),
    ];
    const result = normalizeToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.function.name).toBe("execute_bash");
    expect(result[0]!.function.arguments).toBe('{"command":"gws-cli gmail list"}');
  });

  it("handles multiple named calls with fragments between them", () => {
    const input = [
      tc("execute_bash", "{}", "c1"),
      tc("", '{"command":"ls"}', "c2"),
      tc("memory_store", '{"translated":"fact"}', "c3"),
    ];
    const result = normalizeToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.function.name).toBe("execute_bash");
    expect(result[0]!.function.arguments).toBe('{"command":"ls"}');
    expect(result[1]!.function.name).toBe("memory_store");
    expect(result[1]!.function.arguments).toBe('{"translated":"fact"}');
  });

  it("drops completely unnamed entries with no args", () => {
    const input = [
      tc("execute_bash", '{"command":"pwd"}', "c1"),
      tc("", "", "c2"),
      tc("", "{}", "c3"),
    ];
    const result = normalizeToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.function.name).toBe("execute_bash");
  });

  it("does not merge when named entry already has args", () => {
    const input = [
      tc("execute_bash", '{"command":"ls"}', "c1"),
      tc("", '{"command":"pwd"}', "c2"),
    ];
    const result = normalizeToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.function.arguments).toBe('{"command":"ls"}');
  });
});

describe("DirectApiTransport — construction and model switching", () => {
  it("exposes currentModel from config", () => {
    const reg = new ModelHealthRegistry();
    const policy = new FallbackPolicy([{ model: "gpt-4", endpoint: "http://localhost", maxContext: 128000 }], reg);
    const transport = new DirectApiTransport({
      endpoint: "http://localhost/v1",
      apiKey: "test",
      model: "gpt-4",
      maxContext: 128000,
      maxOutput: 4096,
      maxTurns: 50,
    }, policy);
    expect(transport.currentModel).toBe("gpt-4");
  });

  it("switchProvider updates model and endpoint", () => {
    const reg = new ModelHealthRegistry();
    const policy = new FallbackPolicy([{ model: "gpt-4", endpoint: "http://localhost", maxContext: 128000 }], reg);
    const transport = new DirectApiTransport({
      endpoint: "http://localhost/v1",
      apiKey: "test",
      model: "gpt-4",
      maxContext: 128000,
      maxOutput: 4096,
      maxTurns: 50,
    }, policy);

    const newPolicy = new FallbackPolicy([{ model: "claude-3", endpoint: "http://other", maxContext: 200000 }], reg);
    transport.switchProvider({ endpoint: "http://other/v1", apiKey: "k2", model: "claude-3", maxContext: 200000, policy: newPolicy });
    expect(transport.currentModel).toBe("claude-3");
  });

  it("contextPercent starts at -1 (unknown)", () => {
    const reg = new ModelHealthRegistry();
    const policy = new FallbackPolicy([{ model: "gpt-4", endpoint: "http://localhost", maxContext: 128000 }], reg);
    const transport = new DirectApiTransport({
      endpoint: "http://localhost/v1",
      apiKey: "test",
      model: "gpt-4",
      maxContext: 128000,
      maxOutput: 4096,
      maxTurns: 50,
    }, policy);
    expect(transport.contextPercent).toBe(-1);
  });

  it("toolCallsSucceeded starts at 0", () => {
    const reg = new ModelHealthRegistry();
    const policy = new FallbackPolicy([{ model: "gpt-4", endpoint: "http://localhost", maxContext: 128000 }], reg);
    const transport = new DirectApiTransport({
      endpoint: "http://localhost/v1",
      apiKey: "test",
      model: "gpt-4",
      maxContext: 128000,
      maxOutput: 4096,
      maxTurns: 50,
    }, policy);
    expect(transport.toolCallsSucceeded).toBe(0);
  });
});

// #1295: contextPercent must reflect the ACTIVE model's window, not the primary's window.
describe("DirectApiTransport.contextPercent — active window (#1295)", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  afterEach(() => { fetchSpy.mockReset(); });

  function makeStreamResponse(promptTokens: number): Response {
    const line = `data: ${JSON.stringify({
      choices: [{ delta: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 5 },
    })}\n\ndata: [DONE]\n\n`;
    return new Response(line, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }) as unknown as Response;
  }

  it("uses primary model window when primary serves", async () => {
    const reg = new ModelHealthRegistry();
    const PRIMARY_CTX = 100_000;
    const policy = new FallbackPolicy([
      { model: "primary", endpoint: "http://ep1/v1", maxContext: PRIMARY_CTX },
    ], reg);
    const transport = new DirectApiTransport({
      endpoint: "http://ep1/v1", apiKey: "k", model: "primary",
      maxContext: PRIMARY_CTX, maxOutput: 1000, maxTurns: 5,
    }, policy);

    // 10_000 prompt tokens on a 100_000 window = 10%
    fetchSpy.mockResolvedValue(makeStreamResponse(10_000));
    await transport.sendPrompt("s1", "hi");
    expect(transport.contextPercent).toBe(10);
  });

  it("uses FALLBACK model window when fallback serves (#1295 fix)", async () => {
    const reg = new ModelHealthRegistry();
    const PRIMARY_CTX = 1_000_000; // huge primary window
    const FALLBACK_CTX = 100_000; // smaller fallback window
    const policy = new FallbackPolicy([
      { model: "primary", endpoint: "http://ep1/v1", maxContext: PRIMARY_CTX },
      { model: "fallback", endpoint: "http://ep1/v1", maxContext: FALLBACK_CTX },
    ], reg);
    const transport = new DirectApiTransport({
      endpoint: "http://ep1/v1", apiKey: "k", model: "primary",
      maxContext: PRIMARY_CTX, maxOutput: 1000, maxTurns: 5,
    }, policy);

    // Primary fails with credits — sticky skip
    reg.recordError("primary", "http://ep1/v1", "credits");

    // 10_000 tokens on 100_000 fallback window = 10%, NOT 1% (10_000/1_000_000)
    fetchSpy.mockResolvedValue(makeStreamResponse(10_000));
    await transport.sendPrompt("s1", "hi");
    expect(transport.contextPercent).toBe(10);
  });
});
