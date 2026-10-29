/**
 * worker-executor-identity.ts — #1637: the one durable executor identity.
 *
 * Every typed read/write surface of the swarm uses this vocabulary: the
 * store's attempt column, the worker result envelope, dispatch, recovery,
 * and retry allocation. There is exactly one synonym set — "agent" | "pi" |
 * "remote" — and one built-in ID per local kind. No translation function
 * exists anywhere; the envelope carries the same value the store carries.
 */
export type ExecutorKind = "agent" | "pi" | "remote";

/** Canonical built-in local executor IDs. */
export const AGENT_EXECUTOR_ID = "spin-local";
export const PI_EXECUTOR_ID = "pi-coding";

/** Strict runtime guard used at SQLite read boundaries. A value outside the
 * canonical set is corruption, never a synonym to collapse. */
export function isExecutorKind(value: unknown): value is ExecutorKind {
  return value === "agent" || value === "pi" || value === "remote";
}

/** Normalize one legacy executor_kind synonym to the canonical value, or
 * return undefined when the value is already canonical/unknown. Migration
 * only — never used at read time. */
export function normalizeLegacyExecutorKind(value: unknown): ExecutorKind | undefined {
  if (value === "local_worker") return "agent";
  if (value === "remote_worker") return "remote";
  if (isExecutorKind(value)) return value;
  return undefined;
}

/** Normalize the legacy built-in Spin executor ID ("spin") to the canonical
 * ID. Only applies to agent-kind execution. */
export function normalizeLegacyExecutorId(kind: ExecutorKind, id: string): string {
  if (kind === "agent" && id === "spin") return AGENT_EXECUTOR_ID;
  return id;
}
