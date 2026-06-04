/**
 * Env var helpers.
 *
 * `readEnv(key, impact)` reads process.env[key] and warns once per process
 * per missing key. Replaces raw `process.env.X` reads — authors get
 * visibility into misconfig without polluting hot paths with per-read
 * warnings.
 *
 * The helper intentionally warns AT the first read site (lazy), not at
 * boot. Reasons:
 *   - Boot-time lists go stale; consumer-site reads can't.
 *   - New env vars auto-covered when authors reach for this helper.
 *   - Warn-once guarantees quiet hot paths (Set<string> dedup).
 *
 * For vars that MUST be set for the bridge to function (e.g. TELEGRAM_BOT_TOKEN),
 * use a boot-time fatal check instead — missing them should exit(1), not log.
 */

import { logTrace } from "./logger.js";

const warned = new Set<string>();

export function readEnv(key: string, impact: string): string | undefined {
  const v = process.env[key];
  if (v !== undefined && v.trim() !== "") return v;
  if (!warned.has(key)) {
    warned.add(key);
    logTrace("env", `${key} not set — ${impact}`);
  }
  return undefined;
}

/** Same as readEnv but returns a fallback when the var is unset. Still warns once. */
export function readEnvWithDefault(key: string, fallback: string, impact: string): string {
  const v = readEnv(key, `${impact} (falling back to "${fallback}")`);
  return v ?? fallback;
}

/** Test-only: clear the warn-once cache. */
export function _resetEnvWarnedForTests(): void {
  warned.clear();
}
