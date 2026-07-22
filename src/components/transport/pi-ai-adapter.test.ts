import { describe, it, expect } from "vitest";
import type {
  Api, ThinkingLevel, Model, AssistantMessage, AssistantMessageEvent,
  ProviderStreams, CreateProviderOptions, Provider,
} from "@earendil-works/pi-ai";

import {
  pickPiApi, buildPiModel, buildPiContext, resolveReasoning,
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


