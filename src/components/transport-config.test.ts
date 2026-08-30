// TEST DEFICIENCY (#1466): The following paths lack unit test coverage:
//   1. loadTransportStructured() — primary-vs-backup-vs-default recovery chain,
//      invalid-vs-missing state, source tracking. Requires filesystem mocking.
//   2. writeTransportConfig() — atomic temp-file write, backup preservation,
//      rollback on rename failure, cache-only-after-success. Needs mock fs.
//   3. restorePrevious() / resetToDefaults() — rollback-safe swap, backup
//      validation, temp-file cleanup on error. Needs mock fs.
//   4. phase-transport recovery — reload, /reset keep-existing-transport path.
//      Integration-level test with BootCtx.
//   5. telegram-model-picker — detached candidate path, cascade write.
//      Requires Telegram API mock.
//   Deferred: develop when mock-fs infrastructure or integration harness is in place.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveAgent, resolveHailMary, getEnvFallback, clearTransportCache, validateTransportConfig, validateRouteProvidersReady, writeTransportConfig, getModelsForProvider, computeCostDisplay } from "./transport-config.js";
import type { TransportConfig, ModelCatalog, AgentAssignment } from "./transport-config.js";
import { _setWarmedForTest, _resetForTest } from "./transport/pi-catalog.js";

const MODELS: ModelCatalog = {
  "claude-sonnet-4.6": { contextWindow: 1000000, maxOutput: 16384, rank: 2, cost: { input: 3.0, output: 15.0 }, transports: ["kiro-free"] },
  "minimax-m2.5:cloud": { contextWindow: 128000, maxOutput: 8192, rank: 3, cost: { input: 0.0, output: 0.0 }, transports: ["ollama"] },
};

const TRANSPORT: TransportConfig = {
  schemaVersion: 3,
  activeRoute: "acp",
  routes: {
    acp: {
      agents: {
        main: { model: "claude-sonnet-4.6", provider: "kiro-free" },
        dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" },
      },
      fallbacks: [{ model: "minimax-m2.5:cloud", provider: "ollama" }],
    },
  },
  providers: {
    "kiro-free": { transport: "acp", cli: "kiro-cli" },
    ollama: { transport: "api", endpoint: "http://localhost:11434/v1" },
  },
  maxTurns: 50,
};

beforeEach(() => clearTransportCache());

describe("resolveAgent", () => {
  it("resolves main with model details from models.json", () => {
    const r = resolveAgent("main", TRANSPORT, MODELS)!;
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

  it("task inherits main", () => {
    const r = resolveAgent("task", TRANSPORT, MODELS)!;
    expect(r.model).toBe("claude-sonnet-4.6");
    expect(r.providerName).toBe("kiro-free");
  });

  it("returns null for unknown role", () => {
    expect(resolveAgent("unknown", TRANSPORT, MODELS)).toBeNull();
  });

  it("returns null for missing provider", () => {
    const tc: TransportConfig = { ...TRANSPORT, routes: { acp: { agents: { main: { model: "x", provider: "nonexistent" } }, fallbacks: [] } }, providers: {} };
    expect(resolveAgent("main", tc, MODELS)).toBeNull();
  });

  it("uses defaults when model not in catalog", () => {
    const r = resolveAgent("main", TRANSPORT, {})!;
    expect(r.contextWindow).toBe(128000);
    expect(r.maxOutput).toBe(8192);
  });
});

describe("getEnvFallback", () => {
  it("returns openrouter defaults", () => {
    const fb = getEnvFallback();
    expect(fb.providerName).toBe("openrouter");
    expect(fb.provider.transport).toBe("api");
    expect(fb.model).toBe("minimax/minimax-m2.5");
  });
});

describe("resolveHailMary", () => {
  it("resolves an ACP hailMary without requiring an HTTP endpoint", () => {
    const config: TransportConfig = {
      ...TRANSPORT,
      hailMary: { route: "acp", model: "claude-sonnet-4.6", provider: "kiro-free" },
    };
    expect(resolveHailMary(config)).toMatchObject({
      route: "acp",
      model: "claude-sonnet-4.6",
      provider: "kiro-free",
      cli: "kiro-cli",
    });
  });
});

describe("validateTransportConfig — pure validator (#1466)", () => {
  const providers = {
    ollama: { transport: "api" as const, endpoint: "http://localhost:11434/v1" },
    openrouter: { transport: "api" as const, endpoint: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
    kiro: { transport: "acp" as const, cli: "kiro-cli" },
    gemini: { transport: "acp" as const, cli: "gemini-cli" },
  };

  const mkPi = (overrides?: Record<string, unknown>) => ({
    schemaVersion: 3,
    activeRoute: "pi-ai",
    routes: { "pi-ai": { agents: { main: { model: "m1", provider: "ollama" }, dreamy: { model: "m2", provider: "openrouter" } }, fallbacks: [] as Array<{ model: string; provider: string }> } },
    providers,
    ...overrides,
  });

  const mkAcp = (overrides?: Record<string, unknown>) => ({
    schemaVersion: 3,
    activeRoute: "acp",
    routes: { acp: { agents: { main: { model: "m1", provider: "kiro" }, dreamy: { model: "m2", provider: "kiro" } }, fallbacks: [] as Array<{ model: string; provider: string }> } },
    providers,
    ...overrides,
  });

  it("accepts valid pi-ai config", () => {
    const result = validateTransportConfig(mkPi());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.activeRoute).toBe("pi-ai");
      expect(result.config.routes["pi-ai"]!.agents["main"]!.provider).toBe("ollama");
    }
  });

  it("accepts valid acp config with matching providers", () => {
    const result = validateTransportConfig(mkAcp());
    expect(result.ok).toBe(true);
  });

  it("reports cross-transport violation (subagent api, main acp)", () => {
    const result = validateTransportConfig(mkAcp({ routes: { acp: { agents: { main: { model: "m1", provider: "kiro" }, dreamy: { model: "m2", provider: "ollama" } }, fallbacks: [] } } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(i => i.path.includes("dreamy"))).toBe(true);
      expect(result.issues.some(i => i.code === "provider_route_incompatible")).toBe(true);
    }
  });

  it("reports acp provider mismatch (multiple providers for acp route)", () => {
    const result = validateTransportConfig(mkAcp({ routes: { acp: { agents: { main: { model: "m1", provider: "kiro" }, dreamy: { model: "m2", provider: "gemini" } }, fallbacks: [] } } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "acp_provider_mismatch")).toBe(true);
    }
  });

  it("reports fallbacks with incompatible route", () => {
    const result = validateTransportConfig(mkAcp({ routes: { acp: { agents: { main: { model: "m1", provider: "kiro" } }, fallbacks: [{ model: "m2", provider: "ollama" }, { model: "m3", provider: "kiro" }] } } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(i => i.path === "routes.acp.fallbacks[0]")).toBe(true);
      expect(result.issues.some(i => i.path === "routes.acp.fallbacks[0]" && i.code === "provider_route_incompatible")).toBe(true);
    }
  });

  it("does not mutate input", () => {
    const input = mkPi();
    const before = JSON.stringify(input);
    validateTransportConfig(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("rejects missing activeRoute", () => {
    const result = validateTransportConfig({
      schemaVersion: 3,
      routes: { "pi-ai": { agents: { main: { model: "m1", provider: "ollama" } }, fallbacks: [] } },
      providers,
    } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "missing_field" && i.path === "activeRoute")).toBe(true);
    }
  });

  it("rejects unsupported schema version", () => {
    const result = validateTransportConfig({
      schemaVersion: 1,
      activeRoute: "pi-ai",
      routes: { "pi-ai": { agents: { main: { model: "m1", provider: "ollama" } }, fallbacks: [] } },
      providers,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "unsupported_schema")).toBe(true);
    }
  });

  it("rejects invalid route value", () => {
    const result = validateTransportConfig({
      schemaVersion: 3,
      activeRoute: "invalid-route",
      routes: { "pi-ai": { agents: { main: { model: "m1", provider: "ollama" } }, fallbacks: [] } },
      providers,
    } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "invalid_route")).toBe(true);
    }
  });

  it("reports missing provider reference", () => {
    const result = validateTransportConfig({
      schemaVersion: 3,
      activeRoute: "pi-ai",
      routes: { "pi-ai": { agents: { main: { model: "m1", provider: "nonexistent" } }, fallbacks: [] } },
      providers,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "missing_provider")).toBe(true);
    }
  });

  it("reports malformed config shapes without throwing", () => {
    const malformed = {
      schemaVersion: 3,
      activeRoute: "pi-ai",
      routes: { "pi-ai": { agents: { main: null }, fallbacks: [null] } },
      providers: {},
    };
    expect(() => validateTransportConfig(malformed)).not.toThrow();
    const result = validateTransportConfig(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(i => i.path === "routes.pi-ai.agents.main")).toBe(true);
      expect(result.issues.some(i => i.path === "routes.pi-ai.fallbacks[0]")).toBe(true);
    }
    expect(validateTransportConfig(null).ok).toBe(false);
  });

  it("requires a non-empty mutation reason", () => {
    const result = writeTransportConfig(TRANSPORT, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ location: "reason" }),
      ]));
    }
  });

  it("does not report model_provider_incompatible for unknown models (custom models OK)", () => {
    const result = validateTransportConfig({
      schemaVersion: 3,
      activeRoute: "pi-ai",
      routes: { "pi-ai": { agents: { main: { model: "__nonexistent_custom_model__", provider: "ollama" } }, fallbacks: [] } },
      providers,
    });
    expect(result.ok).toBe(true);
  });

  it("reports model_provider_incompatible when catalog model is on wrong provider", () => {
    const result = validateTransportConfig({
      schemaVersion: 3,
      activeRoute: "pi-ai",
      routes: { "pi-ai": { agents: { main: { model: "claude-opus-4.6", provider: "ollama" } }, fallbacks: [] } },
      providers: { ...providers, ollama: { transport: "api", endpoint: "http://localhost:11434/v1" } },
    });
    if (result.ok) return;
    expect(result.issues.some(i => i.code === "model_provider_incompatible")).toBe(true);
  });

  it("reports model_provider_incompatible for fallbacks on wrong provider", () => {
    const result = validateTransportConfig({
      schemaVersion: 3,
      activeRoute: "pi-ai",
      routes: { "pi-ai": { agents: { main: { model: "m1", provider: "ollama" } }, fallbacks: [{ model: "claude-opus-4.6", provider: "ollama" }] } },
      providers,
    });
    if (result.ok) return;
    expect(result.issues.some(i => i.code === "model_provider_incompatible" && i.path.startsWith("routes.pi-ai.fallbacks"))).toBe(true);
  });

  it("#1748: accepts an explicit valid cacheRetention on a provider", () => {
    const result = validateTransportConfig(mkPi({
      providers: { ...providers, openrouter: { ...providers.openrouter, cacheRetention: "long" } },
    }));
    expect(result.ok).toBe(true);
  });

  it("#1748: accepts cacheRetention none/short/long and rejects anything else at validation", () => {
    for (const value of ["none", "short", "long"]) {
      const okResult = validateTransportConfig(mkPi({
        providers: { ...providers, openrouter: { ...providers.openrouter, cacheRetention: value } },
      }));
      expect(okResult.ok).toBe(true);
    }
    const bad = validateTransportConfig(mkPi({
      providers: { ...providers, openrouter: { ...providers.openrouter, cacheRetention: "medium" } },
    }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.some(i => i.code === "invalid_provider_field" && i.path === "providers.openrouter.cacheRetention")).toBe(true);
    }
  });

  it("#1748: cacheRetention absent means short — the provider entry stays valid without it", () => {
    const result = validateTransportConfig(mkPi());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers["openrouter"]!.cacheRetention).toBeUndefined();
    }
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
      expect(result.fix).toContain("~/.abtars/secret/");
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

describe("#1467 — target route provider readiness", () => {
  it("checks fallback providers as well as the main provider", () => {
    const config: TransportConfig = {
      schemaVersion: 3,
      activeRoute: "pi-ai",
      routes: {
        "pi-ai": {
          agents: { main: { model: "m1", provider: "main" } },
          fallbacks: [{ model: "m2", provider: "fallback" }],
        },
      },
      providers: {
        main: { transport: "api", apiKeyEnv: "MAIN_KEY" },
        fallback: { transport: "api", apiKeyEnv: "FALLBACK_KEY" },
      },
    };
    const result = validateRouteProvidersReady(config, "pi-ai", { getApiKey: name => name === "MAIN_KEY" ? "set" : undefined });
    expect(result?.providerName).toBe("fallback");
    expect(result?.result.ok).toBe(false);
  });
});

// ── Demotion tests (#567) ───────────────────────────────────────────────────

import { cleanDemotedModels } from "./transport-config.js";

describe("resolveAgent with demotion", () => {
  it("marks demoted primary — runtime FallbackPolicy handles skipping", () => {
    // Demotion metadata is persisted on route-local assignments (routes.acp.agents),
    // not on top-level TransportConfig fields.
    type DemotedAssignment = AgentAssignment & {
      demoted: string;
      demotedReason: "auth" | "timeout";
    };
    const acpRoute = TRANSPORT.routes.acp;
    if (acpRoute === undefined) throw new Error("test fixture missing acp route");
    const demotedMain = {
      model: "claude-sonnet-4.6",
      provider: "kiro-free",
      demoted: "2026-05-22",
      demotedReason: "auth",
    } satisfies DemotedAssignment;
    const tc: TransportConfig = {
      ...TRANSPORT,
      routes: {
        ...TRANSPORT.routes,
        acp: {
          ...acpRoute,
          agents: { ...acpRoute.agents, main: demotedMain },
        },
      },
    };
    // resolveAgent no longer auto-promotes — FallbackPolicy handles demoted models at runtime
    const r = resolveAgent("main", tc, MODELS)!;
    expect(r.model).toBe("claude-sonnet-4.6"); // still returns configured primary
    expect(r.fallbacks).toHaveLength(1);
    expect(r.fallbacks[0]!.model).toBe("minimax-m2.5:cloud");
  });

  it("filters demoted fallbacks from returned list", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      routes: {
        acp: {
          agents: { main: { model: "claude-sonnet-4.6", provider: "kiro-free" }, dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" } },
          fallbacks: [
            { model: "minimax-m2.5:cloud", provider: "ollama", demoted: "2026-05-22" } as any,
          ],
        },
      },
    };
    const r = resolveAgent("main", tc, MODELS)!;
    expect(r.model).toBe("claude-sonnet-4.6");
    expect(r.fallbacks).toEqual([]);
  });

  it("uses primary anyway when all models demoted", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      routes: {
        acp: {
          agents: {
            main: { model: "claude-sonnet-4.6", provider: "kiro-free", demoted: "2026-05-22" } as any,
            dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" },
          },
          fallbacks: [
            { model: "minimax-m2.5:cloud", provider: "ollama", demoted: "2026-05-22" } as any,
          ],
        },
      },
    };
    const r = resolveAgent("main", tc, MODELS)!;
    expect(r.model).toBe("claude-sonnet-4.6"); // falls back to primary
  });
});

describe("cleanDemotedModels", () => {
  const ra = { agents: { main: { model: "claude-sonnet-4.6", provider: "kiro-free" }, dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" } }, fallbacks: [{ model: "minimax-m2.5:cloud", provider: "ollama", demoted: "2026-05-22" } as any] };

  it("keeps demoted fallbacks but does not remove them", () => {
    const tc: TransportConfig = { ...TRANSPORT, routes: { acp: { ...ra } } };
    cleanDemotedModels(tc);
    const tcRa = tc.routes["acp"]!;
    expect(tcRa.fallbacks).toHaveLength(1);
    expect(tcRa.fallbacks![0]!.model).toBe("minimax-m2.5:cloud");
  });

  it("resurrects chosen model (clears demotion)", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      routes: {
        acp: {
          agents: {
            main: { model: "claude-sonnet-4.6", provider: "kiro-free", demoted: "2026-05-22", demotedReason: "auth" } as any,
            dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" },
          },
          fallbacks: [],
        },
      },
    };
    cleanDemotedModels(tc, "claude-sonnet-4.6");
    const tcRa = tc.routes["acp"]!;
    expect((tcRa.agents["main"] as any).demoted).toBeUndefined();
    expect((tcRa.agents["main"] as any).demotedReason).toBeUndefined();
  });

  it("keeps all fallbacks — demoted and non-demoted", () => {
    const tc: TransportConfig = {
      ...TRANSPORT,
      routes: {
        acp: {
          agents: { main: { model: "claude-sonnet-4.6", provider: "kiro-free" }, dreamy: { model: "minimax-m2.5:cloud", provider: "ollama" } },
          fallbacks: [
            { model: "minimax-m2.5:cloud", provider: "ollama" },
            { model: "dead-model", provider: "ollama", demoted: "2026-05-22" } as any,
          ],
        },
      },
    };
    cleanDemotedModels(tc);
    const tcRa = tc.routes["acp"]!;
    expect(tcRa.fallbacks).toHaveLength(2);
  });
});

describe("computeCostDisplay (#1614)", () => {
  it("renders $/1M with 2 decimals, zero-padded (per-token input)", () => {
    expect(computeCostDisplay({ input: 0.14 / 1_000_000, output: 0.28 / 1_000_000 })).toEqual({ inputPer1M: "0.14", outputPer1M: "0.28" });
    expect(computeCostDisplay({ input: 0.4 / 1_000_000, output: 1.2 / 1_000_000 })).toEqual({ inputPer1M: "0.40", outputPer1M: "1.20" });
    expect(computeCostDisplay({ input: 0, output: 0 })).toEqual({ inputPer1M: "0.00", outputPer1M: "0.00" });
  });
});

describe("getModelsForProvider — pi-catalog fallback (#1613)", () => {
  const piList = (): Array<{ id: string; contextWindow: number; maxTokens: number; cost: { input: number; output: number } }> => [
    { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 65536, cost: { input: 0.14, output: 0.28 } },
    { id: "kimi-k3", contextWindow: 1000000, maxTokens: 32768, cost: { input: 3, output: 15 } },
  ];

  const fakePiModels = (list = piList()): unknown => ({
    getModels: (_p?: string) => list,
    getModel: (_p: string, id: string) => list.find(m => m.id === id) ?? null,
  });

  afterEach(() => _resetForTest());

  it("returns pi models with $/token costs for a pi-mapped provider with no curated entries", () => {
    _setWarmedForTest(fakePiModels() as never);
    const out = getModelsForProvider("opencode-go", {});
    expect(out.map(m => m.id)).toEqual(["deepseek-v4-flash", "kimi-k3"]); // sorted by input cost
    const flash = out[0]!;
    expect(flash.entry).toMatchObject({
      contextWindow: 1000000,
      maxOutput: 65536,
      rank: 3,
      transports: ["opencode-go"],
      status: "alive",
    });
    // #1614: pi rates are $/1M — synthetic entries normalize to the $/token ModelCost contract.
    expect(flash.entry.cost.input).toBe(0.14 / 1_000_000);
    expect(flash.entry.cost.output).toBe(0.28 / 1_000_000);
  });

  it("leaves curated providers untouched even when pi is warmed", () => {
    _setWarmedForTest(fakePiModels([...piList(), { id: "claude-sonnet-4.6", contextWindow: 1000000, maxTokens: 16384, cost: { input: 3, output: 15 } }]) as never);
    const out = getModelsForProvider("kiro-free", MODELS);
    expect(out.map(m => m.id)).toEqual(["claude-sonnet-4.6"]);
    expect(out[0]!.entry.cost.input).toBe(3.0); // models.json values untouched
  });

  it("returns empty for an uncurated pi provider whose catalog exceeds the picker cap", () => {
    const big = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, contextWindow: 128000, maxTokens: 8192, cost: { input: 0.1, output: 0.2 } }));
    _setWarmedForTest(fakePiModels(big) as never);
    expect(getModelsForProvider("opencode-go", {})).toEqual([]);
  });

  it("returns curated-only on a cold cache", () => {
    _resetForTest();
    expect(getModelsForProvider("opencode-go", {})).toEqual([]);
  });

  it("never merges for unmapped providers", () => {
    _setWarmedForTest(fakePiModels() as never);
    expect(getModelsForProvider("ollama", {})).toEqual([]);
  });
});
