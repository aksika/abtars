import type { ErrorKind } from "../transport/provider-failure.js";
import {
  loadAvailabilityMemo,
  saveAvailabilityMemo,
  type MemoizableFailureKind,
} from "./provider-availability-memo.js";
import {
  observePiFailure,
  type PiSelectableTarget,
} from "./pi-availability-admission.js";

/**
 * Boundary normalization from the Pi-route error taxonomy to the durable
 * availability memo. Only provider unavailability is memoizable: auth and
 * account-limit evidence, rate limits, and temporary provider failures.
 * Overflow, tool errors, policy denial, cancellation, weak/empty/truncated
 * model behavior, and local archive/hydration errors return null and are
 * never recorded. The existing classifier stays the single interpreter
 * of status/message; this module only decides memoizability.
 */
export function memoKindForErrorKind(kind: ErrorKind): MemoizableFailureKind | null {
  switch (kind) {
    case "auth":
      return "auth";
    case "credits":
      return "account-limit";
    case "rate_limit":
      return "rate-limit";
    case "transient":
      return "temporary";
    default:
      return null;
  }
}

export interface PiMemoClassification {
  kind: ErrorKind;
  retryAfterMs?: number;
}

/**
 * Write-only observation at the Pi boundary, called after Pi's bounded
 * recovery has failed. Records nothing for non-memoizable kinds. Auth and
 * account-limit evidence is provider-wide within the auth namespace (it is
 * not model-specific); rate limits and temporary failures stay scoped to the
 * exact endpoint/model. Changes no admission behavior by itself.
 */
export function recordPiMemoObservation(
  stateDir: string,
  target: PiSelectableTarget,
  classification: PiMemoClassification,
  observedAt: number,
): boolean {
  const memoKind = memoKindForErrorKind(classification.kind);
  if (memoKind === null) return false;
  const providerWide = memoKind === "auth" || memoKind === "account-limit";
  const loaded = loadAvailabilityMemo(stateDir);
  const updated = observePiFailure(loaded.entries, {
    authNamespace: target.authNamespace,
    provider: target.provider,
    ...(providerWide
      ? {}
      : { endpoint: target.endpoint, modelScope: target.modelScope }),
    kind: memoKind,
    observedAt,
    retryAfterMs: classification.retryAfterMs,
  });
  saveAvailabilityMemo(stateDir, updated);
  return true;
}
