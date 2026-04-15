/**
 * transport-config.ts — Load and validate transport.json + models.json.
 * Falls back to .env defaults if JSON is broken.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";
import { logInfo, logWarn, logError } from "./logger.js";

const TAG = "transport-config";

// ── Types ───────────────────────────────────────────────────────────────────

export type ModelCost = { input: number; output: number };

export type ModelEntry = {
  contextWindow: number;
  maxOutput: number;
  rank: number;
  cost: ModelCost;
  transports: string[];
  description?: string;
  addedAt?: string;
};

export type ModelCatalog = Record<string, ModelEntry>;

export type AgentAssignment = {
  model: string;
  provider: string;
  fallbacks?: Array<{ model: string; provider: string }>;
};

export type ProviderConfig = {
  transport: "acp" | "tmux" | "api";
  cli?: string;
  endpoint?: string;
  apiKeyEnv?: string;
};

export type TransportDefaults = {
  tmux?: { session?: string; captureDelaySec?: number; maxWaitSec?: number };
  acp?: { permissionTimeoutMs?: number };
};

export type TransportConfig = {
  agents: Record<string, AgentAssignment>;
  providers: Record<string, ProviderConfig>;
  transportDefaults?: TransportDefaults;
  maxTurns?: number;
};

export type ResolvedAgent = {
  model: string;
  provider: ProviderConfig;
  providerName: string;
  contextWindow: number;
  maxOutput: number;
  fallbacks: Array<{ model: string; provider: string }>;
};

// ── Loaders ─────────────────────────────────────────────────────────────────

let cachedTransport: TransportConfig | null = null;

function configDir(): string {
  return join(agentBridgeHome(), "config");
}

export function loadModels(): ModelCatalog {
  const p = join(configDir(), process.env["MODELS_CONFIG"]?.replace("config/", "") ?? "models.json");
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ModelCatalog;
  } catch (err) {
    logWarn(TAG, `Failed to load models.json: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function loadTransport(): TransportConfig | null {
  if (cachedTransport) return cachedTransport;
  const p = join(configDir(), process.env["TRANSPORT_CONFIG"]?.replace("config/", "") ?? "transport.json");
  try {
    cachedTransport = JSON.parse(readFileSync(p, "utf-8")) as TransportConfig;
    logInfo(TAG, `Loaded transport config (${Object.keys(cachedTransport.agents).length} agents, ${Object.keys(cachedTransport.providers).length} providers)`);
    return cachedTransport;
  } catch (err) {
    logError(TAG, `Failed to load transport.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Force re-read on next call (for tests). */
export function clearTransportCache(): void {
  cachedTransport = null;
}

// ── Resolution ──────────────────────────────────────────────────────────────

export function resolveAgent(role: string, transport?: TransportConfig | null, models?: ModelCatalog): ResolvedAgent | null {
  const tc = transport ?? loadTransport();
  if (!tc) return null;

  // cron inherits professor
  const effectiveRole = role === "cron" ? "professor" : role;
  const assignment = tc.agents[effectiveRole];
  if (!assignment) {
    logWarn(TAG, `No agent assignment for role "${role}"`);
    return null;
  }

  const provider = tc.providers[assignment.provider];
  if (!provider) {
    logWarn(TAG, `Provider "${assignment.provider}" not found for role "${role}"`);
    return null;
  }

  const mc = models ?? loadModels();
  const modelEntry = mc[assignment.model];
  if (!modelEntry) {
    logWarn(TAG, `Model "${assignment.model}" not in models.json — using defaults`);
  }

  return {
    model: assignment.model,
    provider,
    providerName: assignment.provider,
    contextWindow: modelEntry?.contextWindow ?? 128000,
    maxOutput: modelEntry?.maxOutput ?? 8192,
    fallbacks: assignment.fallbacks ?? [],
  };
}

// ── Fallback from .env ──────────────────────────────────────────────────────

export type EnvFallback = {
  provider: ProviderConfig;
  providerName: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
};

export function getEnvFallback(): EnvFallback {
  const providerName = process.env["DEFAULT_PROVIDER"] ?? "openrouter";
  const transport = (process.env["DEFAULT_TRANSPORT"] ?? "api") as "api" | "acp" | "tmux";
  const model = process.env["DEFAULT_MODEL"] ?? "minimax-m2.5:cloud";

  const provider: ProviderConfig = { transport };
  if (transport === "api") {
    provider.endpoint = providerName === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : "http://localhost:11434/v1";
    if (providerName === "openrouter") provider.apiKeyEnv = "OPENROUTER_API_KEY";
  }

  return { provider, providerName, model, contextWindow: 128000, maxOutput: 8192 };
}

// ── Validation (startup) ────────────────────────────────────────────────────

export function validateAtStartup(): void {
  const tc = loadTransport();
  if (!tc) return;
  const mc = loadModels();

  for (const [role, assignment] of Object.entries(tc.agents)) {
    if (!tc.providers[assignment.provider]) {
      logWarn(TAG, `Agent "${role}": provider "${assignment.provider}" not defined in providers`);
    }
    const modelEntry = mc[assignment.model];
    if (!modelEntry) {
      logWarn(TAG, `Agent "${role}": model "${assignment.model}" not in models.json`);
    } else if (!modelEntry.transports.includes(assignment.provider)) {
      logWarn(TAG, `Agent "${role}": model "${assignment.model}" not listed for provider "${assignment.provider}" in models.json`);
    }
  }
}

// ── Write ───────────────────────────────────────────────────────────────────

export function writeTransportConfig(tc: TransportConfig): void {
  const p = join(configDir(), process.env["TRANSPORT_CONFIG"]?.replace("config/", "") ?? "transport.json");
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(p, JSON.stringify(tc, null, 2), "utf-8");
  cachedTransport = tc;
  logInfo(TAG, "transport.json updated");
}

// ── Provider availability ───────────────────────────────────────────────────

export function getAvailableProviders(tc: TransportConfig): Array<{ name: string; config: ProviderConfig }> {
  return Object.entries(tc.providers).map(([name, config]) => ({ name, config }));
}

// ── Model helpers ───────────────────────────────────────────────────────────

export function getModelsForProvider(providerName: string, models?: ModelCatalog): Array<{ id: string; entry: ModelEntry }> {
  const mc = models ?? loadModels();
  return Object.entries(mc)
    .filter(([, entry]) => entry.transports.includes(providerName))
    .map(([id, entry]) => ({ id, entry }))
    .sort((a, b) => a.entry.rank - b.entry.rank || a.entry.cost.input - b.entry.cost.input);
}

export function formatRank(rank: number): string {
  const stars = Math.max(1, Math.min(5, 6 - rank));
  return "★".repeat(stars) + "☆".repeat(5 - stars);
}

export function formatCost(cost: ModelCost): string {
  if (cost.input === 0 && cost.output === 0) return "free";
  return `$${cost.input}/M in`;
}
