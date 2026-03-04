import { logDebug, logWarn } from "./logger.js";

const TAG = "ctx-monitor";

/**
 * Monitors context window token usage and schedules async rolling summary
 * compression when usage exceeds a configurable threshold.
 *
 * The monitor is called during context assembly. If `shouldCompress()` returns
 * true, compression is scheduled via `process.nextTick()` to run after the
 * current event loop cycle — it does NOT block the current LLM request.
 */
export class ContextWindowMonitor {
  constructor(
    private thresholdPct: number,
    private onCompress: (channelKey: string) => Promise<void>,
  ) {}

  /**
   * Check if context window usage exceeds the threshold.
   * Returns true when `(currentTokens / maxTokens) * 100 > thresholdPct`.
   */
  shouldCompress(currentTokens: number, maxTokens: number): boolean {
    if (maxTokens <= 0) return false;
    const usagePct = (currentTokens / maxTokens) * 100;
    const result = usagePct > this.thresholdPct;
    logDebug(TAG, `Usage ${usagePct.toFixed(1)}% (threshold ${this.thresholdPct}%) → ${result ? "compress" : "skip"}`);
    return result;
  }

  /**
   * Schedule rolling summary compression to run after the current event loop
   * cycle completes. Does NOT block the current request.
   */
  scheduleCompression(channelKey: string): void {
    logDebug(TAG, `Scheduling compression for channel "${channelKey}"`);
    process.nextTick(() => {
      this.onCompress(channelKey).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `Compression failed for channel "${channelKey}": ${msg}`);
      });
    });
  }
}
