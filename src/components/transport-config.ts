import { getEnv } from "./env-schema.js";
/**
 * transport-config.ts — Load and validate transport.json + models.json.
 * Falls back to .env defaults if JSON is broken.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";
import { readEnvWithDefault } from "./env.js";
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
  hailMary?: { model: string; provider: string };
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
  const p = join(configDir(), getEnv().modelsConfig);
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ModelCatalog;
  } catch (err) {
    logWarn(TAG, `Failed to load models.json: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function loadTransport(): TransportConfig | null {
  if (cachedTransport) return cachedTransport;
  const dir = configDir();
  const p = join(dir, getEnv().transportConfig);
  try {
    cachedTransport = JSON.parse(readFileSync(p, "utf-8")) as TransportConfig;
    logInfo(TAG, `Loaded transport config (${Object.keys(cachedTransport.agents).length} agents, ${Object.keys(cachedTransport.providers).length} providers)`);
    const repairs = validateAndRepair(cachedTransport);
    if (repairs.length > 0) {
      for (const r of repairs) logWarn(TAG, `Auto-repaired: ${r.agent} was on ${r.oldProvider} — ${r.reason}`);
      writeTransportConfig(cachedTransport, `invariant auto-repair (${repairs.length} agents)`);
      pendingRepairs = repairs;
    }
    return cachedTransport;
  } catch {
    // Fallback to transport.default.json
    try {
      cachedTransport = JSON.parse(readFileSync(join(dir, "transport.default.json"), "utf-8")) as TransportConfig;
      logWarn(TAG, `transport.json missing/corrupt — loaded transport.default.json`);
      return cachedTransport;
    } catch (err) {
      logError(TAG, `No transport config available: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

/** Resolve hailMary from transport.json. Returns null if not configured. */
export function resolveHailMary(transport?: TransportConfig | null): { model: string; endpoint: string; apiKeyEnv?: string } | null {
  const tc = transport ?? loadTransport();
  if (!tc?.hailMary) return null;
  const provider = tc.providers[tc.hailMary.provider];
  if (!provider?.endpoint) return null;
  return { model: tc.hailMary.model, endpoint: provider.endpoint, apiKeyEnv: provider.apiKeyEnv };
}

/** Force re-read on next call (for tests). */
export function clearTransportCache(): void {
  cachedTransport = null;
}

// ── Invariant validation ────────────────────────────────────────────────────

export type RepairEntry = { agent: string; oldProvider: string; reason: string };

/** Stashed repairs from last loadTransport() — consumed by model-health task. */
let pendingRepairs: RepairEntry[] = [];
export function consumeRepairs(): RepairEntry[] {
  const r = pendingRepairs;
  pendingRepairs = [];
  return r;
}

/**
 * Validate transport invariant: all agents must share professor's transport type.
 * For acp/tmux, provider name must also match (single child process).
 * Violations are auto-repaired (subagent reset to professor's assignment).
 */
export function validateAndRepair(tc: TransportConfig): RepairEntry[] {
  const profAssignment = tc.agents["professor"];
  if (!profAssignment) return [];
  const profProvider = tc.providers[profAssignment.provider];
  if (!profProvider) return [];

  const profType = profProvider.transport;
  const repairs: RepairEntry[] = [];

  for (const [agent, assignment] of Object.entries(tc.agents)) {
    if (agent === "professor") continue;
    const provider = tc.providers[assignment.provider];
    if (!provider) continue;

    const agentType = provider.transport;
    let violation = false;

    if (agentType !== profType) {
      // Cross-transport-type violation
      violation = true;
    } else if (profType !== "api" && assignment.provider !== profAssignment.provider) {
      // ACP/tmux: must share exact provider (single child process)
      violation = true;
    }

    if (violation) {
      repairs.push({ agent, oldProvider: assignment.provider, reason: `${provider.transport} incompatible with professor (${profType}/${profAssignment.provider})` });
      tc.agents[agent] = { model: profAssignment.model, provider: profAssignment.provider };
    }
  }

  // Validate professor fallbacks — must also match professor's transport type
  const fallbacks = profAssignment.fallbacks;
  if (fallbacks) {
    for (let i = fallbacks.length - 1; i >= 0; i--) {
      const fb = fallbacks[i]!;
      const fbProvider = tc.providers[fb.provider];
      if (!fbProvider) continue;
      const fbType = fbProvider.transport;
      if (fbType !== profType || (profType !== "api" && fb.provider !== profAssignment.provider)) {
        repairs.push({ agent: `professor_fb${i + 1}`, oldProvider: fb.provider, reason: `fallback ${fbProvider.transport} incompatible with professor (${profType}/${profAssignment.provider})` });
        fallbacks.splice(i, 1);
      }
    }
  }

  // hailMary is exempt — manual emergency override that rebuilds transport

  return repairs;
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
  const providerName = readEnvWithDefault("DEFAULT_PROVIDER", "openrouter", "default LLM provider");
  const transport = getEnv().defaultTransport as "api" | "acp" | "tmux";
  const model = readEnvWithDefault("DEFAULT_MODEL", "minimax-m2.5:cloud", "default LLM model");

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

export function writeTransportConfig(tc: TransportConfig, reason?: string): void {
  const p = join(configDir(), getEnv().transportConfig);
  writeFileSync(p, JSON.stringify(tc, null, 2), "utf-8");
  cachedTransport = tc;
  
  logInfo(TAG, reason ? `transport.json updated — ${reason} (buckets cleared)` : "transport.json updated (buckets cleared)");
}

/** Copy transport.default.json → transport.json, clear cache. Returns true if successful. */
export function resetToDefaults(): boolean {
  const dir = configDir();
  const defaultPath = join(dir, "transport.default.json");
  const activePath = join(dir, getEnv().transportConfig);
  try {
    // Backup current before overwriting
    try { writeFileSync(activePath.replace(".json", ".old.json"), readFileSync(activePath, "utf-8"), "utf-8"); } catch { /* no current to backup */ }
    const defaults = readFileSync(defaultPath, "utf-8");
    writeFileSync(activePath, defaults, "utf-8");
    cachedTransport = null;
    logInfo(TAG, "transport.json reset to defaults (old saved as .old.json)");
    return true;
  } catch (err) {
    logWarn(TAG, `No transport.default.json — keeping current config: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
