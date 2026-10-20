/**
 * pi-runtime.ts — Pi-managed auth/model readiness (#1757).
 *
 * Loads Pi's configured model runtime for presence-only readiness checks
 * (boot model selection, /model, pickers). Provider calls go through the
 * Pi AgentSession (#1940). abtars never sees a Pi credential value. Every
 * entrypoint is best-effort and never throws for unavailability.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { logInfo, logWarn } from "../logger.js";
import { loadPiModule, resolvePiInstallation } from "../pi-installation.js";
import { mapProviderName } from "./pi-catalog.js";

const TAG = "pi-runtime";

export type PiAuthState = "usable" | "needs-login" | "unconfigured";

export interface PiManagedReadiness {
  ok: boolean;
  state: PiAuthState;
  /** Actionable, presence-only detail. Never a credential value. */
  detail: string;
}

let _runtime: ModelRuntime | null = null;
let _attempted = false;

/** @internal Inject the loaded runtime in tests. */
export function setPiRuntimeForTest(runtime: ModelRuntime | null): void {
  _runtime = runtime;
  _attempted = true;
}

export function resetPiRuntimeForTest(): void {
  _runtime = null;
  _attempted = false;
}

async function loadRuntime(): Promise<ModelRuntime | null> {
  if (_attempted) return _runtime;
  _attempted = true;
  try {
    const resolved = resolvePiInstallation();
    if (resolved.state !== "compatible") {
      logInfo(TAG, `Pi unavailable (${resolved.state}) — Pi-managed providers cannot dispatch`);
      return null;
    }
    const mod = await loadPiModule<{ ModelRuntime?: { create?: (opts?: Record<string, unknown>) => Promise<ModelRuntime> } }>(
      resolved.installation,
      { package: "@earendil-works/pi-coding-agent" },
    );
    const create = mod.ModelRuntime?.create;
    if (typeof create !== "function") {
      logWarn(TAG, "Pi coding-agent root has no ModelRuntime.create — Pi-managed providers cannot dispatch");
      return null;
    }
    // Default credential storage: DefaultAuthStorage at the Pi agent dir —
    // the same auth.json the pi CLI reads — so the runtime sees exactly the
    // operator's configured logins. No network refresh at create: static
    // models stay available and boot never stalls on a catalog fetch.
    _runtime = await create({ refreshOnCreate: false, allowModelNetwork: false });
    return _runtime;
  } catch (err) {
    logWarn(TAG, `Pi runtime load failed — Pi-managed providers cannot dispatch: ${err instanceof Error ? err.message : String(err)}`);
    _runtime = null;
    return null;
  }
}

/** Bound for the `/change`-triggered runtime refresh: local snapshot rebuild, no network. */
const REFRESH_TIMEOUT_MS = 15_000;

let _refreshInflight: Promise<boolean> | null = null;

/**
 * Hot-reload Pi's model snapshot outside boot (#1875: `/change` entry).
 * Re-reads Pi's models.json and the local model store's revision-checked
 * snapshot, then rebuilds providers — local-only (`allowNetwork: false`),
 * under a bounded signal. Concurrent callers share one in-flight rebuild.
 * Best-effort and never throwing: on any failure the caller proceeds from the
 * previous snapshot (restart remains the fallback). Returns whether the
 * snapshot was rebuilt.
 */
export function refreshPiRuntime(): Promise<boolean> {
  if (!_refreshInflight) {
    _refreshInflight = rebuildPiRuntime().finally(() => {
      // Clear on success and failure so a later /change can rebuild again.
      _refreshInflight = null;
    });
  }
  return _refreshInflight;
}

async function rebuildPiRuntime(): Promise<boolean> {
  try {
    const runtime = await loadRuntime();
    if (!runtime) return false;
    await runtime.refresh({ allowNetwork: false, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
    return true;
  } catch (err) {
    // Best-effort by contract: /change must never break because a rebuild failed.
    logWarn(TAG, `Pi runtime refresh failed — using previous snapshot: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Menu-side model list for a Pi-managed provider (#1875): the runtime's
 * composed catalog (installed builtins + local models store + Pi models.json)
 * after a refresh, so the picker offers exactly what dispatch accepts.
 * Best-effort: returns null when the provider is unmapped or the runtime is
 * unavailable — callers fall back to the static pi-ai catalog. Never throws.
 */
export async function piRuntimeModelsForProvider(
  providerName: string,
): Promise<Array<{ id: string; cost: { input: number; output: number }; contextWindow: number }> | null> {
  const piProvider = mapProviderName(providerName);
  if (!piProvider) return null;
  const runtime = await loadRuntime();
  if (!runtime) return null;
  try {
    return runtime.getModels(piProvider).map(m => ({
      id: m.id,
      cost: { input: m.cost.input, output: m.cost.output },
      contextWindow: m.contextWindow,
    }));
  } catch (err) {
    // Unavailable is not fatal for the picker — it falls back to the static catalog.
    logWarn(TAG, `Pi runtime model list failed for "${providerName}" — using static catalog: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Presence-only readiness for a Pi-managed provider. Answers whether Pi can
 * authenticate this provider right now; never a guarantee that a later
 * remote call succeeds (dispatch re-checks at request time).
 */
export async function checkPiManagedAuth(providerName: string): Promise<PiManagedReadiness> {
  const piProvider = mapProviderName(providerName);
  if (!piProvider) {
    return {
      ok: false,
      state: "unconfigured",
      detail: `Provider "${providerName}" has no Pi provider mapping — Pi-managed auth unavailable`,
    };
  }
  const runtime = await loadRuntime();
  if (!runtime) {
    return {
      ok: false,
      state: "unconfigured",
      detail: "Pi installation unavailable — reinstall with: abtars deps install pi",
    };
  }
  try {
    const auth = await runtime.checkAuth(piProvider);
    if (!auth) {
      return {
        ok: false,
        state: "needs-login",
        detail: `Pi has no usable auth for provider "${providerName}" — diagnose with: pi auth check --provider ${piProvider}`,
      };
    }
    return { ok: true, state: "usable", detail: `Pi auth usable for "${providerName}" (${auth.type})` };
  } catch (err) {
    return {
      ok: false,
      state: "needs-login",
      detail: `Pi credential check failed for "${providerName}" — diagnose with: pi auth check --provider ${piProvider} (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Selection-point gate: non-Pi-managed providers pass through untouched;
 * Pi-managed providers must report usable Pi auth. Used by boot selection
 * and any other async selection path (the sync `validateProviderReady`
 * cannot see Pi login state).
 */
export async function checkPiManagedSelection(
  providerName: string,
  provider: { authSource?: string },
): Promise<{ ok: boolean; reason?: string }> {
  if (provider.authSource !== "pi") return { ok: true };
  const readiness = await checkPiManagedAuth(providerName);
  return readiness.ok ? { ok: true } : { ok: false, reason: readiness.detail };
}

/**
 * Whether Pi's catalog knows a model on a provider. Used by status surfaces
 * that enumerate models (doctor) without dispatching a request.
 */
export async function isPiManagedModelKnown(providerName: string, modelId: string): Promise<boolean> {
  const piProvider = mapProviderName(providerName);
  if (!piProvider) return false;
  const runtime = await loadRuntime();
  if (!runtime) return false;
  try {
    return runtime.getModel(piProvider, modelId) !== undefined;
  } catch {
    return false;
  }
}
