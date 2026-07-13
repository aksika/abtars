/**
 * system-task-registry.ts — allowlisted in-process task executor (#1321).
 *
 * A `system` task entry selects a bridge-internal action from a compile-time
 * allowlist — never a command, module, path, or arbitrary payload supplied by
 * task JSON. Handlers are registered at boot wiring (not loaded from data) and
 * dispatch is a constant-time synchronous (or short async) operation that
 * returns promptly so CronQueue and heartbeat are not blocked.
 *
 * This is NOT a plugin surface and cannot load handlers from task data.
 */

import { logInfo, logWarn } from "../logger.js";
import type { CronEntry, SystemTaskAction } from "./task-types.js";

const TAG = "system-task";

/** Result of dispatching a system action. */
export type SystemTaskResult =
  | { status: "accepted"; detail?: string }
  | { status: "noop"; detail?: string }
  | { status: "deferred"; retryAt: number; detail: string }
  | { status: "failed"; error: string };

/** A handler for one allowlisted action. Returns promptly. */
export type SystemTaskHandler = (entry: Readonly<CronEntry>) => SystemTaskResult | Promise<SystemTaskResult>;

/**
 * Registry of allowlisted in-process actions. One instance per bridge. Handlers
 * register during boot wiring; dispatch looks up the exact action and passes
 * only the validated, read-only entry.
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
  async dispatch(entry: Readonly<CronEntry>): Promise<SystemTaskResult> {
    if (entry.executor !== "system" || !entry.action) {
      return { status: "failed", error: `entry is not a system task` };
    }
    const handler = this.handlers.get(entry.action);
    if (!handler) {
      // Unknown action — never fall back to another executor.
      logWarn(TAG, `Unknown system action "${entry.action}" — no handler registered`);
      return { status: "failed", error: `unknown system action "${entry.action}"` };
    }
    try {
      return await handler(entry);
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
