/**
 * pi-catalog.ts — Brain catalog bridge (#1311 Phase 2: C1/C2/C5/C8).
 *
 * The ONLY module that imports pi-ai's catalog API. Lazy-loaded — flag-off users never load
 * pi-ai (the import happens inside loadPiModels(), called once at boot when a provider opts in).
 *
 * Anatomy: pi supplies the model *menu* (catalog/cost/auth) at Brain; abtars owns the choice
 * + orchestration. This module resolves pi metadata for abtars's resolution + picker.
 *
 * Resilience (downward-only):
 *   - loadPiModels() is best-effort: returns null if pi absent/broken, NEVER throws on the hot
 *     path. Callers fall to the models.json floor.
 *   - resolveModelMeta() is SYNC and reads a boot-warmed cache (C8). A cold cache → null →
 *     models.json. The sync hot path (resolveAgent) never blocks on pi.
 *   - Precedence (C1): pi wins ONLY when fully resolvable — warmed ∧ provider maps (C2) ∧
 *     getModel() hits. Custom gateways / ollama / kiro never resolve → always models.json.
 *
 * Contracts verified against @earendil-works/pi-ai@~0.80.7 via devDependency.
 */

import type { Models } from "@earendil-works/pi-ai";
import { logInfo, logWarn, logDebug, logTrace } from "../logger.js";
import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import type { PiModuleSpecifier } from "../pi-installation.js";

const TAG = "pi-catalog";
// ── C2: provider-id mapping (identity for known pi providers) ────────────────

/** pi-ai's built-in provider ids (KnownProvider). abtars provider names map by identity. */
const KNOWN_PI_PROVIDERS = new Set<string>([
  "amazon-bedrock", "ant-ling", "anthropic", "google", "google-vertex", "openai",
  "azure-openai-responses", "openai-codex", "nvidia", "deepseek", "github-copilot", "xai",
  "groq", "cerebras", "openrouter", "vercel-ai-gateway", "zai", "zai-coding-cn", "mistral",
  "minimax", "minimax-cn", "moonshotai", "moonshotai-cn", "huggingface", "fireworks",
  "together", "opencode", "opencode-go", "kimi-coding", "cloudflare-workers-ai",
  "cloudflare-ai-gateway", "xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
]);

/**
 * Map an abtars provider name → pi provider id, or null if there is no pi mapping
 * (custom gateways, ollama, kiro → caller stays on the models.json floor).
 */
export function mapProviderName(name: string): string | null {
  return KNOWN_PI_PROVIDERS.has(name) ? name : null;
}

// ── C8: boot-warm + cached catalog ───────────────────────────────────────────

let _warmed: Models | null = null;
let _warmAttempted = false;

/** Sync read of the warmed catalog. null if not yet warmed or pi absent. Hot path; never throws. */
export function getWarmedModels(): Models | null {
  return _warmed;
}

/** True once the warm has been attempted (success or failure). */
export function isWarmed(): boolean {
  return _warmAttempted;
}

/**
 * Warm + cache pi's catalog at boot (C8). Idempotent. Best-effort: returns null on any failure
 * (pi absent/broken) — callers fall to models.json. Dynamic providers get one refresh() so
 * getModels() is populated; static providers are always current. Never throws.
 *
 * #1311: `createModels()` on the root returns an empty collection — the built-in
 * provider list lives behind the `@earendil-works/pi-ai/providers/all` subpath
 * (the package's `exports["./providers/*"]` maps to `dist/providers/*.js`).
 * `builtinModels()` constructs `createModels()` AND registers every built-in
 * provider (1029 static models across 35+ providers as of pi-ai 0.80.3).
 */
export async function loadPiModels(): Promise<Models | null> {
  if (_warmAttempted) return _warmed;
  _warmAttempted = true;
  try {
    const result = resolvePiInstallation();
    if (result.state !== "compatible") {
      logInfo(TAG, `Pi not available (${result.state}) — using models.json floor`);
      return null;
    }

    const t0 = Date.now();
    const providerSpec: PiModuleSpecifier = { package: "@earendil-works/pi-ai", subpath: "providers/all" };
    const mod = await loadPiModule<{ builtinModels: (opts?: Record<string, unknown>) => Models }>(result.installation, providerSpec);
    const models = mod.builtinModels();
    try {
      await models.refresh?.();
    } catch (err) {
      logWarn(TAG, `catalog refresh failed (static providers still usable): ${err instanceof Error ? err.message : String(err)}`);
    }
    _warmed = models;
    const all = models.getModels();
    logInfo(TAG, `pi-ai catalog warmed (${all.length} models)`);
    const byProvider: Record<string, number> = {};
    for (const m of all) {
      const p = (m as { provider?: string }).provider ?? "?";
      byProvider[p] = (byProvider[p] ?? 0) + 1;
    }
    logDebug(TAG, `catalog breakdown: ${Object.entries(byProvider).map(([p, n]) => `${p}:${n}`).join(", ")}`);
    const elapsedMs = Date.now() - t0;
    const sample = all.slice(0, 3).map(m => m.id).join(",");
    logTrace(TAG, `catalog fetch: ${all.length} models in ${elapsedMs}ms; sample=${sample}`);
  } catch (err) {
    logWarn(TAG, `pi-ai catalog unavailable — using models.json floor: ${err instanceof Error ? err.message : String(err)}`);
    _warmed = null;
  }
  return _warmed;
}

// ── C1: precedence — pi metadata when fully resolvable ───────────────────────

export type ModelMetaSource = "pi" | "models.json" | "default";

export interface ResolvedModelMeta {
  contextWindow: number;
  maxOutput: number;
  cost: { input: number; output: number };
  source: ModelMetaSource;
}

/**
 * SYNC. Returns pi metadata when (warmed ∧ provider maps ∧ getModel hits), else null so the
 * caller falls to models.json / defaults. `models` is injectable for tests (defaults to the
 * warmed cache). Never throws.
 */
export function resolveModelMeta(
  modelId: string,
  providerName: string,
  models: Models | null = getWarmedModels(),
): ResolvedModelMeta | null {
  if (!models) return null;
  const piProvider = mapProviderName(providerName);
  if (!piProvider) return null;
  const m = models.getModel(piProvider, modelId);
  if (!m) return null;
  return {
    contextWindow: m.contextWindow,
    maxOutput: m.maxTokens,
    cost: { input: m.cost.input, output: m.cost.output },
    source: "pi",
  };
}

export type PiAuthStatus = "usable" | "needs-login" | "unconfigured";

export interface PiPickerModel {
  id: string;
  contextWindow: number;
  cost: { input: number; output: number };
  authStatus: PiAuthStatus;
}

/**
 * ASYNC (getAuth). Picker data: pi models for a provider, annotated by auth status. Returns
 * null when pi isn't resolvable for this provider → caller renders the models.json list.
 *
 * NOTE (C5): auth status assumes pi's getAuth resolves API-key providers from env. Reconcile
 * env-var names with abtars's `apiKeyEnv` when wiring the picker; until then this is best-effort.
 */
export async function modelsForProvider(providerName: string): Promise<PiPickerModel[] | null> {
  const models = getWarmedModels();
  if (!models) return null;
  const piProvider = mapProviderName(providerName);
  if (!piProvider) return null;
  const list = models.getModels(piProvider);
  const out: PiPickerModel[] = [];
  for (const m of list) {
    let authStatus: PiAuthStatus = "unconfigured";
    try {
      const auth = await models.getAuth(m);
      authStatus = auth ? "usable" : "unconfigured";
    } catch {
      // getAuth rejects on credential-store failure / expired OAuth → user must (re)login.
      authStatus = "needs-login";
    }
    out.push({ id: m.id, contextWindow: m.contextWindow, cost: { input: m.cost.input, output: m.cost.output }, authStatus });
  }
  return out;
}

// ── test-only ────────────────────────────────────────────────────────────────

/**
 * SYNC. Picker list for Phase 2: pi models for a provider with cost (no auth filtering).
 * Returns null when pi isn't resolvable for this provider → caller renders the models.json list.
 *
 * Auth-status filtering is deliberately deferred: pi's getAuth resolves API-key providers from
 * env var names that may differ from abtars's `apiKeyEnv`, so filtering would mislabel usable
 * models as unconfigured. Selection still goes through abtars's validateProviderReady (apiKeyEnv).
 * The auth-aware (getAuth) list is modelsForProvider() above, used by #1316.
 */
export function modelsForProviderSync(providerName: string): Array<{ id: string; cost: { input: number; output: number }; contextWindow: number }> | null {
  const models = getWarmedModels();
  if (!models) return null;
  const piProvider = mapProviderName(providerName);
  if (!piProvider) return null;
  return models.getModels(piProvider).map(m => ({ id: m.id, cost: { input: m.cost.input, output: m.cost.output }, contextWindow: m.contextWindow }));
}

/**
 * Cost rates keyed by model id, from the warmed pi catalog — 4 components (cache-aware).
 * First match wins on id collision across providers (acceptable for /usage display cost; the
 * configured candidate's provider is not stored per usage entry). null if not warmed.
 */
export function piCostRatesByModel(): Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> | null {
  const models = getWarmedModels();
  if (!models) return null;
  const map = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  for (const m of models.getModels()) {
    if (!map.has(m.id)) map.set(m.id, { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite });
  }
  return map;
}

/** @internal Reset the warm cache between unit tests. */
export function _resetForTest(): void {
  _warmed = null;
  _warmAttempted = false;
}

/** @internal Inject a fake warmed catalog (tests). */
export function _setWarmedForTest(models: Models | null): void {
  _warmed = models;
  _warmAttempted = true;
}
