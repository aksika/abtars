import type { TelegramUpdate } from "../types/index.js";
import type { TelegramApi } from "./telegram-api.js";
import { logDebug, logError } from "./logger.js";

/**
 * Long-polls the Telegram Bot API for updates. Never self-terminates —
 * uses exponential backoff with jitter on transient errors.
 */
export class TelegramPoller {
  private readonly api: TelegramApi;
  private readonly pollTimeout: number;
  private readonly onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  private offset = 0;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(api: TelegramApi, pollTimeoutS: number, onUpdate: (update: TelegramUpdate) => void | Promise<void>) {
    this.api = api;
    this.pollTimeout = pollTimeoutS;
    this.onUpdate = onUpdate;
  }

  /** Start the long-poll loop. Non-blocking — runs in background. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll().catch((err) => {
      logError("poller", "Fatal error in poll loop", err);
    });
  }

  /** Stop polling. Cancels any in-flight request. */
  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async poll(): Promise<void> {
    let failures = 0;

    while (this.running) {
      try {
        this.abortController = new AbortController();
        logDebug("poller", `getUpdates (offset=${this.offset}, timeout=${this.pollTimeout})`);
        const updates = await this.api.getUpdates(
          this.offset,
          this.pollTimeout,
          this.abortController.signal,
        );

        failures = 0;
        logDebug("poller", `Got ${updates.length} update(s)`);

        if (updates.length > 0) {
          const maxId = Math.max(...updates.map((u) => u.update_id));
          this.offset = maxId + 1;

          for (const update of updates) {
            try {
              await this.onUpdate(update);
            } catch (err) {
              logError("poller", "Error in update handler", err);
            }
          }
        }
      } catch (err) {
        if (!this.running) break;

        failures++;
        const baseDelay = Math.min(2 ** failures * 1000, 60_000);
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay + jitter;
        logError("poller", `Error (attempt ${failures}), retrying in ${Math.round(delay)}ms`, err);
        await sleep(delay);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
