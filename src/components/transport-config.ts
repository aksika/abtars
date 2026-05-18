import { logAndSwallow } from "./log-and-swallow.js";
import { getEnv } from "./env-schema.js";
import { validateShape, TRANSPORT_SCHEMA } from "./config-validator.js";
/**
 * transport-config.ts — Load and validate transport.json + models.json.
 * Falls back to .env defaults if JSON is broken.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
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
  validatedAt?: string;
  status?: "alive" | "dead" | "untested";
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
  apiFormat?: "chat" | "responses" | "anthropic";
  thinking?: { style: "effort"; default: string } | { style: "extended"; default: number };
  defaults?: Record<string, { model: string; fallbacks?: string[] }>;
  fallbackChain?: string[];
};

export type TransportDefaults = {
  tmux?: { session?: string; captureDelaySec?: number; maxWaitSec?: number };
  acp?: { permissionTimeoutMs?: number };
};

import type { HealthPolicyConfig } from "./transport/model-health-registry.js";

export type TransportConfig = {
  agents: Record<string, AgentAssignment>;
  providers: Record<string, ProviderConfig>;
  transportDefaults?: TransportDefaults;
  maxTurns?: number;
  hailMary?: { model: string; provider: string };
  healthPolicy?: HealthPolicyConfig;
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

export function configDir(): string {
  return join(abtarsHome(), "config");
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
    validateShape(cachedTransport, TRANSPORT_SCHEMA, "transport.json");
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
  // Guard: reject empty model strings before persisting
  for (const [role, agent] of Object.entries(tc.agents)) {
    if (!agent.model?.trim()) {
      logWarn(TAG, `Refusing to write transport.json — agent "${role}" has empty model`);
      return;
    }
  }
  const p = join(configDir(), getEnv().transportConfig);
  // Save current as .old before overwriting (enables /model restore)
  try { writeFileSync(p.replace(".json", ".old.json"), readFileSync(p, "utf-8"), "utf-8"); } catch { /* first write or missing — no .old to save */ }
  writeFileSync(p, JSON.stringify(tc, null, 2), "utf-8");
  cachedTransport = tc;
  logInfo(TAG, reason ? `transport.json updated — ${reason}` : "transport.json updated");
}

/** Swap transport.json ↔ transport.json.old (undo last switch). */
export function restorePrevious(): { ok: boolean; error?: string } {
  const dir = configDir();
  const activePath = join(dir, getEnv().transportConfig);
  const oldPath = activePath.replace(".json", ".old.json");
  if (!existsSync(oldPath)) return { ok: false, error: "Nothing to restore — no previous config saved." };
  try {
    const current = readFileSync(activePath, "utf-8");
    const old = readFileSync(oldPath, "utf-8");
    writeFileSync(activePath, old, "utf-8");
    writeFileSync(oldPath, current, "utf-8");
    cachedTransport = null;
    logInfo(TAG, "transport.json swapped with .old (restore)");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Copy transport.default.json → transport.json, clear cache. Returns true if successful. */
export function resetToDefaults(): boolean {
  const dir = configDir();
  const defaultPath = join(dir, "transport.default.json");
  const activePath = join(dir, getEnv().transportConfig);
  try {
    // Backup current before overwriting
    try { writeFileSync(activePath.replace(".json", ".old.json"), readFileSync(activePath, "utf-8"), "utf-8"); } catch (err) { logAndSwallow("transport_config", "op", err); }
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

/** Load a provider's defaults block. Missing subagents inherit professor's model. */
export function loadProviderDefaults(providerName: string, tc?: TransportConfig | null): Record<string, { model: string; fallbacks?: string[] }> | null {
  const config = tc ?? loadTransport();
  if (!config) return null;
  const provider = config.providers[providerName];
  if (!provider?.defaults) return null;
  const defaults = provider.defaults;
  if (!defaults["professor"]) return null;
  const profModel = defaults["professor"].model;
  const result: Record<string, { model: string; fallbacks?: string[] }> = { ...defaults };
  for (const role of ["dreamy", "browsie", "coding"]) {
    if (!result[role]) result[role] = { model: profModel };
  }
  return result;
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

// ── Provider readiness validation (#367) ────────────────────────────────────

export type ProviderValidationResult =
  | { ok: true }
  | { ok: false; reason: string; fix: string };

/**
 * Minimal env accessor — just the slice validateProviderReady needs.
 * Matches the shape exposed by getEnv().
 */
export type EnvAccessor = {
  getApiKey(envName: string): string | undefined;
};

/**
 * Validate that a transport provider's prerequisites are in place BEFORE the
 * bridge attempts to switch to it (#367).
 *
 * Contract:
 * - `api` + `apiKeyEnv` declared → env var must be non-empty
 * - `api` + no `apiKeyEnv` → always ok (local ollama-style)
 * - `acp` → `provider.cli` must be runnable (`<cli> --version` within 3s)
 * - `tmux` → always ok (out of scope)
 *
 * Pure aside from the ACP `execSync` probe. execSync is imported lazily so
 * unit tests can stub it via dependency injection if needed.
 */
export function validateProviderReady(
  providerName: string,
  provider: ProviderConfig,
  env: EnvAccessor,
): ProviderValidationResult {
  if (provider.transport === "tmux") return { ok: true };

  if (provider.transport === "api") {
    if (!provider.apiKeyEnv) return { ok: true };
    const key = env.getApiKey(provider.apiKeyEnv);
    if (!key) {
      return {
        ok: false,
        reason: `${providerName} requires API key from env var '${provider.apiKeyEnv}' but it's not set`,
        fix: `Add ${provider.apiKeyEnv}=... to .env and restart`,
      };
    }
    return { ok: true };
  }

  if (provider.transport === "acp") {
    const cli = provider.cli;
    if (!cli) {
      return {
        ok: false,
        reason: `ACP provider ${providerName} has no 'cli' field set in transport.json`,
        fix: `Add \"cli\": \"<path-to-cli>\" to provider ${providerName} in transport.json`,
      };
    }
    try {
      // Inline require so mocks work in tests and production stays synchronous.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      execSync(`${cli} --version`, { timeout: 3000, stdio: "pipe" });
      return { ok: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return {
        ok: false,
        reason: `ACP provider ${providerName} CLI '${cli}' is not runnable (${errMsg})`,
        fix: `Install ${cli} or update its path in transport.json`,
      };
    }
  }

  // Unknown transport — fail closed with a clear message.
  return {
    ok: false,
    reason: `Unknown transport type '${(provider as ProviderConfig).transport}' for provider ${providerName}`,
    fix: `Use 'api', 'acp', or 'tmux' for provider.transport`,
  };
}

/** Format a validation failure for user-visible error messages. */
export function formatValidationError(providerName: string, result: ProviderValidationResult): string {
  if (result.ok) return "";
  return `❌ Cannot switch to ${providerName}: ${result.reason}\n   Fix: ${result.fix}`;
}
