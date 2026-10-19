import { PiSoulGate, type SoulGateAdmission } from "./pi-soul-gate.js";

/** Minimal message shape: the composer never inspects payload internals. */
export type PiSoulMessage = Record<string, unknown>;

export type PiSoulTransform = (
  messages: readonly PiSoulMessage[],
  signal?: AbortSignal,
) => Promise<PiSoulMessage[]>;

export interface PiSoulBundle {
  marker: string;
  text: string;
}

/**
 * Compose the request-scoped SOUL bundle onto the session's existing
 * transform. The previous transform (Pi's conversation/system/tool
 * projection) runs first and is preserved verbatim; exactly one marked
 * bundle is appended. The gate is the final authority: a denied request
 * never reaches the provider stream function, so a failure here must be
 * treated as a turn-level unavailable result, not swallowed by an
 * extension runner. The bundle is request-scoped only and is never
 * written back into the session transcript.
 */
export function composeSoulTransform(
  gate: PiSoulGate,
  previous: PiSoulTransform | undefined,
  generation: number,
  admission: SoulGateAdmission,
  bundle: () => PiSoulBundle | undefined,
): PiSoulTransform {
  return async (messages: readonly PiSoulMessage[], signal?: AbortSignal) => {
    const decision = gate.checkRequest(generation, admission);
    if (!decision.admit) {
      throw new Error(`soul admission denied (${decision.reason})`);
    }
    const projected = previous ? await previous(messages, signal) : [...messages];
    const current = bundle();
    if (!current) {
      throw new Error("soul admission denied (bundle unavailable)");
    }
    return [...projected, { ...current } as PiSoulMessage];
  };
}

/**
 * Invalidate cached context at session lifecycle boundaries: start,
 * resume, switch/fork, and every successful compaction. The caller
 * invokes this wherever it installs a replacement instance or observes
 * session_compact, before the instance can run.
 */
export function invalidateSoulOnLifecycle(gate: PiSoulGate): void {
  gate.invalidateOnCompaction();
}
