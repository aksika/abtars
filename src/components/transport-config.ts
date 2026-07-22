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

export type RouteAssignments = {
  agents: Record<string, AgentAssignment>;
  fallbacks?: Array<{ model: string; provider: string }>;
};

export type HailMaryConfig = {
  route: "acp";
  model: string;
  provider: string;
};

export type ResolvedHailMary = HailMaryConfig & {
  cli?: string;
  endpoint?: string;
  apiKeyEnv?: string;
};

export type TransportConfig = {
  schemaVersion: 3;
  activeRoute: ExecutionRoute;
  routes: Partial<Record<ExecutionRoute, RouteAssignments>>;
  providers: Record<string, ProviderConfig>;
  transportDefaults?: TransportDefaults;
  maxTurns?: number;
  maxToolRounds?: number;
  /** #1386: Lower tool-round limit for fallback candidates. Default 5. */
  maxFallbackToolRounds?: number;
  hailMary?: HailMaryConfig;
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

// ── Route-local accessors (#1467) ─────────────────────────────────────────────

export function routeAssignments(
  config: TransportConfig,
  route: ExecutionRoute = config.activeRoute,
): RouteAssignments | null {
  return config.routes[route] ?? null;
}

export function requireRouteAssignments(
  config: TransportConfig,
  route: ExecutionRoute = config.activeRoute,
): RouteAssignments {
  const ra = routeAssignments(config, route);
  if (!ra) throw new Error(`Route "${route}" has no assignments block in transport config`);
  return ra;
}

/**
 * Pure validator — never mutates input, never writes to disk.
 * Returns structured issues for every invariant violation.
 */
export function validateTransportConfig(input: unknown): TransportValidationResult {
  const issues: TransportConfigIssue[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ code: "missing_field", path: "", message: "Transport config must be an object" }],
    };
  }
  const tc = input as Record<string, unknown>;

  // schemaVersion required, must be 3
  if (tc.schemaVersion == null) {
    issues.push({ code: "missing_field", path: "schemaVersion", message: "schemaVersion is required" });
  } else if (tc.schemaVersion !== 3) {
    issues.push({ code: "unsupported_schema", path: "schemaVersion", message: `Unsupported schema version ${tc.schemaVersion} — only version 3 is supported` });
  }

  // activeRoute required, must be a valid ExecutionRoute
  if (tc.activeRoute == null) {
    issues.push({ code: "missing_field", path: "activeRoute", message: "activeRoute is required" });
  } else if (tc.activeRoute !== "pi-ai" && tc.activeRoute !== "acp") {
    issues.push({ code: "invalid_route", path: "activeRoute", message: `Invalid activeRoute "${String(tc.activeRoute)}" — must be "pi-ai" or "acp"` });
  }

  // routes required
  if (tc.routes == null || typeof tc.routes !== "object" || Array.isArray(tc.routes)) {
    issues.push({ code: "missing_field", path: "routes", message: "routes is required" });
  }

  // providers required
  if (tc.providers == null || typeof tc.providers !== "object" || Array.isArray(tc.providers)) {
    issues.push({ code: "missing_field", path: "providers", message: "providers is required" });
  }

  if (issues.length > 0) return { ok: false, issues };

  const config = input as TransportConfig;
  const providers = config.providers;
  const activeRoute = config.activeRoute;

  // Reject unknown route keys in routes object
  for (const routeKey of Object.keys(config.routes)) {
    if (routeKey !== "pi-ai" && routeKey !== "acp") {
      issues.push({ code: "invalid_route", path: `routes.${routeKey}`, message: `Unknown route "${routeKey}" — only "pi-ai" and "acp" are supported` });
    }
  }

  // Require the active route block to exist
  if (!config.routes[activeRoute]) {
    issues.push({ code: "missing_field", path: `routes.${activeRoute}`, message: `Active route "${activeRoute}" has no assignments block` });
  }

  if (issues.length > 0) return { ok: false, issues };

  // Validate each present route block independently
  const validateRouteBlock = (routeKey: string, ra: RouteAssignments) => {
    const prefix = `routes.${routeKey}`;

    if (ra.agents == null || typeof ra.agents !== "object" || Array.isArray(ra.agents)) {
      issues.push({ code: "missing_field", path: `${prefix}.agents`, message: `Route "${routeKey}" has no agents block` });
      return;
    }

    for (const [role, assignment] of Object.entries(ra.agents)) {
      if (!assignment || typeof assignment !== "object") {
        issues.push({ code: "missing_field", path: `${prefix}.agents.${role}`, message: `Agent "${role}" in route "${routeKey}" has invalid assignment` });
        continue;
      }
      const assignmentRecord = assignment as Record<string, unknown>;
      const model = assignmentRecord.model;
      const providerName = assignmentRecord.provider;
      if (typeof model !== "string" || !model.trim()) {
        issues.push({ code: "missing_field", path: `${prefix}.agents.${role}.model`, message: `Agent "${role}" in route "${routeKey}" has no model` });
      }
      if (typeof providerName !== "string") {
        issues.push({ code: "missing_field", path: `${prefix}.agents.${role}.provider`, message: `Agent "${role}" in route "${routeKey}" has no provider` });
        continue;
      }
      const p = providers[providerName];
      if (!p) {
        issues.push({ code: "missing_provider", path: `${prefix}.agents.${role}`, message: `Agent "${role}" in route "${routeKey}" references unknown provider "${providerName}"` });
        continue;
      }
      if (!providerSupportsRoute(p, routeKey as ExecutionRoute)) {
        issues.push({ code: "provider_route_incompatible", path: `${prefix}.agents.${role}`, message: `Agent "${role}" in route "${routeKey}" provider "${providerName}" does not support route "${routeKey}"` });
      }
    }

    if (ra.fallbacks != null && !Array.isArray(ra.fallbacks)) {
      issues.push({ code: "missing_field", path: `${prefix}.fallbacks`, message: `fallbacks in route "${routeKey}" must be an array` });
      return;
    }

    for (let i = 0; i < (ra.fallbacks ?? []).length; i++) {
      const fb = ra.fallbacks![i];
      if (!fb || typeof fb !== "object") {
        issues.push({ code: "missing_field", path: `${prefix}.fallbacks[${i}]`, message: `Fallback[${i}] in route "${routeKey}" is invalid` });
        continue;
      }
      if (typeof fb.model !== "string" || !fb.model.trim()) {
        issues.push({ code: "missing_field", path: `${prefix}.fallbacks[${i}].model`, message: `Fallback[${i}] in route "${routeKey}" has no model` });
      }
      if (typeof fb.provider !== "string") {
        issues.push({ code: "missing_field", path: `${prefix}.fallbacks[${i}].provider`, message: `Fallback[${i}] in route "${routeKey}" has no provider` });
        continue;
      }
      const p = providers[fb.provider];
      if (!p) {
        issues.push({ code: "missing_provider", path: `${prefix}.fallbacks[${i}]`, message: `Fallback[${i}] in route "${routeKey}" references unknown provider "${fb.provider}"` });
      } else if (!providerSupportsRoute(p, routeKey as ExecutionRoute)) {
        issues.push({ code: "provider_route_incompatible", path: `${prefix}.fallbacks[${i}]`, message: `Fallback[${i}] in route "${routeKey}" provider "${fb.provider}" does not support route "${routeKey}"` });
      }
    }
  };

  for (const [routeKey, ra] of Object.entries(config.routes)) {
    if (ra) validateRouteBlock(routeKey, ra);
  }

  if (issues.length > 0) return { ok: false, issues };

  // ACP same-provider rule — scoped to routes.acp only
  const acpRa = config.routes["acp"];
  if (acpRa) {
    const entries = Object.values(acpRa.agents);
    if (entries.length > 0) {
      const first = entries[0]!.provider;
      for (let i = 1; i < entries.length; i++) {
        if (entries[i]!.provider !== first) {
          issues.push({ code: "acp_provider_mismatch", path: `routes.acp.agents.${Object.keys(acpRa.agents)[i]}`, message: `ACP requires all agents use the same provider ("${first}")` });
        }
      }
    }
  }

  // Validate hailMary when present
  if (tc.hailMary != null) {
    const hm = tc.hailMary as Record<string, unknown>;
    if (hm.route !== "acp") {
      issues.push({ code: "invalid_route", path: "hailMary.route", message: `hailMary route must be "acp", got "${String(hm.route)}"` });
    }
    if (typeof hm.provider !== "string") {
      issues.push({ code: "missing_field", path: "hailMary.provider", message: "hailMary provider is required" });
    } else {
      const p = providers[hm.provider as string];
      if (!p) {
        issues.push({ code: "missing_provider", path: "hailMary.provider", message: `hailMary references unknown provider "${hm.provider}"` });
      } else if (!providerSupportsRoute(p, "acp")) {
        issues.push({ code: "provider_route_incompatible", path: "hailMary.route", message: `hailMary provider "${hm.provider}" does not support ACP route` });
      }
    }
    if (typeof hm.model !== "string" || !(hm.model as string).trim()) {
      issues.push({ code: "missing_field", path: "hailMary.model", message: "hailMary model is required" });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // Model/provider compatibility (warns only — non-fatal when catalog entry missing)
  const models = loadModels();
  for (const [routeKey, ra] of Object.entries(config.routes)) {
    if (!ra) continue;
    const prefix = `routes.${routeKey}`;
    for (const [role, assignment] of Object.entries(ra.agents)) {
      const entry = models[assignment.model];
      if (entry && !entry.transports.includes(assignment.provider)) {
        issues.push({ code: "model_provider_incompatible", path: `${prefix}.agents.${role}`, message: `Model "${assignment.model}" not available on provider "${assignment.provider}" in route "${routeKey}" — only supported on: ${entry.transports.join(", ")}` });
      }
    }
    for (let i = 0; i < (ra.fallbacks ?? []).length; i++) {
      const fb = ra.fallbacks![i]!;
      const entry = models[fb.model];
      if (entry && !entry.transports.includes(fb.provider)) {
        issues.push({ code: "model_provider_incompatible", path: `${prefix}.fallbacks[${i}]`, message: `Model "${fb.model}" not available on provider "${fb.provider}" in route "${routeKey}" — only supported on: ${entry.transports.join(", ")}` });
      }
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
    logInfo(TAG, `Loaded transport config v${result.config.schemaVersion} (activeRoute: ${result.config.activeRoute}, source: ${result.source})`);
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
export function resolveHailMary(transport?: TransportConfig | null): ResolvedHailMary | null {
  const tc = transport ?? loadTransport();
  if (!tc?.hailMary) return null;
  const provider = tc.providers[tc.hailMary.provider];
  if (!provider) return null;
  return {
    ...tc.hailMary,
    cli: provider.cli,
    endpoint: provider.endpoint,
    apiKeyEnv: provider.apiKeyEnv,
  };
}

/** Route-specific hailMary boundary: #1468 owns the emergency execution path. */

// ── Invariant validation ────────────────────────────────────────────────────
// #1466: replaced by pure validateTransportConfig() — no mutation, no repair.

// ── Resolution ──────────────────────────────────────────────────────────────

export function resolveAgent(role: string, transport?: TransportConfig | null, models?: ModelCatalog, lastSuccessfulMain?: { model: string; provider: string } | null, explicitRoute?: ExecutionRoute): ResolvedAgent | null {
  const tc = transport ?? loadTransport();
  if (!tc) return null;

  const ra = routeAssignments(tc, explicitRoute);
  if (!ra) {
    logWarn(TAG, `No route assignments for role "${role}"`);
    return null;
  }

  // task inherits main
  const effectiveRole = role === "task" ? "main" : role;
  const assignment = ra.agents[effectiveRole];
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

  // Build fallback list: route-local fallbacks (filtered), plus last successful Main for specialists
  const seen = new Set<string>();
  const fallbackList: Array<{ model: string; provider: string }> = [];

  // For specialists, prepend last successful Main (or configured Main) before route-local fallbacks
  if (role !== "main" && role !== "task") {
    const mainAssignment = ra.agents["main"];
    const lastMain = lastSuccessfulMain ?? { model: mainAssignment?.model ?? "", provider: mainAssignment?.provider ?? "" };
    if (lastMain.model && lastMain.provider) {
      const key = `${lastMain.model}@${lastMain.provider}`;
      seen.add(key);
      fallbackList.push(lastMain);
    }
  }

  // Append route-local fallbacks, filtering demoted and self-duplicates
  for (const fb of ra.fallbacks ?? []) {
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

export function allAssignmentsMatchRoute(config: TransportConfig, route: ExecutionRoute): boolean {
  const ra = routeAssignments(config, route);
  if (!ra) return false;
  for (const assignment of Object.values(ra.agents)) {
    const p = config.providers[assignment.provider];
    if (!p || !providerSupportsRoute(p, route)) return false;
  }
  for (const fb of ra.fallbacks ?? []) {
    const p = config.providers[fb.provider];
    if (!p || !providerSupportsRoute(p, route)) return false;
  }
  return true;
}

/** Return the first unavailable provider used anywhere by a route block. */
export function validateRouteProvidersReady(
  config: TransportConfig,
  route: ExecutionRoute,
  env: EnvAccessor,
): { providerName: string; result: ProviderValidationResult } | null {
  const assignments = routeAssignments(config, route);
  if (!assignments) return null;

  const providerNames = new Set<string>([
    ...Object.values(assignments.agents).map(a => a.provider),
    ...(assignments.fallbacks ?? []).map(f => f.provider),
  ]);
  for (const providerName of providerNames) {
    const provider = config.providers[providerName];
    if (!provider) {
      return {
        providerName,
        result: {
          ok: false,
          reason: `Provider "${providerName}" is not defined in transport.json`,
          fix: `Add provider "${providerName}" to transport.json`,
        },
      };
    }
    const result = validateProviderReady(providerName, provider, env);
    if (!result.ok) return { providerName, result };
  }
  return null;
}

export function acpSameProviderConstraint(config: TransportConfig): boolean {
  // ACP requires all agents to use the same provider (single child process)
  const acpRa = config.routes["acp"];
  if (!acpRa) return true;
  const first = Object.values(acpRa.agents)[0];
  if (!first) return true;
  return Object.values(acpRa.agents).every(a => a.provider === first.provider);
}

// ── Schema migration (#1418) — deleted in #1467 (v3 hard cut, no migration) ──

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
  explicitRoute?: ExecutionRoute,
): AssignmentIssue[] {
  const issues: AssignmentIssue[] = [];
  const mc = models ?? loadModels();

  // Validate active route block (or the explicit route if given) + hailMary
  const route = explicitRoute ?? config.activeRoute;
  const ra = routeAssignments(config, route);
  if (ra) {
    for (const [role, assignment] of Object.entries(ra.agents)) {
      const result = validateModelProviderPair(assignment.model, assignment.provider, mc);
      if (!result.ok) {
        issues.push({ location: `${route}.agents.${role}.model`, model: assignment.model, provider: assignment.provider, reason: result.reason });
      }
    }
    for (let i = 0; i < (ra.fallbacks ?? []).length; i++) {
      const fb = ra.fallbacks![i]!;
      const fbResult = validateModelProviderPair(fb.model, fb.provider, mc);
      if (!fbResult.ok) {
        issues.push({ location: `${route}.fallbacks[${i}]`, model: fb.model, provider: fb.provider, reason: fbResult.reason });
      }
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

  for (const [routeKey, ra] of Object.entries(tc.routes)) {
    if (!ra) continue;
    for (const [role, assignment] of Object.entries(ra.agents)) {
      if (!tc.providers[assignment.provider]) {
        logWarn(TAG, `Route "${routeKey}" Agent "${role}": provider "${assignment.provider}" not defined in providers`);
      }
      const modelEntry = mc[assignment.model];
      if (!modelEntry) {
        logWarn(TAG, `Route "${routeKey}" Agent "${role}": model "${assignment.model}" not in models.json`);
      }
    }
    for (let i = 0; i < (ra.fallbacks ?? []).length; i++) {
      const fb = ra.fallbacks![i]!;
      if (!tc.providers[fb.provider]) {
        logWarn(TAG, `Route "${routeKey}" Fallback[${i}]: provider "${fb.provider}" not defined in providers`);
      }
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
  if (typeof reason !== "string" || !reason.trim()) {
    return { ok: false, issues: [{ location: "reason", model: "", provider: "", reason: "A non-empty mutation reason is required" }] };
  }
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
  // Guard: reject empty model strings in the active route block
  const activeRa = routeAssignments(vr.config);
  if (activeRa) {
    for (const [role, agent] of Object.entries(activeRa.agents)) {
      if (!agent.model?.trim()) {
        logWarn(TAG, `Refusing to write transport.json — agent "${role}" has empty model`);
        return { ok: false, issues: [{ location: role, model: agent.model ?? "", provider: agent.provider, reason: `empty model string` }] };
      }
    }
  }

  const p = join(configDir(), getEnv().transportConfig);
  const oldPath = p.replace(".json", ".old.json");

  // Read current primary bytes for backup (before any mutation)
  let currentBytes: string | null = null;
  try { currentBytes = readFileSync(p, "utf-8"); } catch { /* no existing primary */ }

  // Serialize candidate deterministically (use validated config, not raw input)
  const content = JSON.stringify(vr.config, null, 2);

  const tmp = p + ".tmp." + process.pid;
  const oldTmp = oldPath + ".tmp." + process.pid;
  const rollbackPrimaryTmp = p + ".rollback." + process.pid;
  const rollbackOldTmp = oldPath + ".rollback." + process.pid;
  let primaryCommitted = false;
  let backupAttempted = false;
  const oldBackupExists = existsSync(oldPath);
  try {
    if (oldBackupExists) {
      writeFileSync(rollbackOldTmp, readFileSync(oldPath, "utf-8"), "utf-8");
    }
    writeFileSync(tmp, content, "utf-8");

    if (currentBytes !== null) {
      writeFileSync(oldTmp, currentBytes, "utf-8");
      writeFileSync(rollbackPrimaryTmp, currentBytes, "utf-8");
    }

    renameSync(tmp, p);
    primaryCommitted = true;

    if (currentBytes !== null) {
      backupAttempted = true;
      renameSync(oldTmp, oldPath);
    }

    cachedTransport = vr.config;
    cachedSource = "primary";
    try { unlinkSync(rollbackPrimaryTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    logInfo(TAG, `transport.json updated — ${reason}`);
    return { ok: true };
  } catch (err) {
    // If backup commit was attempted, restore the previous backup (or its
    // absence). If primary commit succeeded, restore the previous primary too.
    if (backupAttempted) {
      try {
        if (oldBackupExists) renameSync(rollbackOldTmp, oldPath);
        else if (existsSync(oldPath)) unlinkSync(oldPath);
      } catch { /* best effort */ }
    }
    if (primaryCommitted && currentBytes !== null) {
      try { renameSync(rollbackPrimaryTmp, p); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    try { unlinkSync(oldTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackPrimaryTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    logWarn(TAG, `Failed to write transport.json: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, issues: [{ location: "write", model: "", provider: "", reason: `Write failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

/** Remove demoted models from config. Called on user-initiated model switch.
 *  Models the user just chose are resurrected (demotion cleared). All other demoted entries are deleted.
 *  Defaults to the active route only — never bleeds into inactive routes. Use explicitRoute list for bulk cleanup. */
export function cleanDemotedModels(tc: TransportConfig, chosenModel?: string, explicitRoute?: ExecutionRoute): void {
  const routesToClean = explicitRoute ? [explicitRoute] : ([tc.activeRoute] as ExecutionRoute[]);
  for (const r of routesToClean) {
    const ra = tc.routes[r];
    if (!ra) continue;
    for (const agent of Object.values(ra.agents)) {
      if ((agent as any).demoted) {
        if (agent.model === chosenModel) { delete (agent as any).demoted; delete (agent as any).demotedReason; delete (agent as any).demotedModel; }
      }
    }
    for (const fb of ra.fallbacks ?? []) {
      if ((fb as any).demoted && fb.model === chosenModel) { delete (fb as any).demoted; delete (fb as any).demotedReason; delete (fb as any).demotedModel; }
    }
  }
}

/** Mark a model as demoted in transport.json. Skipped by candidate loading. Never demotes the last available model for a role. */
export function demoteModel(model: string, reason: "auth" | "timeout"): void {
  const tc = loadTransport();
  if (!tc) return;
  // Work on a detached candidate — never mutate the cached object
  const candidate = JSON.parse(JSON.stringify(tc)) as TransportConfig;
  // Guard: don't demote if it's the last non-demoted model for any role
  const activeRa = routeAssignments(candidate);
  if (activeRa) {
    for (const agent of Object.values(activeRa.agents)) {
      const all = [agent, ...(activeRa.fallbacks ?? [])];
      const healthy = all.filter((m: any) => !m.demoted);
      if (healthy.length <= 1 && healthy.some((m: any) => m.model === model)) return;
    }
  }
  let found = false;
  if (activeRa) {
    for (const agent of Object.values(activeRa.agents)) {
      if (agent.model === model) { (agent as any).demoted = new Date().toISOString(); (agent as any).demotedReason = reason; (agent as any).demotedModel = model; found = true; }
    }
    for (const fb of activeRa.fallbacks ?? []) {
      if (fb.model === model) { (fb as any).demoted = new Date().toISOString(); (fb as any).demotedReason = reason; (fb as any).demotedModel = model; found = true; }
    }
  }
  if (found) writeTransportConfig(candidate, `auto-demote ${model} (${reason})`);
}

/** Swap transport.json ↔ transport.json.old (undo last write). Rollback-safe. */
export function restorePrevious(): { ok: boolean; error?: string } {
  const dir = configDir();
  const activePath = join(dir, getEnv().transportConfig);
  const oldPath = activePath.replace(".json", ".old.json");
  const tmp = activePath + ".tmp." + process.pid;
  const oldTmp = oldPath + ".tmp." + process.pid;
  const rollbackActiveTmp = activePath + ".rollback." + process.pid;
  const rollbackOldTmp = oldPath + ".rollback." + process.pid;
  let activeCommitted = false;
  let oldAttempted = false;
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
    // Snapshot both files before swapping so a failed second rename can roll
    // the first rename back as well.
    writeFileSync(tmp, old, "utf-8");
    writeFileSync(oldTmp, current, "utf-8");
    writeFileSync(rollbackActiveTmp, current, "utf-8");
    writeFileSync(rollbackOldTmp, old, "utf-8");
    renameSync(tmp, activePath);
    activeCommitted = true;
    oldAttempted = true;
    renameSync(oldTmp, oldPath);
    try { unlinkSync(rollbackActiveTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    cachedTransport = null;
    cachedSource = null;
    logInfo(TAG, "transport.json swapped with .old (restore)");
    return { ok: true };
  } catch (err) {
    // Restore whichever side may have been committed before the failure.
    try { if (oldAttempted) renameSync(rollbackOldTmp, oldPath); } catch { /* best effort */ }
    try { if (activeCommitted) renameSync(rollbackActiveTmp, activePath); } catch { /* best effort */ }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    try { unlinkSync(oldTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackActiveTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    return { ok: false, error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Copy transport.default.json → transport.json atomically, backup current first. */
export function resetToDefaults(): boolean {
  const dir = configDir();
  const defaultPath = join(dir, "transport.default.json");
  const activePath = join(dir, getEnv().transportConfig);
  const oldPath = activePath.replace(".json", ".old.json");
  const tmp = activePath + ".tmp." + process.pid;
  const oldTmp = oldPath + ".tmp." + process.pid;
  const rollbackActiveTmp = activePath + ".rollback." + process.pid;
  const rollbackOldTmp = oldPath + ".rollback." + process.pid;
  let currentBytes: string | null = null;
  let oldBackupExists = false;
  let primaryCommitted = false;
  let backupAttempted = false;
  try {
    // Validate defaults before swapping
    const defaultRaw = readFileSync(defaultPath, "utf-8");
    const defaultParsed = JSON.parse(defaultRaw) as Record<string, unknown>;
    const vr = validateTransportConfig(defaultParsed);
    if (!vr.ok) {
      logWarn(TAG, `transport.default.json is invalid — keeping current config. Issues: ${vr.issues.map(i => i.message).join("; ")}`);
      return false;
    }
    // Snapshot both files before swapping. A backup read failure is a failed
    // reset, not permission to overwrite the only usable configuration.
    oldBackupExists = existsSync(oldPath);
    if (oldBackupExists) writeFileSync(rollbackOldTmp, readFileSync(oldPath, "utf-8"), "utf-8");
    if (existsSync(activePath)) {
      currentBytes = readFileSync(activePath, "utf-8");
      writeFileSync(oldTmp, currentBytes, "utf-8");
      writeFileSync(rollbackActiveTmp, currentBytes, "utf-8");
    }
    writeFileSync(tmp, defaultRaw, "utf-8");
    renameSync(tmp, activePath);
    primaryCommitted = true;
    if (currentBytes !== null) {
      backupAttempted = true;
      renameSync(oldTmp, oldPath);
    }
    try { unlinkSync(rollbackActiveTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
    cachedTransport = null;
    cachedSource = null;
    logInfo(TAG, "transport.json reset to defaults (old saved as .old.json)");
    return true;
  } catch (err) {
    if (backupAttempted) {
      try {
        if (oldBackupExists) renameSync(rollbackOldTmp, oldPath);
        else if (existsSync(oldPath)) unlinkSync(oldPath);
      } catch { /* best effort */ }
    }
    if (primaryCommitted && currentBytes !== null) {
      try { renameSync(rollbackActiveTmp, activePath); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    try { unlinkSync(oldTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackActiveTmp); } catch { /* best effort */ }
    try { unlinkSync(rollbackOldTmp); } catch { /* best effort */ }
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
