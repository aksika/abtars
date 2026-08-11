/**
 * system-task-registry.ts — allowlisted in-process task executor (#1321).
 *
 * A `system` task entry selects a bridge-internal action from a compile-time
 * allowlist — never a command, module, path, or arbitrary payload supplied by
 * task JSON. Handlers are registered at boot wiring (not loaded from data) and
 * dispatch is a constant-time synchronous (or short async) operation that
 * returns promptly so CronQueue and heartbeat are not blocked.
 *
 * A handler whose action outlives the run must still return promptly in the
 * sense of not blocking the queue — it MAY await its long action (dispatch
 * runs detached), provided it reports progress and honors cancellation.
 *
 * This is NOT a plugin surface and cannot load handlers from task data.
 */

import { logInfo, logWarn } from "../logger.js";
import type { ScheduledTask, SystemTaskAction } from "./task-types.js";

const TAG = "system-task";

/** Host-provided run context for one system action. */
export interface SystemTaskContext {
  /**
   * Meaningful progress. Rolls the occurrence's rolling inactivity limit
   * forward (#1600). A handler whose action outlives TASK_RUN_IDLE_BUDGET_MS
   * MUST call this, or the run-deadline source settles the run as
   * deadline_exceeded while the action is still healthy.
   */
  progress(detail?: string): void;
  /** Aborted when the occurrence is cancelled or a deadline fires. */
  readonly signal: AbortSignal;
}

/**
 * Result of dispatching a system action. `ok` means the action COMPLETED
 * successfully — not that it was started. A handler that owns a long action
 * awaits it and returns its real outcome.
 */
export type SystemTaskResult =
  | { status: "ok"; detail?: string }
  | { status: "noop"; detail?: string }
  | { status: "deferred"; retryAt: number; detail: string }
  | { status: "failed"; error: string };

/** A handler for one allowlisted action. */
export type SystemTaskHandler = (
  entry: Readonly<ScheduledTask>,
  ctx: SystemTaskContext,
) => SystemTaskResult | Promise<SystemTaskResult>;

/**
 * Registry of allowlisted in-process actions. One instance per bridge. Handlers
 * register during boot wiring; dispatch looks up the exact action and passes
 * only the validated, read-only entry plus the run context.
 */
export class SystemTaskRegistry {
  private readonly handlers = new Map<SystemTaskAction, SystemTaskHandler>();

  /** Register a handler for an action. Rejects duplicates. Returns a deregister fn. */
  register(action: SystemTaskAction, handler: SystemTaskHandler): () => void {
    if (this.handlers.has(action)) {
      throw new Error(`SystemTaskRegistry: action "${action}" already registered`);
    }
    this.handlers.set(action, handler);
    logInfo(TAG, `Registered system action "${action}"`);
    return () => { this.handlers.delete(action); };
  }

  /** True iff a handler is registered for `action`. */
  has(action: SystemTaskAction): boolean {
    return this.handlers.has(action);
  }

  /** Dispatch a validated system entry to its handler. */
  async dispatch(entry: Readonly<ScheduledTask>, ctx: SystemTaskContext): Promise<SystemTaskResult> {
    if (entry.kind !== "system" || !entry.action) {
      return { status: "failed", error: `entry is not a system task` };
    }
    const handler = this.handlers.get(entry.action);
    if (!handler) {
      // Unknown action — never fall back to another executor.
      logWarn(TAG, `Unknown system action "${entry.action}" — no handler registered`);
      return { status: "failed", error: `unknown system action "${entry.action}"` };
    }
    try {
      return await handler(entry, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `System action "${entry.action}" threw: ${msg}`);
      return { status: "failed", error: msg };
    }
  }
}

/** Process-wide singleton (one bridge per process). */
let _registry: SystemTaskRegistry | null = null;

export function getSystemTaskRegistry(): SystemTaskRegistry {
  if (!_registry) _registry = new SystemTaskRegistry();
  return _registry;
}

/** Reset the singleton — tests only. */
export function _resetSystemTaskRegistry(): void {
  _registry = null;
}
