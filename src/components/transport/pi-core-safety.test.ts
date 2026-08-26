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
    const key = "test-model@https://api.test/v1";
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    const result = ctrl.beginProviderTurn(key);
    expect(result.decision).toBe("stop");
  });

  it("tracks candidate-specific rounds and continues when no alternate exists", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxCandidateRounds: 2 });
    const key = "test-model@https://api.test/v1";
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    // With only one candidate, candidate limit continues instead of stopping (#1502)
    const result = ctrl.beginProviderTurn(key);
    expect(result.decision).toBe("continue");
  });

  it("resets candidate rounds on candidate change", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxCandidateRounds: 2 });
    expect(ctrl.beginProviderTurn("test-model@https://api.test/v1").decision).toBe("continue");
    expect(ctrl.beginProviderTurn("other-model@https://other.test/v1").decision).toBe("continue");
  });

  it("candidate limit continues when no alternate exists and does not record provider health error", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxCandidateRounds: 2 });
    const key = "test-model@https://api.test/v1";
    ctrl.beginProviderTurn(key);
    ctrl.beginProviderTurn(key);
    const result = ctrl.beginProviderTurn(key);
    // Sole candidate: continue instead of stopping (#1502)
    expect(result.decision).toBe("continue");
    // Provider health should NOT be degraded by command failures (#1497)
    expect(registry.getHealth().size).toBe(0);
  });

  it("candidate limit switches when alternate candidate exists", () => {
    const altCandidates = [
      { model: "model-a", provider: "prov-a", endpoint: "https://a.test/v1", maxContext: 128000, apiKey: "key-a", source: "primary" },
      { model: "model-b", provider: "prov-b", endpoint: "https://b.test/v1", maxContext: 128000, apiKey: "key-b", source: "primary" },
    ];
    const altPolicy = new FallbackPolicy(altCandidates, registry);
    const ctrl = createPiExecutionSafetyController(altPolicy, { maxCandidateRounds: 2 });
    ctrl.beginProviderTurn("model-a@https://a.test/v1");
    ctrl.beginProviderTurn("model-a@https://a.test/v1");
    const result = ctrl.beginProviderTurn("model-a@https://a.test/v1");
    expect(result.decision).toBe("stop");
    expect(result.reason).toContain("Candidate round limit");
    expect(altPolicy.rotationExcludedKeys.has("model-a@https://a.test/v1")).toBe(true);
    expect(altPolicy.excludedKeys.has("model-a@https://a.test/v1")).toBe(false);
    expect(registry.getHealth().size).toBe(0);
  });

  it("clears temporary rotation exclusions after a full multi-candidate cycle (#1595)", () => {
    const multi = [
      { model: "model-a", provider: "prov-a", endpoint: "https://a.test/v1", maxContext: 128000, apiKey: "key-a", source: "primary" },
      { model: "model-b", provider: "prov-b", endpoint: "https://b.test/v1", maxContext: 128000, apiKey: "key-b", source: "primary" },
    ];
    const multiPolicy = new FallbackPolicy(multi, registry);
    const ctrl = createPiExecutionSafetyController(multiPolicy, { maxCandidateRounds: 2, maxPromptRounds: 20 });

    ctrl.beginProviderTurn("model-a@https://a.test/v1");
    ctrl.beginProviderTurn("model-a@https://a.test/v1");
    expect(ctrl.beginProviderTurn("model-a@https://a.test/v1").decision).toBe("stop");
    expect(multiPolicy.selectModel()?.model).toBe("model-b");

    ctrl.beginProviderTurn("model-b@https://b.test/v1");
    ctrl.beginProviderTurn("model-b@https://b.test/v1");
    expect(ctrl.beginProviderTurn("model-b@https://b.test/v1").decision).toBe("stop");
    expect(multiPolicy.rotationExcludedKeys.size).toBe(0);
    expect(multiPolicy.excludedKeys.size).toBe(0);
    expect(multiPolicy.selectModel()?.model).toBe("model-a");
  });

  it("sole candidate keeps advancing promptRounds past the candidate limit and stops at the prompt-wide hard limit (#1502)", () => {
    // A single-candidate report that crosses the candidate-round threshold must
    // keep consuming prompt-wide budget so the hard stop remains reachable.
    // Regression: previously promptRounds froze at the candidate limit and the
    // run only ended at the execution deadline (30m), never via prompt_round_limit.
    const ctrl = createPiExecutionSafetyController(policy, { maxCandidateRounds: 2, maxPromptRounds: 4 });
    const key = "test-model@https://api.test/v1";
    // turns 1-2: under the candidate limit
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    // turns 3-4: past the candidate limit, sole candidate continues — but
    // promptRounds must still advance.
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.promptRoundsUsed).toBe(4);
    // turn 5: prompt-wide limit is the final bound
    const result = ctrl.beginProviderTurn(key);
    expect(result.decision).toBe("stop");
    expect(result.reason).toContain("Prompt round limit");
    expect(ctrl.lastTerminalIncident?.type).toBe("prompt_round_limit");
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

  it("lastTerminalIncident is set alongside incident on exact repeat", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("read", { path: "/a" });
    ctrl.beforeTool("read", { path: "/a" });
    ctrl.beforeTool("read", { path: "/a" });
    expect(ctrl.lastTerminalIncident?.type).toBe("exact_repeat");
    expect(ctrl.lastTerminalIncident?.candidateKey).toBe("k1");
    expect(ctrl.lastTerminalIncident?.toolName).toBe("read");
  });

  it("lastTerminalIncident persists after prepareNextTurn clears incident", () => {
    const ctrl = createPiExecutionSafetyController(policy);
    ctrl.beginProviderTurn("k1");
    ctrl.beforeTool("read", { path: "/a" });
    ctrl.beforeTool("read", { path: "/a" });
    ctrl.beforeTool("read", { path: "/a" }); // exact_repeat
    ctrl.prepareNextTurn({ candidateKey: "k1", roundsUsed: 3, maxRounds: 40, incident: ctrl.incident });
    expect(ctrl.incident).toBeNull();
    expect(ctrl.lastTerminalIncident?.type).toBe("exact_repeat");
  });

  it("candidate limit sets lastTerminalIncident with candidate_round_limit type (multi-candidate)", () => {
    const multi = [
      { model: "model-a", provider: "prov-a", endpoint: "https://a.test/v1", maxContext: 128000, apiKey: "key-a", source: "primary" },
      { model: "model-b", provider: "prov-b", endpoint: "https://b.test/v1", maxContext: 128000, apiKey: "key-b", source: "primary" },
    ];
    const multiPolicy = new FallbackPolicy(multi, registry);
    const ctrl = createPiExecutionSafetyController(multiPolicy, { maxCandidateRounds: 1 });
    ctrl.beginProviderTurn("model-a@https://a.test/v1");
    ctrl.beginProviderTurn("model-a@https://a.test/v1");
    expect(ctrl.lastTerminalIncident?.type).toBe("candidate_round_limit");
  });

  it("sole candidate bypasses rotation entirely — no incident, no exclusion churn, no candidate-limit logs (#1595)", () => {
    // A sole-candidate execution must be able to run past the rotation
    // threshold without recording candidate_round_limit incidents, without
    // touching policy exclusions, and still stop at the prompt-wide bound.
    const ctrl = createPiExecutionSafetyController(policy, { maxCandidateRounds: 2, maxPromptRounds: 4 });
    const key = "test-model@https://api.test/v1";
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    // turns 3-4: past the candidate threshold — no rotation machinery fires.
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(key).decision).toBe("continue");
    expect(ctrl.lastTerminalIncident).toBeNull();
    expect(ctrl.incident).toBeNull();
    expect(policy.excludedKeys.size).toBe(0);
    expect(ctrl.promptRoundsUsed).toBe(4);
    // turn 5: prompt-wide limit is the only bound.
    const result = ctrl.beginProviderTurn(key);
    expect(result.decision).toBe("stop");
    expect(result.reason).toContain("Prompt round limit");
    expect(ctrl.lastTerminalIncident?.type).toBe("prompt_round_limit");
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

describe("#1728 one-free-corrective accounting", () => {
  const KEY = "test-model@https://api.test/v1";
  const MODEL_API = {} as never;
  let policy: FallbackPolicy;

  beforeEach(() => {
    policy = new FallbackPolicy([makeCandidate()], makeRegistry());
  });

  function triggerExactRepeat(ctrl: ReturnType<typeof createPiExecutionSafetyController>, tool = "bash", args = '{"cmd":"same"}'): void {
    for (let i = 0; i < 3; i++) ctrl.beforeTool(tool, args);
  }

  function prepare(ctrl: ReturnType<typeof createPiExecutionSafetyController>, opts?: { modelForCandidate?: () => unknown }) {
    return ctrl.prepareNextTurn({
      candidateKey: KEY,
      context: undefined,
      modelForCandidate: (opts?.modelForCandidate ?? (() => MODEL_API)) as never,
    } as never);
  }

  it("at the charged bound the first behavior incident admits exactly one uncharged corrective request", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxPromptRounds: 1 });
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("continue");
    expect(ctrl.promptRoundsUsed).toBe(1);

    triggerExactRepeat(ctrl);
    const update = prepare(ctrl);
    expect(update).toBeDefined();
    expect(ctrl.correctiveAdmitted).toBe(true);

    // The armed corrective request passes the bound without charging.
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("continue");
    expect(ctrl.promptRoundsUsed).toBe(1);

    // The next ordinary request is refused at the charged bound.
    const refused = ctrl.beginProviderTurn(KEY);
    expect(refused.decision).toBe("stop");
    expect((refused as { reason?: string }).reason).toContain("Prompt round limit (1)");
  });

  it("a second behavior incident receives no second free request", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxPromptRounds: 4 });
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("continue");
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("continue");

    triggerExactRepeat(ctrl, "bash", '{"n":1}');
    expect(prepare(ctrl)).toBeDefined();
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("continue"); // free
    expect(ctrl.promptRoundsUsed).toBe(2);

    // Charged round three, then a distinct second incident below the bound.
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("continue");
    expect(ctrl.promptRoundsUsed).toBe(3);
    triggerExactRepeat(ctrl, "grep", '{"other":"fingerprint"}');
    expect(ctrl.prepareNextTurn({
      candidateKey: KEY,
      context: undefined,
      modelForCandidate: (() => MODEL_API) as never,
    } as never)).toBeUndefined();
  });

  it("stop and pause defeat an armed corrective request", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxPromptRounds: 1 });
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("continue");
    triggerExactRepeat(ctrl);
    expect(prepare(ctrl)).toBeDefined();

    ctrl.requestStop("external stop");
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("stop");

    const paused = createPiExecutionSafetyController(policy, { maxPromptRounds: 1 });
    expect(paused.beginProviderTurn(KEY).decision).toBe("continue");
    triggerExactRepeat(paused);
    expect(prepare(paused)).toBeDefined();
    paused.requestPause();
    expect(paused.beginProviderTurn(KEY).decision).toBe("pause");
  });

  it("a failed model resolution does not arm the free corrective request", () => {
    const ctrl = createPiExecutionSafetyController(policy, { maxPromptRounds: 1 });
    expect(ctrl.beginProviderTurn(KEY).decision).toBe("continue");
    triggerExactRepeat(ctrl);

    expect(prepare(ctrl, { modelForCandidate: () => undefined })).toBeUndefined();
    expect(ctrl.correctiveAdmitted).toBe(false);

    // Nothing armed: the bound refusal is a normal prompt_round_limit stop.
    const refused = ctrl.beginProviderTurn(KEY);
    expect(refused.decision).toBe("stop");
    expect((refused as { reason?: string }).reason).toContain("Prompt round limit (1)");
  });

  it("an alternate-candidate correction preserves candidate identity and per-candidate accounting", () => {
    const altRegistry = makeRegistry();
    const altPolicy = new FallbackPolicy([
      makeCandidate({ model: "model-a", provider: "prov-a", endpoint: "https://a.test/v1", apiKey: "key-a" }),
      makeCandidate({ model: "model-b", provider: "prov-b", endpoint: "https://b.test/v1", apiKey: "key-b" }),
    ], altRegistry);
    const ctrl = createPiExecutionSafetyController(altPolicy, { maxPromptRounds: 5 });
    const keyA = "model-a@https://a.test/v1";
    const keyB = "model-b@https://b.test/v1";

    expect(ctrl.beginProviderTurn(keyA).decision).toBe("continue");
    expect(ctrl.promptRoundsUsed).toBe(1);
    triggerExactRepeat(ctrl);

    const update = ctrl.prepareNextTurn({
      candidateKey: keyA,
      context: undefined,
      modelForCandidate: ((key: string) => (key.startsWith("model-") ? MODEL_API : undefined)) as never,
    } as never);
    expect(update).toBeDefined();

    // The corrective turn on the replacement candidate is uncharged but still
    // runs full candidate accounting: identity switch resets candidate rounds.
    expect(ctrl.beginProviderTurn(keyB).decision).toBe("continue");
    expect(ctrl.promptRoundsUsed).toBe(1);
    expect(ctrl.activeCandidateKey).toBe(keyB);
  });
});
