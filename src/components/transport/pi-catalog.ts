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
 * Compile-time pi-free: no `import type` from @earendil-works/pi-ai (not a dependency). The
 * Pi* interfaces mirror pi-ai structurally; the real module is loaded at runtime via lazyRequire.
 */

import { lazyRequire } from "../../utils/lazy-require.js";
import { logInfo, logWarn } from "../logger.js";

const TAG = "pi-catalog";

// ── pi-ai structural types (compile-time pi-free; structurally compatible) ───

interface PiModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  reasoning: boolean;
  input: ("text" | "image")[];
}
interface PiAuthResult {
  auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };
  source?: string;
}
export interface PiModels {
  getModel(provider: string, id: string): PiModel | undefined;
  getModels(provider?: string): readonly PiModel[];
  getProvider(id: string): { id: string } | undefined;
  getAuth(model: PiModel): Promise<PiAuthResult | undefined>;
  refresh?(provider?: string): Promise<void>;
}
interface PiAiRoot {
  builtinModels(options?: Record<string, unknown>): PiModels;
}

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

let _warmed: PiModels | null = null;
let _warmAttempted = false;

/** Sync read of the warmed catalog. null if not yet warmed or pi absent. Hot path; never throws. */
export function getWarmedModels(): PiModels | null {
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
 */
export async function loadPiModels(): Promise<PiModels | null> {
  if (_warmAttempted) return _warmed;
  _warmAttempted = true;
  try {
    const pi = await lazyRequire<PiAiRoot>("@earendil-works/pi-ai", "pi-ai provider engine");
    const models = pi.builtinModels();
    try {
      await models.refresh?.();
    } catch (err) {
      // A dynamic-list refresh failure is non-fatal: static providers are still usable.
      logWarn(TAG, `catalog refresh failed (static providers still usable): ${err instanceof Error ? err.message : String(err)}`);
    }
    _warmed = models;
    logInfo(TAG, `pi-ai catalog warmed (${models.getModels().length} models)`);
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
  models: PiModels | null = getWarmedModels(),
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

/** @internal Reset the warm cache between unit tests. */
export function _resetForTest(): void {
  _warmed = null;
  _warmAttempted = false;
}

/** @internal Inject a fake warmed catalog (tests). */
export function _setWarmedForTest(models: PiModels | null): void {
  _warmed = models;
  _warmAttempted = true;
}
