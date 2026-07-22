import { describe, it, expect, beforeEach } from "vitest";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
import type { ModelCandidate } from "./model-candidates.js";

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

describe("createPiExecutionSafetyController", () => {
  let registry: ModelHealthRegistry;
  let candidates: ModelCandidate[];
  let policy: FallbackPolicy;

  beforeEach(() => {
    registry = makeRegistry();
    candidates = [makeCandidate()];
    policy = new FallbackPolicy(candidates, registry);
  });

  it("begins provider turn with continue", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    const result = ctrl.beginProviderTurn("test-model@https://api.test/v1");
    expect(result.decision).toBe("continue");
  });

  it("tracks prompt rounds across candidates", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxPromptRounds: 3 });
    expect(ctrl.beginProviderTurn("k1").decision).toBe("continue");
    expect(ctrl.beginProviderTurn("k1").decision).toBe("continue");
    expect(ctrl.beginProviderTurn("k1").decision).toBe("continue");
    const result = ctrl.beginProviderTurn("k2");
    expect(result.decision).toBe("stop");
  });

  it("tracks candidate-specific rounds", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxCandidateRounds: 2 });
    expect(ctrl.beginProviderTurn("k1").decision).toBe("continue");
    expect(ctrl.beginProviderTurn("k1").decision).toBe("continue");
    const result = ctrl.beginProviderTurn("k1");
    expect(result.decision).toBe("stop");
  });

  it("resets candidate rounds on candidate change", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxCandidateRounds: 2 });
    expect(ctrl.beginProviderTurn("k1").decision).toBe("continue");
    expect(ctrl.beginProviderTurn("k1").decision).toBe("continue");
    expect(ctrl.beginProviderTurn("k2").decision).toBe("continue");
  });

  it("detects exact repeat in beforeTool", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.beginProviderTurn("k1");
    expect(ctrl.beforeTool("read_file", { path: "/tmp/a" }).decision).toBe("execute");
    expect(ctrl.beforeTool("read_file", { path: "/tmp/a" }).decision).toBe("execute");
    const result = ctrl.beforeTool("read_file", { path: "/tmp/a" });
    expect(result.decision).toBe("error");
  });

  it("detects repeated failure in afterTool", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("bash", { command: "ls -la" });
    expect(ctrl.afterTool("bash", JSON.stringify({ error: "permission denied" })).decision).toBe("execute");
    ctrl.beforeTool("bash", { command: "pwd" });
    expect(ctrl.afterTool("bash", JSON.stringify({ error: "permission denied" })).decision).toBe("execute");
    ctrl.beforeTool("bash", { command: "whoami" });
    expect(ctrl.afterTool("bash", JSON.stringify({ error: "permission denied" })).decision).toBe("error");
  });

  it("skips remaining tools after batch cancellation", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("read_file", { path: "/tmp/a" });
    ctrl.beforeTool("read_file", { path: "/tmp/a" });
    ctrl.beforeTool("read_file", { path: "/tmp/a" }); // 3rd call triggers repeat
    expect(ctrl.beforeTool("other", {}).decision).toBe("skip");
  });

  it("resets failure count on success", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("bash", { command: "ls -la" });
    ctrl.afterTool("bash", JSON.stringify({ error: "fail" }));
    ctrl.beforeTool("bash", { command: "pwd" });
    ctrl.afterTool("bash", JSON.stringify({ success: true }));
    ctrl.beforeTool("bash", { command: "whoami" });
    expect(ctrl.afterTool("bash", JSON.stringify({ error: "fail" })).decision).toBe("execute");
  });

  it("produces incident on repeat", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("read", { path: "/a" });
    ctrl.beforeTool("read", { path: "/a" });
    ctrl.beforeTool("read", { path: "/a" }); // 3rd call triggers repeat
    expect(ctrl.incident?.type).toBe("exact_repeat");
  });

  it("requestPause makes prepareNextTurn return undefined (no update)", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.requestPause();
    const result = ctrl.prepareNextTurn({ candidateKey: "k1", roundsUsed: 0, maxRounds: 40, incident: null });
    expect(result).toBeUndefined();
  });

  it("requestStop makes beginProviderTurn return stop", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.requestStop("user cancelled");
    const result = ctrl.beginProviderTurn("k1");
    expect(result.decision).toBe("stop");
  });

  it("scrubs classified store literals", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.recordClassifiedStoreLiteral("secret123");
    const scrubbed = ctrl.scrubClassifiedLiterals([
      { role: "user", content: "my password is secret123" },
    ]);
    expect(scrubbed[0]?.content).toBe("my password is [REDACTED]");
  });

  it("does not scrub short literals", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.recordClassifiedStoreLiteral("ab");
    const scrubbed = ctrl.scrubClassifiedLiterals([
      { role: "user", content: "ab is short" },
    ]);
    expect(scrubbed[0]?.content).toBe("ab is short");
  });

  it("scrubs classified literals inside native Pi content blocks", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.recordClassifiedStoreLiteral("secret123");
    const scrubbed = ctrl.scrubClassifiedLiterals([
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "memory_store",
        content: [{ type: "text", text: "stored secret123" }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);
    expect((scrubbed[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe("stored [REDACTED]");
  });
});
