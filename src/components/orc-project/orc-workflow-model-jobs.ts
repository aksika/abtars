/**
 * orc-workflow-model-jobs.ts — #1935: generation-owned model-job lifetimes.
 *
 * The workflow driver owns one registry per bridge generation. Planner and
 * reviewer backends register a job synchronously with the claim authority
 * returned by `claimCommand` before any asynchronous work begins; the runner
 * validates that same authority inside its transition transactions.
 *
 * Removal means the lifecycle obligation was resolved. It is not proof that an
 * external provider stopped: abort is advisory to Spin, and inspection treats
 * an overdue or absent entry as an explicit unknown outcome rather than
 * inferring termination from a rejected promise or expiry alone.
 */
import type { CommandKey } from "./orc-workflow-store.js";

/** Claim authority captured from `claimCommand` (never the drained pending row). */
export interface ClaimAuthority {
  key: CommandKey;
  owner: string;
  token: string;
}

export type ModelJobKind = "planning" | "review";

export interface ModelJobRegistration {
  claim: ClaimAuthority;
  kind: ModelJobKind;
  opId: string;
  revision: number | null;
  timeoutMs: number;
}

export interface ModelJobHandle {
  readonly token: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export type ModelJobDisposition = "active" | "expired" | "ownerless";

/**
 * #1935: driver-generation shutdown aborts transport work but must not settle
 * the domain as an execution failure — the startup interruption barrier owns
 * the run's terminal fact after the restart.
 */
export const MODEL_JOB_SHUTDOWN_REASON = "driver shutdown";

/**
 * Process-wide terminal notification (#1935): every WorkflowRunner instance
 * (driver, scheduled waiter, peer admission, SHA) commits through the same
 * store, but only the driver owns the generation's model-call registry. A
 * terminal fact must revoke call authority regardless of which runner wrote it.
 */
const terminalSubscribers = new Set<(runId: string) => void>();

export function subscribeWorkflowTerminal(listener: (runId: string) => void): () => void {
  terminalSubscribers.add(listener);
  return () => { terminalSubscribers.delete(listener); };
}

export function notifyWorkflowTerminal(runId: string): void {
  for (const listener of terminalSubscribers) {
    try { listener(runId); } catch { /* a listener failure cannot undo the terminal fact */ }
  }
}

interface Entry {
  claim: ClaimAuthority;
  kind: ModelJobKind;
  opId: string;
  revision: number | null;
  deadlineAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  finished: boolean;
}

/**
 * One workflow-generation model-call registry. Not persisted: startup fails
 * every old workflow before a new generation can admit work, so no durable
 * boot identity is needed.
 */
export class ModelJobRegistry {
  private readonly jobs = new Map<string, Entry>();

  /** Register before asynchronous work starts; the deadline covers preparation. */
  begin(registration: ModelJobRegistration): ModelJobHandle {
    const token = registration.claim.token;
    const previous = this.jobs.get(token);
    if (previous) {
      if (previous.timer) clearTimeout(previous.timer);
      this.jobs.delete(token);
    }
    const deadlineAt = Date.now() + Math.max(1, registration.timeoutMs);
    const controller = new AbortController();
    const entry: Entry = {
      claim: registration.claim,
      kind: registration.kind,
      opId: registration.opId,
      revision: registration.revision,
      deadlineAt,
      controller,
      timer: null,
      settled: false,
      finished: false,
    };
    entry.timer = setTimeout(() => {
      if (!entry.settled && !entry.finished) controller.abort("deadline");
    }, Math.max(1, registration.timeoutMs));
    entry.timer.unref?.();
    this.jobs.set(token, entry);
    return { token, deadlineAt, signal: controller.signal };
  }

  /**
   * Claim the single domain settlement for a live job. False means another
   * authority (inspection, terminal transition, deadline sweep) already owns
   * the outcome; the caller must do nothing further.
   */
  claimSettlement(token: string): boolean {
    const entry = this.jobs.get(token);
    if (!entry || entry.settled || entry.finished) return false;
    entry.settled = true;
    return true;
  }

  /** Whether this generation still owns a settlement for the claim. */
  owns(token: string): boolean {
    const entry = this.jobs.get(token);
    return entry !== undefined && !entry.settled && !entry.finished;
  }

  /** Classify a due claim for the live audit: active, deadline-expired or absent. */
  classify(token: string, now = Date.now()): ModelJobDisposition {
    const entry = this.jobs.get(token);
    if (!entry || entry.settled || entry.finished) return "ownerless";
    return now < entry.deadlineAt ? "active" : "expired";
  }

  /** Read the registered kind/op identity for an owned job (diagnostics/tests). */
  describe(token: string): { kind: ModelJobKind; opId: string; revision: number | null; deadlineAt: number } | null {
    const entry = this.jobs.get(token);
    if (!entry) return null;
    return { kind: entry.kind, opId: entry.opId, revision: entry.revision, deadlineAt: entry.deadlineAt };
  }

  /** Remaining lifetime of a live job (0 when absent/settled). */
  remainingMs(token: string, now = Date.now()): number {
    const entry = this.jobs.get(token);
    if (!entry || entry.settled || entry.finished) return 0;
    return Math.max(0, entry.deadlineAt - now);
  }

  /** Abort an overdue call; the backend's settle-once catch resolves the domain. */
  abort(token: string, reason = "deadline"): boolean {
    const entry = this.jobs.get(token);
    if (!entry || entry.settled || entry.finished || entry.controller.signal.aborted) return false;
    entry.controller.abort(reason);
    return true;
  }

  /** A terminal workflow transition revokes callback and execution authority. */
  abortRun(runId: string, reason = "workflow terminal"): number {
    let aborted = 0;
    for (const entry of this.jobs.values()) {
      if (entry.claim.key.runId !== runId) continue;
      if (entry.settled || entry.finished) continue;
      // Revoke settlement authority first: a late success can no longer
      // publish a result for a run whose terminal fact already committed.
      entry.settled = true;
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(reason);
        aborted++;
      }
    }
    return aborted;
  }

  /** Driver-generation shutdown: abort every live call before the driver stops. */
  abortAll(reason = MODEL_JOB_SHUTDOWN_REASON): number {
    let aborted = 0;
    for (const entry of this.jobs.values()) {
      if (entry.settled || entry.finished) continue;
      // Revoke callback authority before aborting: generation shutdown leaves
      // the run to the startup interruption barrier, never to a late result.
      entry.settled = true;
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(reason);
        aborted++;
      }
    }
    return aborted;
  }

  /** Release the registry entry after settlement (timer cleanup, late-call fence). */
  finish(token: string): void {
    const entry = this.jobs.get(token);
    if (!entry) return;
    entry.finished = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.jobs.delete(token);
  }

  /** Live (unfinished) entry count — diagnostics and tests only. */
  get size(): number {
    return this.jobs.size;
  }
}
