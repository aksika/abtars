/**
 * Harness liveness shared constants (#1914).
 *
 * Zero-dependency module on purpose: fixture-bridge.ts is bundled by esbuild
 * into the fixture artifact, so anything it imports lands in that bundle.
 * Importing world.ts (child_process, builders) there would bloat every
 * fixture with runner machinery. Both sides and the selftests share this
 * file instead; keep it free of node: imports beyond types.
 */

/** Env var carrying the scenario heartbeat file path to fixtures. */
export const HARNESS_HEARTBEAT_ENV = "ABTARS_HARNESS_HEARTBEAT";

/**
 * Stale threshold. Floor (>2 orders of magnitude): the longest legitimate
 * fixture stoppage found in the T1 audit is a sub-second SIGSTOP freeze,
 * plus sleep-scale margin so a closed lid mid-suite cannot suicide live
 * fixtures.
 */
export const HARNESS_HEARTBEAT_STALE_MS = 120_000;

/** Pure staleness predicate (unit-testable; wall clock injected). */
export function isHeartbeatStale(mtimeMs: number, nowMs: number, staleMs: number): boolean {
  return nowMs - mtimeMs > staleMs;
}

/**
 * Tombstone content the runner writes at teardown retire. A missing file
 * means never supervised (exempt); a retired file means supervision ended
 * (exit) — this distinction is what keeps post-teardown respawns from being
 * born exempt into immortality.
 */
export const HARNESS_HEARTBEAT_RETIRED = "retired";

export function isHeartbeatRetired(content: string | null): boolean {
  return content === HARNESS_HEARTBEAT_RETIRED;
}
