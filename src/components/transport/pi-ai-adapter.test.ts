import { describe, it, expect, vi, beforeAll } from "vitest";
import type {
  Api, ThinkingLevel, Model, AssistantMessage, AssistantMessageEvent,
  ProviderStreams, CreateProviderOptions, Provider,
} from "@earendil-works/pi-ai";
// #1746: pi's authoritative clamp, captured into the runtime slot under test.
// Test files are exempt from the production import boundary.
import { clampThinkingLevel } from "@earendil-works/pi-ai";

import {
  pickPiApi, buildPiModel, buildPiContext, resolveReasoning, resolveCandidateModel,
  ensurePiThinkingClamp, deriveCacheIdentity,
  type PiAiCandidate, type PiAiConversation,
} from "./pi-ai-adapter.js";

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



// ── deriveCacheIdentity (#1748) ─────────────────────────────────────────────

/*
 * TEST DEFICIENCY (2026-08-30):
 * Missing: a deterministic test proving that `sessionId` improves the
 * provider-side cache-read ratio on a real provider path.
 * Reason deferred: the measured provider path (deepseek/deepseek-v4-flash via
 * openrouter) shows a NULL delta within provider noise — see
 * abproject/specs/1748/measurements.md. Wire-verified, pi-ai 0.84.3 gates
 * `prompt_cache_key` on `baseUrl.includes("api.openai.com")` OR
 * `cacheRetention === "long"` (openai-completions.js), so the plumbed
 * "short" default is a deliberate wire-level no-op on this path, and "long"
 * (which does send prompt_cache_key) produced no benefit on DeepSeek's
 * automatic cache. A unit test here could only assert plumbing, which the
 * transport tests already do.
 * Future verification: the smallest credible path where the effect is
 * observable is an api.openai.com-compatible endpoint (prompt_cache_key gated
 * on retention alone) or an anthropic-messages provider (cacheSessionId feeds
 * cache-control placement). Measure cacheRead before/after there, attributed
 * via `cacheIdentityHash` in cache-telemetry.
 */

describe("deriveCacheIdentity", () => {
  it("is byte-identical for an identical scope across repeated calls", () => {
    const scope = "session_alpha";
    expect(deriveCacheIdentity(scope)).toBe(deriveCacheIdentity(scope));
  });

  it("differs between two scopes, and still differs after clamping to 64 chars", () => {
    const a = deriveCacheIdentity("session_alpha");
    const b = deriveCacheIdentity("session_beta");
    expect(a).not.toBe(b);
    expect(a.slice(0, 64)).not.toBe(b.slice(0, 64));
  });

  it("contains no substring of a user id, chat id, or platform name built into the scope", () => {
    const scope = "telegram:7773842843:user_alpha";
    const id = deriveCacheIdentity(scope);
    for (const needle of ["telegram", "7773842843", "user_alpha", "alpha"]) {
      expect(id).not.toContain(needle);
    }
  });

  it("output length is <= 64 (OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH)", () => {
    expect(deriveCacheIdentity("x".repeat(5000)).length).toBeLessThanOrEqual(64);
  });
});

// ── resolveCandidateModel (#1619) ──────────────────────────────────────────

describe("resolveCandidateModel", () => {
  const candidate = {
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
  };

  // #1746: resolveCandidateModel reads the clamp from the runtime slot now,
  // not from a static import. In production the boot warm populates it with
  // pi's real function; these tests do the same so the #1619 clamping
  // behaviour is exercised as shipped.
  beforeAll(async () => {
    await ensurePiThinkingClamp({ clampThinkingLevel });
  });

  it("threads the requested effort into the model and reports it", () => {
    const resolved = resolveCandidateModel(candidate, "high", false);
    expect(resolved.requested).toBe("high");
    expect(resolved.effective).toBe("high");
    expect(resolved.model.reasoning).toBe(true);
    expect(resolved.model.id).toBe("test-model");
  });

  it("clamps xhigh against a custom model without thinkingLevelMap.xhigh", () => {
    const resolved = resolveCandidateModel(candidate, "xhigh", false);
    expect(resolved.requested).toBe("xhigh");
    expect(resolved.effective).toBe("high");
    expect(resolved.model.reasoning).toBe(true);
  });

  it("off forces model.reasoning false so no reasoning param is emitted", () => {
    const resolved = resolveCandidateModel(candidate, "off", false);
    expect(resolved.effective).toBe("off");
    expect(resolved.model.reasoning).toBe(false);
  });

  it("an image turn marks the model input text+image", () => {
    const resolved = resolveCandidateModel(candidate, "high", true);
    expect(resolved.model.input).toEqual(["text", "image"]);
  });

  it("carries the candidate context window", () => {
    const resolved = resolveCandidateModel(candidate, "high", false);
    expect(resolved.model.contextWindow).toBe(128000);
  });
});

// ── #1746 runtime clamp slot ────────────────────────────────────────────────

describe("resolveCandidateModel — #1746 runtime clamp slot", () => {
  const candidate = {
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
  };

  it("passes the requested effort through when the slot is unpopulated (no throw)", async () => {
    vi.resetModules();
    const mod = await import("./pi-ai-adapter.js");
    const resolved = mod.resolveCandidateModel(candidate, "xhigh", false);
    expect(resolved.effective).toBe("xhigh");
    expect(resolved.model.reasoning).toBe(true);
  });

  it('"off" still forces model.reasoning false when the slot is unpopulated', async () => {
    vi.resetModules();
    const mod = await import("./pi-ai-adapter.js");
    const resolved = mod.resolveCandidateModel(candidate, "off", false);
    expect(resolved.effective).toBe("off");
    expect(resolved.model.reasoning).toBe(false);
  });

  it("clamp equivalence — slot-populated resolution matches pi's real clamp", async () => {
    vi.resetModules();
    const mod = await import("./pi-ai-adapter.js");
    await mod.ensurePiThinkingClamp({ clampThinkingLevel });
    for (const level of ["low", "medium", "high", "xhigh"] as const) {
      const resolved = mod.resolveCandidateModel(candidate, level, false);
      const equivalentModel = buildPiModel(
        { model: candidate.model, endpoint: candidate.endpoint, maxOutput: 4096, contextWindow: candidate.maxContext, reasoningEffort: level },
        "openai-completions", false, candidate.provider,
      );
      const direct = clampThinkingLevel(equivalentModel, level);
      const expected = direct === "minimal" || direct === "max" ? "high" : direct;
      expect(resolved.effective).toBe(expected);
    }
  });

  it("clamp equivalence — with and without a non-null thinkingLevelMap.xhigh, the effective matches the pre-#1746 static import", async () => {
    // buildPiModel never emits a thinkingLevelMap today (pi catalog adoption is
    // a later task), so every resolveCandidateModel model is the "without"
    // shape and the pre-change static call produced the same value the slot
    // now produces for it. The "with" shape is pinned at the pi-function level:
    // the slot holds pi's real function, which keeps xhigh for a model that
    // claims the level.
    vi.resetModules();
    const mod = await import("./pi-ai-adapter.js");
    await mod.ensurePiThinkingClamp({ clampThinkingLevel });
    const resolved = mod.resolveCandidateModel(candidate, "xhigh", false);
    expect(resolved.effective).toBe("high");
    const withXhighMap: Model<Api> = {
      ...buildPiModel(
        { model: candidate.model, endpoint: candidate.endpoint, maxOutput: 4096, contextWindow: candidate.maxContext, reasoningEffort: "xhigh" },
        "openai-completions", false, candidate.provider,
      ),
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh" },
    };
    expect(clampThinkingLevel(withXhighMap, "xhigh")).toBe("xhigh");
  });
});
