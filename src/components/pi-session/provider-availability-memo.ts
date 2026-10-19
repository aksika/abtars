import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { logWarn } from "../logger.js";

const TAG = "pi-availability-memo";
export const PI_AVAILABILITY_MEMO_VERSION = 1;
export const PI_AVAILABILITY_MEMO_FILENAME = "provider-availability-v1.json";
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Bounded, memoizable failure kinds. Overflow, tool errors, policy denial,
 * cancellation, and archive/hydration failures are not provider
 * unavailability and cannot be recorded here by construction.
 */
export type MemoizableFailureKind = "auth" | "account-limit" | "rate-limit" | "temporary";

export interface ProviderAvailabilityEntry {
  authNamespace: string;
  provider: string;
  endpoint?: string;
  modelScope?: string;
  reason: MemoizableFailureKind;
  observedAt: number;
  unusableUntil: number;
}

interface MemoFileShape {
  version: number;
  entries: ProviderAvailabilityEntry[];
}

export interface MemoLoadResult {
  entries: ProviderAvailabilityEntry[];
  /** Bounded diagnostic when stored data was invalid; the cache is empty. */
  invalid?: string;
}

export function memoFilePath(stateDir: string): string {
  return join(stateDir, PI_AVAILABILITY_MEMO_FILENAME);
}

export function isMemoBlocked(entry: ProviderAvailabilityEntry, now: number): boolean {
  return now < entry.unusableUntil;
}

export function memoScopeMatches(
  entry: ProviderAvailabilityEntry,
  query: { authNamespace: string; provider: string; endpoint?: string; modelScope?: string },
): boolean {
  if (entry.authNamespace !== query.authNamespace) return false;
  if (entry.provider !== query.provider) return false;
  if (query.endpoint !== undefined && entry.endpoint !== query.endpoint) return false;
  if (query.modelScope !== undefined && entry.modelScope !== query.modelScope) return false;
  return true;
}

/**
 * Cooldown for a fresh observation: a reliable provider reset/retry-after
 * time bounded to 24h, otherwise a five-minute cooldown. Expiry allows
 * normal dispatch to try again; there are no background probes.
 */
export function cooldownForObservation(retryAfterMs: number | undefined, observedAt: number): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return observedAt + Math.min(retryAfterMs, MAX_COOLDOWN_MS);
  }
  return observedAt + DEFAULT_COOLDOWN_MS;
}

function isValidEntry(value: unknown): value is ProviderAvailabilityEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry["authNamespace"] !== "string" || entry["authNamespace"]!.length === 0) return false;
  if (typeof entry["provider"] !== "string" || entry["provider"]!.length === 0) return false;
  if (entry["endpoint"] !== undefined && typeof entry["endpoint"] !== "string") return false;
  if (entry["modelScope"] !== undefined && typeof entry["modelScope"] !== "string") return false;
  const reason = entry["reason"];
  if (reason !== "auth" && reason !== "account-limit" && reason !== "rate-limit" && reason !== "temporary") {
    return false;
  }
  if (typeof entry["observedAt"] !== "number" || !Number.isFinite(entry["observedAt"])) return false;
  if (typeof entry["unusableUntil"] !== "number" || !Number.isFinite(entry["unusableUntil"])) return false;
  return true;
}

export function loadAvailabilityMemo(stateDir: string): MemoLoadResult {
  const path = memoFilePath(stateDir);
  if (!existsSync(path)) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    // Corrupt memo must not become a second permanent outage.
    logWarn(TAG, "availability memo unreadable; using empty cache");
    return { entries: [], invalid: "unreadable memo file" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { entries: [], invalid: "memo file is not an object" };
  }
  const shape = parsed as { version?: unknown; entries?: unknown };
  if (shape.version !== PI_AVAILABILITY_MEMO_VERSION || !Array.isArray(shape.entries)) {
    return { entries: [], invalid: "unsupported memo version or shape" };
  }
  const entries: ProviderAvailabilityEntry[] = [];
  for (const item of shape.entries) {
    if (!isValidEntry(item)) {
      return { entries: [], invalid: "memo contains an invalid entry" };
    }
    // No keys, tokens, secret hashes, or raw error payloads are stored;
    // entries carry only opaque namespace, provider/endpoint, optional
    // model scope, bounded reason, and timestamps.
    entries.push(item);
  }
  return { entries };
}

/** Daemon-serialized atomic write with private file permissions. */
export function saveAvailabilityMemo(stateDir: string, entries: ProviderAvailabilityEntry[]): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = memoFilePath(stateDir);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const shape: MemoFileShape = { version: PI_AVAILABILITY_MEMO_VERSION, entries };
  writeFileSync(tmp, JSON.stringify(shape), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * A success clears only applicable observations that are not newer than
 * that attempt's admission and belong to the same auth namespace. Stale
 * completions cannot clear a newer failure.
 */
export function applyMemoSuccess(
  entries: ProviderAvailabilityEntry[],
  success: { authNamespace: string; provider: string; admittedAt: number },
): ProviderAvailabilityEntry[] {
  return entries.filter(
    (entry) =>
      !(
        entry.authNamespace === success.authNamespace &&
        entry.provider === success.provider &&
        entry.observedAt <= success.admittedAt
      ),
  );
}

/** Explicit selection/reset and auth-source changes clear the namespace. */
export function clearMemoNamespace(
  entries: ProviderAvailabilityEntry[],
  authNamespace: string,
): ProviderAvailabilityEntry[] {
  return entries.filter((entry) => entry.authNamespace !== authNamespace);
}
