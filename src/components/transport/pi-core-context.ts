import { createHash } from "node:crypto";
import type { DurableContextProjectionInput, DurableContextProjectionResult } from "../memory-runtime.js";

/**
 * #1527: read-only durable context provider. Replaces the misleading
 * orchestrator-shaped contract, which implied compaction maintenance that
 * this read path never performed.
 */
export interface PiDurableContextProvider {
  projectContext(input: DurableContextProjectionInput): Promise<DurableContextProjectionResult>;
}

export type DurableContextUnavailableReason =
  | "no_provider"
  | "provider_rejected"
  | "malformed_response"
  | "cursor_unavailable"
  | "identity_unavailable"
  | "hydration_failed"
  | "runtime_unavailable"
  | "record_failed"
  | "cursor_missing";

/** #1527: durable projection failures are execution errors, never degraded success. */
export class DurableContextUnavailableError extends Error {
  readonly reason: DurableContextUnavailableReason;
  constructor(reason: DurableContextUnavailableReason, cause?: unknown) {
    super(`Durable context unavailable: ${reason}`, { cause });
    this.name = "DurableContextUnavailableError";
    this.reason = reason;
  }
}

/**
 * Late-bound shared provider reference. Transport construction and memory
 * negotiation boot in parallel, so the transport captures the holder and the
 * composition point (pipelineDeps) populates it once memory is ready.
 */
export interface DurableContextProviderHolder {
  current: PiDurableContextProvider | null;
}

export function createDurableContextProvider(
  runtime: import("../memory-runtime.js").AbtarsMemoryRuntime,
): PiDurableContextProvider {
  return {
    projectContext: (input: DurableContextProjectionInput) => runtime.projectDurableContext(input),
  };
}

/** Bounded, content-free session fingerprint for diagnostics. */
function sessionFingerprint(sessionKey: string): string {
  return createHash("sha256").update(sessionKey, "utf-8").digest("hex").slice(0, 12);
}

// ── #1705: bounded context_projection diagnostics ─────────────────────────────
//
// The per-transform projection line was a DEBUG flood under runaway Orc
// re-claim loops (1.14M+ lines/day on one deployment, heartbeat starved).
// The success line is TRACE-level AND deduplicated per session: at most one
// line per session per interval, so even a trace-level deployment stays far
// below the <100 lines/hour/session containment target. Projection FAILURE
// warnings keep their own path — they are actionable and rare by definition.

/** Minimum interval between context_projection success lines per session. */
export const PROJECTION_DIAGNOSTIC_MIN_INTERVAL_MS = 60_000;

const lastProjectionEmitAt = new Map<string, number>();

/** Testable pure gate: true when this session may emit one diagnostic now. */
export function shouldEmitProjectionDiagnostic(sessionKey: string, now: number): boolean {
  const fingerprint = sessionFingerprint(sessionKey);
  const last = lastProjectionEmitAt.get(fingerprint);
  if (last !== undefined && now - last < PROJECTION_DIAGNOSTIC_MIN_INTERVAL_MS) return false;
  lastProjectionEmitAt.set(fingerprint, now);
  // Bound the map: drop entries idle for 10 intervals.
  if (lastProjectionEmitAt.size > 256) {
    const cutoff = now - 10 * PROJECTION_DIAGNOSTIC_MIN_INTERVAL_MS;
    for (const [key, at] of lastProjectionEmitAt) {
      if (at < cutoff) lastProjectionEmitAt.delete(key);
    }
  }
  return true;
}

export function resetProjectionDiagnosticStateForTest(): void {
  lastProjectionEmitAt.clear();
}
