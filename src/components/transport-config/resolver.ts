/**
 * transport-config/resolver.ts — agent/hail-Mary/provider/model resolution,
 * startup warnings, readiness probes, picker helpers, and display formatting.
 */

import { getEnv } from "../env-schema.js";
import { logWarn } from "../logger.js";
import { resolveModelMeta, mapProviderName, isWarmed, getWarmedModels } from "../transport/pi-catalog.js";
import type {
  EnvAccessor,
  EnvFallback,
  ExecutionRoute,
  ModelCatalog,
  ModelCost,
  ModelEntry,
  ProviderConfig,
  ProviderValidationResult,
  ResolvedAgent,
  ResolvedHailMary,
  TransportConfig,
} from "./types.js";
import { loadTransport, loadModels, computeCostDisplay } from "./loader.js";
import { routeAssignments, providerSupportsRoute, validateTransportAssignments } from "./validator.js";

const TAG = "transport-config";

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
    if (fb.demoted || fb.model === effectiveModel) continue;
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

export function getEnvFallback(): EnvFallback {
  const providerName = process.env["DEFAULT_PROVIDER"]?.trim();
  const model = process.env["DEFAULT_MODEL"]?.trim();
  if (!providerName || !model) {
    throw new Error("DEFAULT_PROVIDER and DEFAULT_MODEL must be set in .env when no explicit transport.json route supplies a model/provider");
  }
  const transport = getEnv().defaultTransport as "api" | "acp" | "tmux";

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
export function anyApiProviderConfigured(tc?: TransportConfig | null): boolean {
  const config = tc ?? loadTransport();
  if (!config) return false;
  return Object.values(config.providers).some(p => p.transport === "api");
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

// #1320: Telegram picker hard cap (inline-keyboard size). Mirrors telegram-model-picker.ts.
const PI_PICKER_CAP = 50;

export function getModelsForProvider(providerName: string, models?: ModelCatalog): Array<{ id: string; entry: ModelEntry }> {
  const mc = models ?? loadModels();
  const curated = Object.entries(mc)
    .filter(([, entry]) => entry.transports.includes(providerName))
    .map(([id, entry]) => ({ id, entry }))
    .sort((a, b) => a.entry.rank - b.entry.rank || a.entry.cost.input - b.entry.cost.input);
  // #1613: pi-catalog fallback for pi-mapped providers with no curated models.json
  // entries (e.g. opencode-go). Only when the curated list is empty, the catalog is
  // warmed, and the pi list is small — big uncurated providers stay out of the
  // Telegram picker (#1320), and curated providers are never extended.
  if (curated.length === 0 && mapProviderName(providerName) && isWarmed()) {
    const pi = getWarmedModels()?.getModels(providerName) ?? [];
    if (pi.length > 0 && pi.length <= PI_PICKER_CAP) {
      return pi
        .map((m) => ({
          id: m.id,
          entry: {
            contextWindow: m.contextWindow,
            maxOutput: m.maxTokens,
            rank: 3,
            // pi catalog costs are $/1M tokens; ModelCost is $/token — normalize.
            cost: { input: m.cost.input / 1_000_000, output: m.cost.output / 1_000_000 },
            transports: [providerName],
            status: "alive" as const,
          },
        }))
        .sort((a, b) => a.entry.cost.input - b.entry.cost.input);
    }
  }
  return curated;
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
        fix: `Store the key at ~/.abtars/secret/${provider.apiKeyEnv} and restart`,
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