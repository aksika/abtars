/**
 * heartbeat-watchdog.ts — In-process wall-clock watchdog.
 * Detects stuck heartbeat (no kick for 3× interval) and forces restart.
 * Circuit breaker suppresses if 3+ restarts in 5min.
 */

import { logWarn } from "../components/logger.js";
import { writeRestartReason, appendRestartTimestamp, readRestartTimestamps } from "../components/transport/bridge-lock-transport.js";
import { classifyResume } from "../components/platform-detect.js";

const WD_CHECK_INTERVAL = 60_000;
const WD_UNKNOWN_SUPPRESS_MS = 60 * 60_000;
const CIRCUIT_BREAKER_MAX = 3;
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60_000;

export function startInProcWatchdog(opts: { thresholdMs: number }): { kick: () => void } {
  let lastKickAt = Date.now();
  let lastCheckAt = Date.now();

  const recentTimestamps = readRestartTimestamps();
  const recentCount = recentTimestamps.filter(t => Date.now() - t < CIRCUIT_BREAKER_WINDOW_MS).length;
  const suppressed = recentCount >= CIRCUIT_BREAKER_MAX;
  if (suppressed) {
    logWarn("watchdog", `⚡ Circuit breaker: ${recentCount} restarts in last 5min — in-process watchdog suppressed this session`);
  }

  setInterval(() => {
    const now = Date.now();
    const checkGap = now - lastCheckAt;
    lastCheckAt = now;
    if (checkGap > WD_CHECK_INTERVAL * 3) {
      lastKickAt = now;
      return;
    }
    const elapsed = now - lastKickAt;
    if (elapsed <= opts.thresholdMs) return;
    const kind = classifyResume();
    if (kind === "dark" || (kind === "unknown" && elapsed < WD_UNKNOWN_SUPPRESS_MS)) {
      lastKickAt = Date.now();
      return;
    }
    if (suppressed) {
      lastKickAt = Date.now();
      return;
    }
    logWarn("watchdog", `No heartbeat kick for ${Math.round(elapsed / 60000)}min (${kind}) — forcing restart`);
    appendRestartTimestamp();
    writeRestartReason("watchdog: no heartbeat kick");
    process.exit(1);
  }, WD_CHECK_INTERVAL);

  return { kick: () => { lastKickAt = Date.now(); } };
}
