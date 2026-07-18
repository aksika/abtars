import { logAndSwallow } from "./log-and-swallow.js";
import { getEnv } from "./env-schema.js";
import { validateShape, TRANSPORT_SCHEMA } from "./config-validator.js";
/**
 * transport-config.ts — Load and validate transport.json + models.json.
 * Falls back to .env defaults if JSON is broken.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { readEnvWithDefault } from "./env.js";
import { logInfo, logWarn, logError } from "./logger.js";
import { resolveModelMeta, mapProviderName } from "./transport/pi-catalog.js";

const TAG = "transport-config";

// ── Types ───────────────────────────────────────────────────────────────────

export type ModelCost = {
  /** $/token — accurate, used for arithmetic (sort, usage accounting, pi-catalog copy). */
  input: number;
  /** $/token — accurate, used for arithmetic. */
  output: number;
  /** Picker-facing, derived from input/output at load time. Never written to models.json. */
  display?: { inputPer1M: string; outputPer1M: string };
};

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

export type ExecutionRoute = "pi-ai" | "direct-api" | "acp";

export type AgentAssignment = {
  model: string;
  provider: string;
};

export type ProviderConfig = {
  transport: "acp" | "tmux" | "api";
  cli?: string;
  endpoint?: string;
  apiKeyEnv?: string;
  apiFormat?: "chat" | "responses" | "anthropic";
  /** #1311: route this provider's DirectApi through the pi-ai provider engine when installed (default off). */
  useProviderLib?: boolean;
  thinking?:
    | { style: "default" }
    | { style: "effort"; default: "off" | "low" | "medium" | "high" | "xhigh" }
    | { style: "extended"; default: number };
  defaults?: Record<string, { model: string }>;
};

export type TransportDefaults = {
  tmux?: { session?: string; captureDelaySec?: number; maxWaitSec?: number };
  acp?: { permissionTimeoutMs?: number };
};

import type { HealthPolicyConfig } from "./transport/model-health-registry.js";

export type TransportConfig = {
  schemaVersion?: number;
  route: ExecutionRoute;
  agents: Record<string, AgentAssignment>;
  providers: Record<string, ProviderConfig>;
  transportDefaults?: TransportDefaults;
  maxTurns?: number;
  maxToolRounds?: number;
  /** #1386: Lower tool-round limit for fallback candidates. Default 5. */
  maxFallbackToolRounds?: number;
  fallbacks?: Array<{ model: string; provider: string }>;
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
    const raw = JSON.parse(readFileSync(p, "utf-8")) as ModelCatalog;
    for (const entry of Object.values(raw)) {
      if (entry.cost && (entry.cost.input != null || entry.cost.output != null)) {
        entry.cost.display = computeCostDisplay(entry.cost);
      }
    }
    return raw;
  } catch (err) {
    logWarn(TAG, `Failed to load models.json: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function computeCostDisplay(cost: ModelCost): { inputPer1M: string; outputPer1M: string } {
  const fmt = (perToken: number): string => {
    if (!perToken) return "0.0000";
    return (perToken * 1_000_000).toFixed(4);
  };
  return { inputPer1M: fmt(cost.input), outputPer1M: fmt(cost.output) };
}

export function loadTransport(): TransportConfig | null {
  if (cachedTransport) return cachedTransport;
  const dir = configDir();
  const p = join(dir, getEnv().transportConfig);
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    // #1418: one-way migration v1 → v2
    const migrated = migrateTransportConfig(raw);
    if (migrated.error) {
      logError(TAG, `Config migration failed: ${migrated.error}`);
      return null;
    }
    const config = migrated.config!;
    // Validate before persisting migration
    validateShape(config, TRANSPORT_SCHEMA, "transport.json");
    const repairs = validateAndRepair(config);
    cachedTransport = config;
    if (raw.schemaVersion !== 2) {
      const oldPath = p.replace(".json", ".old.json");
      try { writeFileSync(oldPath, JSON.stringify(raw, null, 2), "utf-8"); } catch { /* best effort */ }
      writeFileSync(p, JSON.stringify(config, null, 2), "utf-8");
      logInfo(TAG, "Migrated transport config v1 → v2");
    }
    logInfo(TAG, `Loaded transport config v${config.schemaVersion ?? 2} (route: ${config.route}, ${Object.keys(config.agents).length} agents, ${Object.keys(config.providers).length} providers)`);
    if (repairs.length > 0) {
      for (const r of repairs) logWarn(TAG, `Auto-repaired: ${r.agent} was on ${r.oldProvider} — ${r.reason}`);
      writeTransportConfig(config, `invariant auto-repair (${repairs.length} agents)`);
      pendingRepairs = repairs;
    }
    return config;
  } catch (err) {
    logAndSwallow(TAG, "loadTransport parse", err);
    // Fallback to transport.default.json
    try {
      const defaultRaw = JSON.parse(readFileSync(join(dir, "transport.default.json"), "utf-8")) as Record<string, unknown>;
      const defaultMigrated = migrateTransportConfig(defaultRaw);
      cachedTransport = defaultMigrated.config ?? (defaultRaw as unknown as TransportConfig);
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
  const mainAssignment = tc.agents["main"];
  if (!mainAssignment) return [];
  const mainProvider = tc.providers[mainAssignment.provider];
  if (!mainProvider) return [];

  const mainType = mainProvider.transport;
  const repairs: RepairEntry[] = [];

  for (const [agent, assignment] of Object.entries(tc.agents)) {
    if (agent === "main") continue;
    const provider = tc.providers[assignment.provider];
    if (!provider) continue;

    const agentType = provider.transport;
    let violation = false;

    if (agentType !== mainType) {
      violation = true;
    } else if (mainType !== "api" && assignment.provider !== mainAssignment.provider) {
      violation = true;
    }

    if (violation) {
      repairs.push({ agent, oldProvider: assignment.provider, reason: `${provider.transport} incompatible with main (${mainType}/${mainAssignment.provider})` });
      tc.agents[agent] = { model: mainAssignment.model, provider: mainAssignment.provider };
    }
  }

  // Validate top-level fallbacks — must match route
  if (tc.fallbacks) {
    const route = tc.route;
    for (let i = tc.fallbacks.length - 1; i >= 0; i--) {
      const fb = tc.fallbacks[i]!;
      const fbProvider = tc.providers[fb.provider];
      if (!fbProvider) continue;
      if (!providerSupportsRoute(fbProvider, route)) {
        repairs.push({ agent: `fallback[${i}]`, oldProvider: fb.provider, reason: `fallback incompatible with route ${route}` });
        tc.fallbacks.splice(i, 1);
      }
    }
  }

  return repairs;
}

// ── Resolution ──────────────────────────────────────────────────────────────

export function resolveAgent(role: string, transport?: TransportConfig | null, models?: ModelCatalog, lastSuccessfulMain?: { model: string; provider: string } | null): ResolvedAgent | null {
  const tc = transport ?? loadTransport();
  if (!tc) return null;

  // task inherits main
  const effectiveRole = role === "task" ? "main" : role;
  const assignment = tc.agents[effectiveRole];
  if (!assignment) {
    logWarn(TAG, `No agent assignment for role "${role}"`);
    return null;
  }

  const providers = tc.providers;
  let effectiveModel = assignment.model;
  let effectiveProvider = assignment.provider;

  const resolvedProvider = providers[effectiveProvider];
  if (!resolvedProvider) {
    logWarn(TAG, `Provider "${effectiveProvider}" not found for role "${role}"`);
    return null;
  }

  const mc = models ?? loadModels();
  const modelEntry = mc[effectiveModel];
  if (!modelEntry && effectiveModel) {
    logWarn(TAG, `Model "${effectiveModel}" not in models.json — using defaults`);
  }

  let contextWindow = modelEntry?.contextWindow ?? 128000;
  let maxOutput = modelEntry?.maxOutput ?? 8192;
  if (resolvedProvider.useProviderLib) {
    const piMeta = resolveModelMeta(effectiveModel, effectiveProvider);
    if (piMeta) { contextWindow = piMeta.contextWindow; maxOutput = piMeta.maxOutput; }
  }

  // Build fallback list: top-level fallbacks (filtered), plus last successful Main for specialists
  const seen = new Set<string>();
  const fallbackList: Array<{ model: string; provider: string }> = [];

  // For specialists, prepend last successful Main (or configured Main) before top-level fallbacks
  if (role !== "main" && role !== "task") {
    const lastMain = lastSuccessfulMain ?? { model: tc.agents["main"]?.model ?? "", provider: tc.agents["main"]?.provider ?? "" };
    if (lastMain.model && lastMain.provider) {
      const key = `${lastMain.model}@${lastMain.provider}`;
      seen.add(key);
      fallbackList.push(lastMain);
    }
  }

  // Append top-level fallbacks, filtering demoted and self-duplicates
  for (const fb of tc.fallbacks ?? []) {
    const fbAny = fb as any;
    if (fbAny.demoted || fb.model === effectiveModel) continue;
    const key = `${fb.model}@${fb.provider}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fallbackList.push(fb);
  }

  return {
    model: effectiveModel,
    provider: resolvedProvider,
    providerName: effectiveProvider,
    contextWindow,
    maxOutput,
    fallbacks: fallbackList,
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
  const model = readEnvWithDefault("DEFAULT_MODEL", "minimax/minimax-m2.5", "default LLM model");

  const provider: ProviderConfig = { transport };
  if (transport === "api") {
    provider.endpoint = providerName === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : "http://localhost:11434/v1";
    if (providerName === "openrouter") provider.apiKeyEnv = "OPENROUTER_API_KEY";
  }

  return { provider, providerName, model, contextWindow: 128000, maxOutput: 8192 };
}

// ── Route classification (#1418) ─────────────────────────────────────────────

export function providerSupportsRoute(provider: ProviderConfig, route: ExecutionRoute): boolean {
  if (route === "pi-ai") return provider.transport === "api" && provider.useProviderLib === true;
  if (route === "direct-api") return provider.transport === "api" && provider.useProviderLib !== true;
  if (route === "acp") return provider.transport === "acp";
  return false;
}

export function providersForRoute(config: TransportConfig, route: ExecutionRoute): Array<[string, ProviderConfig]> {
  return Object.entries(config.providers).filter(([, p]) => providerSupportsRoute(p, route));
}

export function inferRouteFromProvider(config: TransportConfig, providerName: string): ExecutionRoute | null {
  const provider = config.providers[providerName];
  if (!provider) return null;
  if (providerSupportsRoute(provider, "pi-ai")) return "pi-ai";
  if (providerSupportsRoute(provider, "direct-api")) return "direct-api";
  if (providerSupportsRoute(provider, "acp")) return "acp";
  return null;
}

export function allAssignmentsMatchRoute(config: TransportConfig, route: ExecutionRoute): boolean {
  for (const assignment of Object.values(config.agents)) {
    const p = config.providers[assignment.provider];
    if (!p || !providerSupportsRoute(p, route)) return false;
  }
  for (const fb of config.fallbacks ?? []) {
    const p = config.providers[fb.provider];
    if (!p || !providerSupportsRoute(p, route)) return false;
  }
  return true;
}

export function acpSameProviderConstraint(config: TransportConfig): boolean {
  // ACP requires all agents to use the same provider (single child process)
  if (config.route !== "acp") return true;
  const first = Object.values(config.agents)[0];
  if (!first) return true;
  return Object.values(config.agents).every(a => a.provider === first.provider);
}

// ── Schema migration (#1418) ─────────────────────────────────────────────────

type LegacyAgentAssignment = {
  model: string;
  provider: string;
  fallbacks?: Array<{ model: string; provider: string }>;
};

type LegacyProviderConfig = {
  transport: "acp" | "tmux" | "api";
  cli?: string;
  endpoint?: string;
  apiKeyEnv?: string;
  apiFormat?: "chat" | "responses" | "anthropic";
  useProviderLib?: boolean;
  thinking?: any;
  defaults?: Record<string, { model: string; fallbacks?: string[] }>;
  fallbackChain?: string[];
};

type LegacyTransportConfig = {
  agents: Record<string, LegacyAgentAssignment>;
  providers: Record<string, LegacyProviderConfig>;
  transportDefaults?: TransportDefaults;
  maxTurns?: number;
  maxToolRounds?: number;
  maxFallbackToolRounds?: number;
  hailMary?: { model: string; provider: string };
  healthPolicy?: HealthPolicyConfig;
};

export function migrateTransportConfig(raw: Record<string, unknown>): { config: TransportConfig | null; error?: string } {
  // v2: no migration needed
  if (raw.schemaVersion === 2) return { config: raw as unknown as TransportConfig };

  const legacy = raw as unknown as LegacyTransportConfig;
  if (!legacy.agents || !legacy.providers) return { config: null, error: "transport.json: missing agents or providers" };

  const professor = legacy.agents["professor"];
  if (!professor) return { config: null, error: "transport.json: agents.professor is required for migration" };

  // Reject tmux — not a selectable route
  const anyTmux = Object.entries(legacy.providers).some(([, p]) => p.transport === "tmux");
  if (anyTmux) return { config: null, error: "transport.json: tmux transport cannot be migrated to a selectable route — manual action required" };

  // Infer route from professor's provider
  const route = inferRouteFromProvider(legacy as unknown as TransportConfig, professor.provider);
  if (!route) return { config: null, error: `transport.json: cannot infer route from professor's provider "${professor.provider}"` };

  // Check all assignments resolve to the same route
  for (const [role, a] of Object.entries(legacy.agents)) {
    const p = legacy.providers[a.provider];
    if (!p) return { config: null, error: `transport.json: agent "${role}" references unknown provider "${a.provider}"` };
    const routeForProvider = inferRouteFromProvider(legacy as unknown as TransportConfig, a.provider);
    if (!routeForProvider || routeForProvider !== route) {
      return { config: null, error: `transport.json: agent "${role}" provider "${a.provider}" incompatible with inferred route "${route}"` };
    }
  }

  // Build top-level fallbacks: professor fallbacks + provider fallbackChain + other agent fallbacks, deduplicated
  const seen = new Set<string>();
  const fallbacks: Array<{ model: string; provider: string }> = [];

  const addFallback = (model: string, provider: string) => {
    const key = `${model}@${provider}`;
    if (seen.has(key)) return;
    seen.add(key);
    fallbacks.push({ model, provider });
  };

  // Professor fallbacks first (preserve order)
  for (const fb of professor.fallbacks ?? []) addFallback(fb.model, fb.provider);
  // Provider fallbackChain
  const profProvider = legacy.providers[professor.provider];
  for (const fbModel of profProvider?.fallbackChain ?? []) addFallback(fbModel, professor.provider);
  // Other agent fallbacks
  for (const a of Object.values(legacy.agents)) {
    for (const fb of a.fallbacks ?? []) addFallback(fb.model, fb.provider);
  }

  // Build new config
  const agents: Record<string, AgentAssignment> = {};
  for (const [role, a] of Object.entries(legacy.agents)) {
    const newRole = role === "professor" ? "main" : role === "coding" ? "cody" : role;
    agents[newRole] = { model: a.model, provider: a.provider };
  }

  const newProviders: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(legacy.providers)) {
    const np: ProviderConfig = { transport: p.transport };
    if (p.cli) np.cli = p.cli;
    if (p.endpoint) np.endpoint = p.endpoint;
    if (p.apiKeyEnv) np.apiKeyEnv = p.apiKeyEnv;
    if (p.apiFormat) np.apiFormat = p.apiFormat;
    if (p.useProviderLib) np.useProviderLib = p.useProviderLib;
    if (p.thinking) np.thinking = p.thinking;
    if (p.defaults) {
      np.defaults = {};
      for (const [k, v] of Object.entries(p.defaults)) {
        np.defaults[k] = { model: v.model };
      }
    }
    newProviders[name] = np;
  }

  return {
    config: {
      schemaVersion: 2,
      route,
      agents,
      providers: newProviders,
      transportDefaults: legacy.transportDefaults,
      maxTurns: legacy.maxTurns,
      maxToolRounds: legacy.maxToolRounds,
      maxFallbackToolRounds: legacy.maxFallbackToolRounds,
      fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
      hailMary: legacy.hailMary,
      healthPolicy: legacy.healthPolicy,
    },
  };
}

// ── Model/provider compatibility (#1415) ─────────────────────────────────────

export type ModelProviderValidation =
  | { ok: true }
  | { ok: false; model: string; provider: string; allowed: string[]; reason: string };

export type AssignmentIssue = {
  location: string;
  model: string;
  provider: string;
  reason: string;
};

/** Validate a single model/provider pair against the catalog.
 *  Returns ok when the model is absent from the catalog (unknown/custom model).
 *  When the entry exists, returns ok only when entry.transports includes the provider. */
export function validateModelProviderPair(
  model: string,
  provider: string,
  models?: ModelCatalog,
): ModelProviderValidation {
  const mc = models ?? loadModels();
  const entry = mc[model];
  if (!entry) return { ok: true };
  if (entry.transports.includes(provider)) return { ok: true };
  return {
    ok: false,
    model,
    provider,
    allowed: [...entry.transports],
    reason: `Model "${model}" is not available on provider "${provider}" — only supported on: ${entry.transports.join(", ")}`,
  };
}

/** Validate every agent primary, fallback, and hail Mary in a transport config.
 *  Reports all issues in deterministic location order. */
export function validateTransportAssignments(
  config: TransportConfig,
  models?: ModelCatalog,
): AssignmentIssue[] {
  const issues: AssignmentIssue[] = [];
  const mc = models ?? loadModels();

  for (const [role, assignment] of Object.entries(config.agents)) {
    const result = validateModelProviderPair(assignment.model, assignment.provider, mc);
    if (!result.ok) {
      issues.push({ location: `${role}.model`, model: assignment.model, provider: assignment.provider, reason: result.reason });
    }
  }

  for (let i = 0; i < (config.fallbacks ?? []).length; i++) {
    const fb = config.fallbacks![i]!;
    const fbResult = validateModelProviderPair(fb.model, fb.provider, mc);
    if (!fbResult.ok) {
      issues.push({ location: `fallbacks[${i}]`, model: fb.model, provider: fb.provider, reason: fbResult.reason });
    }
  }

  if (config.hailMary) {
    const hmResult = validateModelProviderPair(config.hailMary.model, config.hailMary.provider, mc);
    if (!hmResult.ok) {
      issues.push({ location: "hailMary", model: config.hailMary.model, provider: config.hailMary.provider, reason: hmResult.reason });
    }
  }

  return issues;
}

// ── Validation (startup) ────────────────────────────────────────────────────

export function validateAtStartup(): void {
  const tc = loadTransport();
  if (!tc) return;
  const mc = loadModels();

  // #1415: use structured validation for model/provider compatibility
  const issues = validateTransportAssignments(tc, mc);
  for (const iss of issues) {
    logWarn(TAG, `${iss.location}: ${iss.reason}`);
  }

  for (const [role, assignment] of Object.entries(tc.agents)) {
    if (!tc.providers[assignment.provider]) {
      logWarn(TAG, `Agent "${role}": provider "${assignment.provider}" not defined in providers`);
    }
    const modelEntry = mc[assignment.model];
    if (!modelEntry) {
      logWarn(TAG, `Agent "${role}": model "${assignment.model}" not in models.json`);
    }
  }
  for (let i = 0; i < (tc.fallbacks ?? []).length; i++) {
    const fb = tc.fallbacks![i]!;
    if (!tc.providers[fb.provider]) {
      logWarn(TAG, `Fallback[${i}]: provider "${fb.provider}" not defined in providers`);
    }
  }

  // #1311: warn when a provider opts into pi-ai but has no pi mapping (→ stays on models.json).
  for (const [name, provider] of Object.entries(tc.providers)) {
    if (provider.useProviderLib && !mapProviderName(name)) {
      logWarn(TAG, `Provider "${name}" has useProviderLib but no pi-ai mapping — metadata stays on models.json`);
    }
  }
}

/** #1311 C8: true if any provider opts into the pi-ai engine (gates the boot warm). */
export function anyProviderUseProviderLib(tc?: TransportConfig | null): boolean {
  const config = tc ?? loadTransport();
  if (!config) return false;
  return Object.values(config.providers).some(p => p.useProviderLib);
}

// ── Write ───────────────────────────────────────────────────────────────────

export type TransportWriteResult =
  | { ok: true }
  | { ok: false; issues: AssignmentIssue[] };

export function writeTransportConfig(tc: TransportConfig, reason?: string): TransportWriteResult {
  // #1415: reject known-incompatible model/provider pairs before persisting
  const issues = validateTransportAssignments(tc);
  if (issues.length > 0) {
    for (const iss of issues) logWarn(TAG, `Refusing to write — ${iss.reason}`);
    return { ok: false, issues };
  }
  // Guard: reject empty model strings before persisting
  for (const [role, agent] of Object.entries(tc.agents)) {
    if (!agent.model?.trim()) {
      logWarn(TAG, `Refusing to write transport.json — agent "${role}" has empty model`);
      return { ok: false, issues: [{ location: role, model: agent.model ?? "", provider: agent.provider, reason: `empty model string` }] };
    }
  }
  const p = join(configDir(), getEnv().transportConfig);
  // Ensure output has schemaVersion and route without mutating the input
  const output = { ...tc, schemaVersion: 2, route: tc.route || ("direct-api" as ExecutionRoute) };
  // Save current as .old before overwriting (enables /model restore)
  // Only overwrite .old if it's >15min old — preserves last-known-good during rapid changes
  const oldPath = p.replace(".json", ".old.json");
  try {
    const oldAge = Date.now() - statSync(oldPath).mtimeMs;
    if (oldAge > 15 * 60_000) writeFileSync(oldPath, readFileSync(p, "utf-8"), "utf-8");
  } catch { try { writeFileSync(oldPath, readFileSync(p, "utf-8"), "utf-8"); } catch (err) { logAndSwallow(TAG, "backup transport.old.json", err); } }
  writeFileSync(p, JSON.stringify(output, null, 2), "utf-8");
  cachedTransport = output;
  logInfo(TAG, reason ? `transport.json updated — ${reason}` : "transport.json updated");
  return { ok: true };
}

/** Remove demoted models from config. Called on user-initiated model switch.
 *  Models the user just chose are resurrected (demotion cleared). All other demoted entries are deleted. */
export function cleanDemotedModels(tc: TransportConfig, chosenModel?: string): void {
  for (const agent of Object.values(tc.agents)) {
    if ((agent as any).demoted) {
      if (agent.model === chosenModel) { delete (agent as any).demoted; delete (agent as any).demotedReason; delete (agent as any).demotedModel; }
    }
  }
  for (const fb of tc.fallbacks ?? []) {
    if ((fb as any).demoted && fb.model === chosenModel) { delete (fb as any).demoted; delete (fb as any).demotedReason; delete (fb as any).demotedModel; }
  }
}

/** Mark a model as demoted in transport.json. Skipped by candidate loading. Never demotes the last available model for a role. */
export function demoteModel(model: string, reason: "auth" | "timeout"): void {
  const tc = loadTransport();
  if (!tc) return;
  // Guard: don't demote if it's the last non-demoted model for any role
  for (const agent of Object.values(tc.agents)) {
    const all = [agent, ...(tc.fallbacks ?? [])];
    const healthy = all.filter((m: any) => !m.demoted);
    if (healthy.length <= 1 && healthy.some((m: any) => m.model === model)) return;
  }
  let found = false;
  for (const agent of Object.values(tc.agents)) {
    if (agent.model === model) { (agent as any).demoted = new Date().toISOString(); (agent as any).demotedReason = reason; (agent as any).demotedModel = model; found = true; }
  }
  for (const fb of tc.fallbacks ?? []) {
    if (fb.model === model) { (fb as any).demoted = new Date().toISOString(); (fb as any).demotedReason = reason; (fb as any).demotedModel = model; found = true; }
  }
  if (found) writeTransportConfig(tc, `auto-demote ${model} (${reason})`);
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

/** Load a provider's defaults block. Missing subagents inherit main's model. */
export function loadProviderDefaults(providerName: string, tc?: TransportConfig | null): Record<string, { model: string }> | null {
  const config = tc ?? loadTransport();
  if (!config) return null;
  const provider = config.providers[providerName];
  if (!provider?.defaults) return null;
  const defaults = provider.defaults;
  if (!defaults["main"]) return null;
  const mainModel = defaults["main"].model;
  const result: Record<string, { model: string }> = {};
  for (const [k, v] of Object.entries(defaults)) {
    result[k] = { model: v.model };
  }
  for (const role of ["dreamy", "browsie", "cody"]) {
    if (!result[role]) result[role] = { model: mainModel };
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
  const d = cost.display ?? computeCostDisplay(cost);
  const inp = `$${d.inputPer1M}`;
  const out = d.outputPer1M ? `$${d.outputPer1M}` : "$???";
  return `${inp}/${out}`;
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
