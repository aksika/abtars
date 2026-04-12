import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAgent, getEnvFallback, clearTransportCache } from "./transport-config.js";
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
