/**
 * Request-scoped SOUL/hydration admission gate.
 *
 * Every session creation/replacement/resume begins hydration-pending. Within
 * a live instance, every successful compaction invalidates the cached bundle
 * before continuation. The request guard is the final authority: no valid
 * bundle means no conversational request. A restart always requires fresh
 * hydration, even if the process died after compaction was appended but
 * before its callback, so no separately persisted restoration flag exists.
 */

export type SoulGateDecision =
  | { admit: true; generation: number }
  | { admit: false; reason: "hydration-pending" | "generation-changed" | "abmind-unavailable" | "archive-gap" };

export interface SoulGateAdmission {
  abmindAvailable: boolean;
  archiveAcknowledged: boolean;
}

export class PiSoulGate {
  private hydrationPending = true;
  private bundle: unknown = undefined;
  private admittedGeneration = -1;

  /** Begin a session, replacement, or resume: hydration is required. */
  beginSession(): void {
    this.hydrationPending = true;
    this.bundle = undefined;
  }

  /** Successful manual, threshold, or overflow compaction invalidates the bundle. */
  invalidateOnCompaction(): void {
    this.hydrationPending = true;
    this.bundle = undefined;
  }

  /**
   * Complete hydration for an execution generation. A late result for a
   * superseded generation cannot admit another request.
   */
  completeHydration(bundle: unknown, generation: number, currentGeneration: number): boolean {
    if (generation !== currentGeneration) return false;
    if (bundle === undefined) return false;
    this.bundle = bundle;
    this.hydrationPending = false;
    this.admittedGeneration = generation;
    return true;
  }

  /** Cancellation prevents a late hydration result from admitting requests. */
  cancel(): void {
    this.hydrationPending = true;
    this.bundle = undefined;
  }

  get generationPending(): boolean {
    return this.hydrationPending;
  }

  /**
   * Final authority before any conversational provider request, including
   * immediate same-run retries, tool continuations, and agent retries. The
   * compaction summarizer's history-only input is not a conversational
   * request and does not pass through this gate.
   */
  checkRequest(generation: number, admission: SoulGateAdmission): SoulGateDecision {
    if (this.hydrationPending || this.bundle === undefined) {
      return { admit: false, reason: "hydration-pending" };
    }
    if (generation !== this.admittedGeneration) {
      return { admit: false, reason: "generation-changed" };
    }
    if (!admission.abmindAvailable) {
      return { admit: false, reason: "abmind-unavailable" };
    }
    if (!admission.archiveAcknowledged) {
      return { admit: false, reason: "archive-gap" };
    }
    return { admit: true, generation };
  }
}
