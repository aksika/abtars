/**
 * pi-runtime.ts — Pi-managed model runtime bridge (#1757).
 *
 * Loads Pi's configured model runtime (ModelRuntime from the discovered
 * Pi coding-agent installation) and dispatches explicitly Pi-managed
 * candidates through it. Pi owns endpoint, API format, headers, credential
 * resolution, and refresh on this path; abtars never sees a Pi credential
 * value — only presence-only auth state.
 *
 * Resilience (downward-only, mirrors pi-catalog.ts): every entrypoint is
 * best-effort and never throws for unavailability (null / not-ok readiness).
 * Only genuine auth failures throw, and they carry HTTP 401 so the existing
 * model-health classifier demotes instead of spinning transiently.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
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

/**
 * Auth-kind failure on the Pi-managed path. The `status` field is read by
 * the shared `parseErrorStatus` so `classifyError` maps it to "auth"
 * (sticky failure + auto-demote), never an unhandled daemon crash.
 */
export class PiManagedAuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "PiManagedAuthError";
  }
}

/**
 * Pi credential-absence phrasings. A terminal carrying one of these means
 * no credential existed to send — definitionally auth-kind, even when the
 * transport surfaced no HTTP status.
 */
const PI_AUTH_ABSENCE =
  /no API key for provider|not configured|needs[ -]login|login (required|expired)|invalid API key|incorrect API key|authentication (failed|required|expired)|invalid_api_key|authentication_error/i;

export function isPiAuthAbsenceMessage(message: string): boolean {
  return PI_AUTH_ABSENCE.test(message);
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

/**
 * Dispatch one request through Pi's configured runtime. Auth is resolved by
 * Pi inside `streamSimple` at request time — abtars passes no key on this
 * path. Throws `PiManagedAuthError` (401) when Pi reports no usable auth so
 * the health path demotes; throws a plain Error (transient → fallback) when
 * the installation, mapping, or model is unknown.
 */
export async function streamPiManaged(
  providerName: string,
  modelId: string,
  context: Context,
  options?: SimpleStreamOptions,
  /** Adapter-built model's reasoning flag, carried over so a session effort
   *  override (notably "off") applies on this path exactly as on the
   *  abtars-keyed path. Pi's own catalog value leads when absent. */
  reasoningOverride?: boolean,
): Promise<AssistantMessageEventStream> {
  const piProvider = mapProviderName(providerName);
  if (!piProvider) {
    throw new Error(`Pi-managed provider "${providerName}" has no Pi provider mapping`);
  }
  const runtime = await loadRuntime();
  if (!runtime) {
    throw new Error("Pi installation unavailable — reinstall with: abtars deps install pi");
  }
  const catalogModel: Model<Api> | undefined = runtime.getModel(piProvider, modelId);
  if (!catalogModel) {
    throw new Error(`Model "${modelId}" unknown to Pi provider "${providerName}" — pick a model Pi knows`);
  }
  // Shallow copy: Pi's endpoint/API/auth semantics stay authoritative; only
  // the session reasoning flag is overlaid for parity with the adapter path.
  const model = reasoningOverride === undefined || reasoningOverride === catalogModel.reasoning
    ? catalogModel
    : { ...catalogModel, reasoning: reasoningOverride };
  // Opencode-family providers require a session attribution header that Pi
  // only attaches on its SDK path (mergeProviderAttributionHeaders over
  // options.sessionId). Bare streamSimple never sends it, so headless
  // dispatch 400s with MissingSessionID. Mirror the SDK merge here using the
  // session id abtars already shares with providers for prompt caching —
  // attribution only, never identity: no user/chat/platform key travels.
  const sessionId = (options as { sessionId?: string } | undefined)?.sessionId;
  const needsSessionHeader = model.provider === "opencode" || model.provider === "opencode-go"
    || (model.baseUrl ?? "").includes("opencode.ai");
  const dispatchOptions = sessionId && needsSessionHeader
    ? {
      ...options,
      transformHeaders: async (headers: ProviderHeaders) => ({
        ...headers,
        "x-opencode-session": sessionId,
        "x-opencode-client": "pi",
      }),
    }
    : options;
  try {
    const auth = await runtime.checkAuth(piProvider);
    if (!auth) {
      throw new PiManagedAuthError(
        `Pi has no usable auth for provider "${providerName}" — diagnose with: pi auth check --provider ${piProvider}`,
      );
    }
  } catch (err) {
    if (err instanceof PiManagedAuthError) throw err;
    throw new PiManagedAuthError(
      `Pi credential check failed for "${providerName}" (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return runtime.streamSimple(model, context, dispatchOptions);
}
