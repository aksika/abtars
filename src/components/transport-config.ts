/**
 * transport-config.ts — Load and validate transport.json + models.json.
 * #1466: Read-only loading, pure validation, explicit atomic persistence.
 * Never writes or repairs during loading.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { readEnvWithDefault } from "./env.js";
import { getEnv } from "./env-schema.js";
import { logDebug, logInfo, logWarn } from "./logger.js";
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

export type ExecutionRoute = "pi-ai" | "acp";

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

// ── #1466: Pure validation types ─────────────────────────────────────────────

export type TransportConfigIssueCode =
  | "unsupported_schema"
  | "missing_field"
  | "invalid_route"
  | "missing_provider"
  | "model_provider_incompatible"
  | "provider_route_incompatible"
  | "acp_provider_mismatch";

export interface TransportConfigIssue {
  code: TransportConfigIssueCode;
  path: string;
  message: string;
}

export type TransportValidationResult =
  | { ok: true; config: TransportConfig }
  | { ok: false; issues: readonly TransportConfigIssue[] };

export type TransportConfigSource = "primary" | "backup" | "default";

export type TransportLoadResult =
  | { ok: true; config: TransportConfig; source: TransportConfigSource }
  | { ok: false; issues: readonly TransportConfigIssue[]; state: "missing" | "invalid"; source?: TransportConfigSource };

/**
 * Pure validator — never mutates input, never writes to disk.
 * Returns structured issues for every invariant violation.
 */
export function validateTransportConfig(input: unknown): TransportValidationResult {
  const issues: TransportConfigIssue[] = [];
  const tc = input as Record<string, unknown>;

  // schemaVersion required, must be 2
  if (tc.schemaVersion == null) {
    issues.push({ code: "missing_field", path: "schemaVersion", message: "schemaVersion is required" });
  } else if (tc.schemaVersion !== 2) {
    issues.push({ code: "unsupported_schema", path: "schemaVersion", message: `Unsupported schema version ${tc.schemaVersion} — only version 2 is supported` });
  }

  // route required, must be a valid ExecutionRoute
  if (tc.route == null) {
    issues.push({ code: "missing_field", path: "route", message: "route is required" });
  } else if (tc.route !== "pi-ai" && tc.route !== "acp") {
    issues.push({ code: "invalid_route", path: "route", message: `Invalid route "${String(tc.route)}" — must be "pi-ai" or "acp"` });
  }

  // agents required
  if (tc.agents == null || typeof tc.agents !== "object") {
    issues.push({ code: "missing_field", path: "agents", message: "agents is required" });
  }

  // providers required
  if (tc.providers == null || typeof tc.providers !== "object") {
    issues.push({ code: "missing_field", path: "providers", message: "providers is required" });
  }

  if (issues.length > 0) return { ok: false, issues };

  const config = input as TransportConfig;
  const route = config.route;
  const providers = config.providers;

  // Validate every agent references an existing provider
  for (const [role, assignment] of Object.entries(config.agents)) {
    if (!assignment || typeof assignment !== "object") {
      issues.push({ code: "missing_field", path: `agents.${role}`, message: `Agent "${role}" has invalid assignment` });
      continue;
    }
    const provider = (assignment as Record<string, unknown>).provider;
    if (typeof provider !== "string") {
      issues.push({ code: "missing_field", path: `agents.${role}.provider`, message: `Agent "${role}" has no provider` });
      continue;
    }
    const p = providers[provider];
    if (!p) {
      issues.push({ code: "missing_provider", path: `agents.${role}.provider`, message: `Agent "${role}" references unknown provider "${assignment.provider}"` });
      continue;
    }
    // Validate provider supports the route
    if (!providerSupportsRoute(p, route)) {
      issues.push({ code: "provider_route_incompatible", path: `agents.${role}`, message: `Agent "${role}" provider "${assignment.provider}" does not support route "${route}"` });
    }
  }

  // Validate fallbacks reference existing providers and support the route
  for (let i = 0; i < (config.fallbacks ?? []).length; i++) {
    const fb = config.fallbacks![i];
    if (!fb || typeof fb !== "object") {
      issues.push({ code: "missing_field", path: `fallbacks[${i}]`, message: `Fallback[${i}] is invalid` });
      continue;
    }
    const p = providers[fb.provider];
    if (!p) {
      issues.push({ code: "missing_provider", path: `fallbacks[${i}].provider`, message: `Fallback[${i}] references unknown provider "${fb.provider}"` });
    } else if (!providerSupportsRoute(p, route)) {
      issues.push({ code: "provider_route_incompatible", path: `fallbacks[${i}]`, message: `Fallback[${i}] provider "${fb.provider}" does not support route "${route}"` });
    }
  }

  // ACP same-provider rule
  if (route === "acp") {
    const entries = Object.values(config.agents);
    if (entries.length > 0) {
      const first = entries[0]!.provider;
      for (let i = 1; i < entries.length; i++) {
        if (entries[i]!.provider !== first) {
          issues.push({ code: "acp_provider_mismatch", path: `agents.${Object.keys(config.agents)[i]}`, message: `ACP requires all agents use the same provider ("${first}")` });
        }
      }
    }
  }

  // Model/provider compatibility (warns only — non-fatal when catalog entry missing)
  const models = loadModels();
  for (const [role, assignment] of Object.entries(config.agents)) {
    const entry = models[assignment.model];
    if (entry && !entry.transports.includes(assignment.provider)) {
      issues.push({ code: "model_provider_incompatible", path: `agents.${role}`, message: `Model "${assignment.model}" not available on provider "${assignment.provider}" — only supported on: ${entry.transports.join(", ")}` });
    }
  }
  for (let i = 0; i < (config.fallbacks ?? []).length; i++) {
    const fb = config.fallbacks![i]!;
    const entry = models[fb.model];
    if (entry && !entry.transports.includes(fb.provider)) {
      issues.push({ code: "model_provider_incompatible", path: `fallbacks[${i}]`, message: `Model "${fb.model}" not available on provider "${fb.provider}" — only supported on: ${entry.transports.join(", ")}` });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, config };
}

// ── Loaders ─────────────────────────────────────────────────────────────────

let cachedTransport: TransportConfig | null = null;
let cachedSource: TransportConfigSource | null = null;

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

/**
 * Load transport config with structured result.
 * Never writes to disk, never mutates input, never auto-repairs.
 */
export function loadTransportStructured(): TransportLoadResult {
  if (cachedTransport && cachedSource) {
    const vr = validateTransportConfig(cachedTransport);
    if (!vr.ok) {
      cachedTransport = null;
      cachedSource = null;
      return { ok: false, issues: vr.issues, state: "invalid" };
    }
    return { ok: true, config: vr.config, source: cachedSource };
  }

  const dir = configDir();
  const p = join(dir, getEnv().transportConfig);

  // Try primary — distinguish file-not-found from corrupt content
  const primaryExists = existsSync(p);
  if (primaryExists) {
    const primaryData = tryParseJson(p);
    if (primaryData) {
      const vr = validateTransportConfig(primaryData);
      if (vr.ok) {
        cachedTransport = vr.config;
        cachedSource = "primary";
        return { ok: true, config: vr.config, source: "primary" };
      }
      // Primary exists but is invalid — don't fall through to backup/emergency
      cachedTransport = null;
      cachedSource = null;
      return { ok: false, issues: vr.issues, state: "invalid", source: "primary" };
    }
    // File exists but could not be parsed — treat as invalid, not missing
    cachedTransport = null;
    cachedSource = null;
    const parseIssue: TransportConfigIssue = {
      code: "unsupported_schema",
      path: "transport.json",
      message: `Failed to parse ${p}`,
    };
    return { ok: false, issues: [parseIssue], state: "invalid", source: "primary" };
  }

  // Try backup
  const oldPath = p.replace(".json", ".old.json");
  const backupData = tryParseJson(oldPath);
  if (backupData) {
    const vr = validateTransportConfig(backupData);
    if (vr.ok) {
      cachedTransport = vr.config;
      cachedSource = "backup";
      logWarn(TAG, `transport.json missing — using transport.old.json as in-memory source`);
      return { ok: true, config: vr.config, source: "backup" };
    }
  }

  // Try default template
  const defaultPath = join(dir, "transport.default.json");
  const defaultData = tryParseJson(defaultPath);
  if (defaultData) {
    const vr = validateTransportConfig(defaultData);
    if (vr.ok) {
      cachedTransport = vr.config;
      cachedSource = "default";
      logWarn(TAG, `transport.json missing — using transport.default.json as in-memory source`);
      return { ok: true, config: vr.config, source: "default" };
    }
  }

  return { ok: false, issues: [], state: "missing" };
}

/** Try to parse a JSON file. Returns null if file doesn't exist or is unreadable. Never writes, never migrates. */
function tryParseJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    logDebug(TAG, `Failed to load ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Backward-compatible loadTransport for existing callers.
 * Returns null when no valid config is available.
 * Never writes, never mutates, never auto-repairs.
 */
export function loadTransport(): TransportConfig | null {
  const result = loadTransportStructured();
  if (result.ok) {
    logInfo(TAG, `Loaded transport config v${result.config.schemaVersion ?? 2} (route: ${result.config.route}, source: ${result.source})`);
    return result.config;
  }
  return null;
}

/** Clear in-memory cache only (no disk writes). */
export function clearTransportCache(): void {
  cachedTransport = null;
  cachedSource = null;
}

/** Resolve hailMary from transport.json. Returns null if not configured. */
export function resolveHailMary(transport?: TransportConfig | null): { model: string; endpoint: string; apiKeyEnv?: string } | null {
  const tc = transport ?? loadTransport();
  if (!tc?.hailMary) return null;
  const provider = tc.providers[tc.hailMary.provider];
  if (!provider?.endpoint) return null;
  return { model: tc.hailMary.model, endpoint: provider.endpoint, apiKeyEnv: provider.apiKeyEnv };
}

// ── Invariant validation ────────────────────────────────────────────────────
// #1466: replaced by pure validateTransportConfig() — no mutation, no repair.

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
  // Pi catalog metadata lookup (all API providers route through Pi)
  const piMeta = resolveModelMeta(effectiveModel, effectiveProvider);
  if (piMeta) { contextWindow = piMeta.contextWindow; maxOutput = piMeta.maxOutput; }

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
  if (route === "pi-ai") return provider.transport === "api";
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

  // #1311: warn when a provider has no pi catalog mapping (metadata stays on models.json).
  for (const [name, provider] of Object.entries(tc.providers)) {
    if (provider.transport === "api" && !mapProviderName(name)) {
      logWarn(TAG, `Provider "${name}" has no pi-ai mapping — metadata stays on models.json`);
    }
  }
}

/** #1311 C8: true if any provider opts into the pi-ai engine (gates the boot warm). */
export function anyProviderUseProviderLib(tc?: TransportConfig | null): boolean {
  const config = tc ?? loadTransport();
  if (!config) return false;
  return Object.values(config.providers).some(p => p.transport === "api");
}

// ── Write ───────────────────────────────────────────────────────────────────

export type TransportWriteResult =
  | { ok: true }
  | { ok: false; issues: AssignmentIssue[] };

export function writeTransportConfig(candidate: TransportConfig, reason: string): TransportWriteResult {
  // Validate the complete candidate — use a detached deep copy so input mutation
  // doesn't leak into validation, and failed writes leave the cache unchanged.
  const candidateCopy = JSON.parse(JSON.stringify(candidate)) as TransportConfig;
  const vr = validateTransportConfig(candidateCopy);
  if (!vr.ok) {
    const issues: AssignmentIssue[] = vr.issues.map(i => ({ location: i.path, model: "", provider: "", reason: i.message }));
    for (const iss of issues) logWarn(TAG, `Refusing to write — ${iss.reason}`);
    return { ok: false, issues };
  }
  // #1415: reject known-incompatible model/provider pairs before persisting
  const compatIssues = validateTransportAssignments(vr.config);
  if (compatIssues.length > 0) {
    for (const iss of compatIssues) logWarn(TAG, `Refusing to write — ${iss.reason}`);
    return { ok: false, issues: compatIssues };
  }
  // Guard: reject empty model strings before persisting
  for (const [role, agent] of Object.entries(vr.config.agents)) {
    if (!agent.model?.trim()) {
      logWarn(TAG, `Refusing to write transport.json — agent "${role}" has empty model`);
      return { ok: false, issues: [{ location: role, model: agent.model ?? "", provider: agent.provider, reason: `empty model string` }] };
    }
  }

  const p = join(configDir(), getEnv().transportConfig);
  const oldPath = p.replace(".json", ".old.json");

  // Read current primary bytes for backup (before any mutation)
  let currentBytes: string | null = null;
  try { currentBytes = readFileSync(p, "utf-8"); } catch { /* no existing primary */ }

  // Serialize candidate deterministically (use validated config, not raw input)
  const content = JSON.stringify(vr.config, null, 2);

  // Write both candidate and backup to temp files, then rename in order.
  // Primary rename happens FIRST so a failure leaves oldTmp/oldPath untouched.
  // Backup rename happens SECOND (best-effort; on failure primary is already correct).
  const tmp = p + ".tmp." + process.pid;
  const oldTmp = oldPath + ".tmp." + process.pid;
  try {
    writeFileSync(tmp, content, "utf-8");

    if (currentBytes !== null) {
      writeFileSync(oldTmp, currentBytes, "utf-8");
    }

    // Commit primary FIRST
    renameSync(tmp, p);

    // Commit backup SECOND (best-effort — primary is already safe)
    if (currentBytes !== null) {
      try { renameSync(oldTmp, oldPath); } catch { /* best effort */ }
    }

    cachedTransport = vr.config;
    cachedSource = "primary";
    logInfo(TAG, reason ? `transport.json updated — ${reason}` : "transport.json updated");
    return { ok: true };
  } catch (err) {
    // Primary rename failed: restore oldTmp to oldPath to preserve prior pair
    if (currentBytes !== null) {
      try { if (existsSync(oldTmp)) renameSync(oldTmp, oldPath); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    try { unlinkSync(oldTmp); } catch { /* best effort */ }
    logWarn(TAG, `Failed to write transport.json: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, issues: [{ location: "write", model: "", provider: "", reason: `Write failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }
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
  // Work on a detached candidate — never mutate the cached object
  const candidate = JSON.parse(JSON.stringify(tc)) as TransportConfig;
  // Guard: don't demote if it's the last non-demoted model for any role
  for (const agent of Object.values(candidate.agents)) {
    const all = [agent, ...(candidate.fallbacks ?? [])];
    const healthy = all.filter((m: any) => !m.demoted);
    if (healthy.length <= 1 && healthy.some((m: any) => m.model === model)) return;
  }
  let found = false;
  for (const agent of Object.values(candidate.agents)) {
    if (agent.model === model) { (agent as any).demoted = new Date().toISOString(); (agent as any).demotedReason = reason; (agent as any).demotedModel = model; found = true; }
  }
  for (const fb of candidate.fallbacks ?? []) {
    if (fb.model === model) { (fb as any).demoted = new Date().toISOString(); (fb as any).demotedReason = reason; (fb as any).demotedModel = model; found = true; }
  }
  if (found) writeTransportConfig(candidate, `auto-demote ${model} (${reason})`);
}

/** Swap transport.json ↔ transport.json.old (undo last write). Rollback-safe. */
export function restorePrevious(): { ok: boolean; error?: string } {
  const dir = configDir();
  const activePath = join(dir, getEnv().transportConfig);
  const oldPath = activePath.replace(".json", ".old.json");
  if (!existsSync(oldPath)) return { ok: false, error: "Nothing to restore — no previous config saved." };
  try {
    const current = readFileSync(activePath, "utf-8");
    const old = readFileSync(oldPath, "utf-8");
    // Validate the backup before swapping
    const oldParsed = JSON.parse(old) as Record<string, unknown>;
    const vr = validateTransportConfig(oldParsed);
    if (!vr.ok) {
      return { ok: false, error: `Backup config is invalid — cannot restore. Issues: ${vr.issues.map(i => i.message).join("; ")}` };
    }
    // Temp-file swap: write both to temps, then rename safely
    const tmp = activePath + ".tmp." + process.pid;
    const oldTmp = oldPath + ".tmp." + process.pid;
    writeFileSync(tmp, old, "utf-8");
    writeFileSync(oldTmp, current, "utf-8");
    renameSync(oldTmp, oldPath);
    renameSync(tmp, activePath);
    cachedTransport = null;
    cachedSource = null;
    logInfo(TAG, "transport.json swapped with .old (restore)");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Copy transport.default.json → transport.json atomically, backup current first. */
export function resetToDefaults(): boolean {
  const dir = configDir();
  const defaultPath = join(dir, "transport.default.json");
  const activePath = join(dir, getEnv().transportConfig);
  const oldPath = activePath.replace(".json", ".old.json");
  try {
    // Validate defaults before swapping
    const defaultRaw = readFileSync(defaultPath, "utf-8");
    const defaultParsed = JSON.parse(defaultRaw) as Record<string, unknown>;
    const vr = validateTransportConfig(defaultParsed);
    if (!vr.ok) {
      logWarn(TAG, `transport.default.json is invalid — keeping current config. Issues: ${vr.issues.map(i => i.message).join("; ")}`);
      return false;
    }
    // Backup current via temp, then atomic swap (primary first, backup second)
    const oldTmp = oldPath + ".tmp." + process.pid;
    const tmp = activePath + ".tmp." + process.pid;
    let haveBackup = false;
    try { writeFileSync(oldTmp, readFileSync(activePath, "utf-8"), "utf-8"); haveBackup = true; } catch { /* no prior primary to back up */ }
    writeFileSync(tmp, defaultRaw, "utf-8");
    // Commit primary first
    renameSync(tmp, activePath);
    // Commit backup second (best-effort)
    if (haveBackup) { try { renameSync(oldTmp, oldPath); } catch { /* best effort */ } }
    cachedTransport = null;
    cachedSource = null;
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
