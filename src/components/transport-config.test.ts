import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAgent, getEnvFallback, clearTransportCache, validateAndRepair } from "./transport-config.js";
import type { TransportConfig, ModelCatalog } from "./transport-config.js";

const MODELS: ModelCatalog = {
  "claude-sonnet-4.6": { contextWindow: 1000000, maxOutput: 16384, rank: 2, cost: { input: 3.0, output: 15.0 }, transports: ["kiro-free"] },
  "minimax-m2.5:cloud": { contextWindow: 128000, maxOutput: 8192, rank: 3, cost: { input: 0.0, output: 0.0 }, transports: ["ollama"] },
};

const TRANSPORT: TransportConfig = {
  agents: {
    professor: { model: "claude-sonnet-4.6", provider: "kiro-free", fallbacks: [{ model: "minimax-m2.5:cloud", provider: "ollama" }] },
    dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" },
  },
  providers: {
    "kiro-free": { transport: "acp", cli: "kiro-cli" },
    ollama: { transport: "api", endpoint: "http://localhost:11434/v1" },
  },
  maxTurns: 50,
};

beforeEach(() => clearTransportCache());

describe("resolveAgent", () => {
  it("resolves professor with model details from models.json", () => {
    const r = resolveAgent("professor", TRANSPORT, MODELS)!;
    expect(r.model).toBe("claude-sonnet-4.6");
    expect(r.providerName).toBe("kiro-free");
    expect(r.provider.transport).toBe("acp");
    expect(r.contextWindow).toBe(1000000);
    expect(r.maxOutput).toBe(16384);
    expect(r.fallbacks).toHaveLength(1);
  });

  it("resolves dreamy on different provider", () => {
    const r = resolveAgent("dreamy", TRANSPORT, MODELS)!;
    expect(r.model).toBe("minimax-m2.5:cloud");
    expect(r.provider.transport).toBe("api");
    expect(r.provider.endpoint).toBe("http://localhost:11434/v1");
    expect(r.contextWindow).toBe(128000);
  });

  it("cron inherits professor", () => {
    const r = resolveAgent("cron", TRANSPORT, MODELS)!;
    expect(r.model).toBe("claude-sonnet-4.6");
    expect(r.providerName).toBe("kiro-free");
  });

  it("returns null for unknown role", () => {
    expect(resolveAgent("unknown", TRANSPORT, MODELS)).toBeNull();
  });

  it("returns null for missing provider", () => {
    const tc = { ...TRANSPORT, agents: { professor: { model: "x", provider: "nonexistent" } }, providers: {} };
    expect(resolveAgent("professor", tc, MODELS)).toBeNull();
  });

  it("uses defaults when model not in catalog", () => {
    const r = resolveAgent("professor", TRANSPORT, {})!;
    expect(r.contextWindow).toBe(128000);
    expect(r.maxOutput).toBe(8192);
  });
});

describe("getEnvFallback", () => {
  it("returns openrouter defaults", () => {
    const fb = getEnvFallback();
    expect(fb.providerName).toBe("openrouter");
    expect(fb.provider.transport).toBe("api");
    expect(fb.model).toBe("minimax-m2.5:cloud");
  });
});

describe("validateAndRepair", () => {
  const providers = {
    ollama: { transport: "api" as const, endpoint: "http://localhost:11434/v1" },
    openrouter: { transport: "api" as const, endpoint: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
    kiro: { transport: "acp" as const, cli: "kiro-cli" },
    gemini: { transport: "acp" as const, cli: "gemini-cli" },
  };

  it("accepts all-api mixed providers", () => {
    const tc = {
      agents: {
        professor: { model: "m1", provider: "ollama" },
        dreamy: { model: "m2", provider: "openrouter" },
      },
      providers,
    };
    expect(validateAndRepair(tc)).toEqual([]);
  });

  it("accepts acp agents matching professor's provider", () => {
    const tc = {
      agents: {
        professor: { model: "m1", provider: "kiro" },
        dreamy: { model: "m2", provider: "kiro" },
      },
      providers,
    };
    expect(validateAndRepair(tc)).toEqual([]);
  });

  it("repairs cross-transport violation (subagent api, professor acp)", () => {
    const tc = {
      agents: {
        professor: { model: "m1", provider: "kiro" },
        dreamy: { model: "m2", provider: "ollama" },
      },
      providers,
    };
    const repairs = validateAndRepair(tc);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.agent).toBe("dreamy");
    expect(tc.agents["dreamy"]!.provider).toBe("kiro");
    expect(tc.agents["dreamy"]!.model).toBe("m1");
  });

  it("repairs acp provider mismatch (single child process)", () => {
    const tc = {
      agents: {
        professor: { model: "m1", provider: "kiro" },
        dreamy: { model: "m2", provider: "gemini" },
      },
      providers,
    };
    const repairs = validateAndRepair(tc);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.agent).toBe("dreamy");
    expect(tc.agents["dreamy"]!.provider).toBe("kiro");
  });

  it("removes fallbacks with incompatible transport", () => {
    const tc = {
      agents: {
        professor: { model: "m1", provider: "kiro", fallbacks: [
          { model: "m2", provider: "ollama" },
          { model: "m3", provider: "kiro" },
        ] },
      },
      providers,
    };
    const repairs = validateAndRepair(tc);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.agent).toBe("professor_fb1");
    expect(tc.agents["professor"]!.fallbacks).toHaveLength(1);
    expect(tc.agents["professor"]!.fallbacks![0]!.model).toBe("m3");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #367 — Provider readiness validation
// ────────────────────────────────────────────────────────────────────────────

import { validateProviderReady, formatValidationError } from "./transport-config.js";
import type { ProviderConfig } from "./transport-config.js";

type MockEnv = { getApiKey: (name: string) => string | undefined };

describe("#367 — validateProviderReady", () => {
  // ── api transport ──────────────────────────────────────────────────────

  describe("api transport", () => {
    it("returns ok when apiKeyEnv is unset (no auth required — ollama-style)", () => {
      const provider: ProviderConfig = { transport: "api", endpoint: "http://localhost:11434/v1" };
      const env: MockEnv = { getApiKey: () => undefined };
      expect(validateProviderReady("ollama", provider, env)).toEqual({ ok: true });
    });

    it("returns ok when apiKeyEnv is set to a non-empty value", () => {
      const provider: ProviderConfig = { transport: "api", apiKeyEnv: "OPENROUTER_API_KEY" };
      const env: MockEnv = { getApiKey: (n) => n === "OPENROUTER_API_KEY" ? "sk-real-key" : undefined };
      expect(validateProviderReady("openrouter", provider, env)).toEqual({ ok: true });
    });

    it("returns failure naming the env var when key is missing", () => {
      const provider: ProviderConfig = { transport: "api", apiKeyEnv: "OPENROUTER_API_KEY" };
      const env: MockEnv = { getApiKey: () => undefined };
      const result = validateProviderReady("openrouter", provider, env);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("OPENROUTER_API_KEY");
      expect(result.reason).toContain("openrouter");
      expect(result.fix).toContain("OPENROUTER_API_KEY");
      expect(result.fix).toContain(".env");
    });

    it("treats empty string as missing", () => {
      const provider: ProviderConfig = { transport: "api", apiKeyEnv: "X_KEY" };
      const env: MockEnv = { getApiKey: () => "" };
      const result = validateProviderReady("x", provider, env);
      expect(result.ok).toBe(false);
    });
  });

  // ── acp transport ──────────────────────────────────────────────────────

  describe("acp transport", () => {
    it("returns failure when provider.cli is missing", () => {
      const provider: ProviderConfig = { transport: "acp" };
      const env: MockEnv = { getApiKey: () => undefined };
      const result = validateProviderReady("kiro-free", provider, env);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("cli");
    });

    it("returns ok when the CLI --version succeeds (using node as a reliable binary)", () => {
      const provider: ProviderConfig = { transport: "acp", cli: "node" };
      const env: MockEnv = { getApiKey: () => undefined };
      expect(validateProviderReady("fake-node-acp", provider, env)).toEqual({ ok: true });
    });

    it("returns failure when the CLI doesn't exist", () => {
      const provider: ProviderConfig = { transport: "acp", cli: "nonexistent-cli-abc123xyz" };
      const env: MockEnv = { getApiKey: () => undefined };
      const result = validateProviderReady("broken-provider", provider, env);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("nonexistent-cli-abc123xyz");
      expect(result.reason).toContain("broken-provider");
      expect(result.fix).toContain("nonexistent-cli-abc123xyz");
    });

    it("returns failure when the CLI exits non-zero", () => {
      const provider: ProviderConfig = { transport: "acp", cli: "false" };
      const env: MockEnv = { getApiKey: () => undefined };
      const result = validateProviderReady("always-fails", provider, env);
      expect(result.ok).toBe(false);
    });
  });

  // ── tmux transport ─────────────────────────────────────────────────────

  describe("tmux transport", () => {
    it("always returns ok (out of scope)", () => {
      const provider: ProviderConfig = { transport: "tmux" };
      const env: MockEnv = { getApiKey: () => undefined };
      expect(validateProviderReady("tmux-provider", provider, env)).toEqual({ ok: true });
    });
  });

  // ── unknown transport (fail closed) ────────────────────────────────────

  describe("unknown transport", () => {
    it("fails with a clear message naming the transport value", () => {
      const provider = { transport: "weird-thing" } as unknown as ProviderConfig;
      const env: MockEnv = { getApiKey: () => undefined };
      const result = validateProviderReady("weirdo", provider, env);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("weird-thing");
    });
  });

  // ── formatValidationError ──────────────────────────────────────────────

  describe("formatValidationError", () => {
    it("returns empty string on ok", () => {
      expect(formatValidationError("x", { ok: true })).toBe("");
    });

    it("includes provider name, reason, and fix", () => {
      const msg = formatValidationError("openrouter", {
        ok: false,
        reason: "API key missing",
        fix: "set OPENROUTER_API_KEY",
      });
      expect(msg).toContain("openrouter");
      expect(msg).toContain("API key missing");
      expect(msg).toContain("set OPENROUTER_API_KEY");
      expect(msg.startsWith("❌")).toBe(true);
    });
  });
});

// ── Demotion tests (#567) ───────────────────────────────────────────────────

import { cleanDemotedModels } from "./transport-config.js";

describe("resolveAgent with demotion", () => {
  it("skips demoted primary and promotes first healthy fallback", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      agents: {
        ...TRANSPORT.agents,
        professor: { model: "claude-sonnet-4.6", provider: "kiro-free", demoted: "2026-05-22", demotedReason: "auth", fallbacks: [{ model: "minimax-m2.5:cloud", provider: "ollama" }] } as any,
      },
    };
    const r = resolveAgent("professor", tc, MODELS)!;
    expect(r.model).toBe("minimax-m2.5:cloud");
    expect(r.providerName).toBe("ollama");
  });

  it("filters demoted fallbacks from returned list", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      agents: {
        ...TRANSPORT.agents,
        professor: { model: "claude-sonnet-4.6", provider: "kiro-free", fallbacks: [
          { model: "minimax-m2.5:cloud", provider: "ollama", demoted: "2026-05-22" } as any,
        ] },
      },
    };
    const r = resolveAgent("professor", tc, MODELS)!;
    expect(r.model).toBe("claude-sonnet-4.6");
    expect(r.fallbacks).toEqual([]);
  });

  it("uses primary anyway when all models demoted", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      agents: {
        ...TRANSPORT.agents,
        professor: { model: "claude-sonnet-4.6", provider: "kiro-free", demoted: "2026-05-22", fallbacks: [
          { model: "minimax-m2.5:cloud", provider: "ollama", demoted: "2026-05-22" } as any,
        ] } as any,
      },
    };
    const r = resolveAgent("professor", tc, MODELS)!;
    expect(r.model).toBe("claude-sonnet-4.6"); // falls back to primary
  });
});

describe("cleanDemotedModels", () => {
  it("removes demoted fallbacks", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      agents: {
        professor: { model: "claude-sonnet-4.6", provider: "kiro-free", fallbacks: [
          { model: "minimax-m2.5:cloud", provider: "ollama", demoted: "2026-05-22" } as any,
        ] },
        dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" },
      },
      providers: TRANSPORT.providers,
      maxTurns: 50,
    };
    cleanDemotedModels(tc);
    expect(tc.agents["professor"]!.fallbacks).toEqual([]);
  });

  it("resurrects chosen model (clears demotion)", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      agents: {
        professor: { model: "claude-sonnet-4.6", provider: "kiro-free", demoted: "2026-05-22", demotedReason: "auth", fallbacks: [] } as any,
        dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" },
      },
      providers: TRANSPORT.providers,
      maxTurns: 50,
    };
    cleanDemotedModels(tc, "claude-sonnet-4.6");
    expect((tc.agents["professor"] as any).demoted).toBeUndefined();
    expect((tc.agents["professor"] as any).demotedReason).toBeUndefined();
  });

  it("keeps non-demoted fallbacks intact", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      agents: {
        professor: { model: "claude-sonnet-4.6", provider: "kiro-free", fallbacks: [
          { model: "minimax-m2.5:cloud", provider: "ollama" },
          { model: "dead-model", provider: "ollama", demoted: "2026-05-22" } as any,
        ] },
        dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" },
      },
      providers: TRANSPORT.providers,
      maxTurns: 50,
    };
    cleanDemotedModels(tc);
    expect(tc.agents["professor"]!.fallbacks).toEqual([{ model: "minimax-m2.5:cloud", provider: "ollama" }]);
  });
});
