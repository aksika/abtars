import type { TelegramUpdate } from "../../types/index.js";
import type { TelegramApi } from "./telegram-api.js";
import type { OffsetStore } from "./offset-store.js";
import { logError, logWarn } from "../../components/logger.js";

/**
 * Long-polls the Telegram Bot API for updates. Never self-terminates —
 * uses exponential backoff with jitter on transient errors.
 *
 * Offset is advanced per-update AFTER the handler settles (success only).
 * Handlers run fire-and-forget to keep /stop responsive; the disk offset
 * only advances once the contiguous prefix of settled handlers is known.
 */
export class TelegramPoller {
  private readonly api: TelegramApi;
  private readonly pollTimeout: number;
  private readonly onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  private readonly offsetStore: OffsetStore;
  private offset = 0;
  private running = false;
  private abortController: AbortController | null = null;

  /** Timestamp of last successful poll cycle. */
  lastPollAt = Date.now();

  constructor(
    api: TelegramApi,
    pollTimeoutS: number,
    onUpdate: (update: TelegramUpdate) => void | Promise<void>,
    offsetStore?: OffsetStore,
  ) {
    this.api = api;
    this.pollTimeout = pollTimeoutS;
    this.onUpdate = onUpdate;
    this.offsetStore = offsetStore ?? { read: async () => 0, write: async () => {} };
  }

  /** Start the long-poll loop. Non-blocking — runs in background. */
  async start(): Promise<void> {
    if (this.running) return;
    this.offset = await this.offsetStore.read();
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

  /** Inject a synthetic update into the handler (used for queued messages after sleep). */
  injectUpdate(update: TelegramUpdate): void {
    void this.onUpdate(update);
  }

  private async poll(): Promise<void> {
    let failures = 0;

    while (this.running) {
      try {
        this.abortController = new AbortController();
        const updates = await this.api.getUpdates(
          this.offset,
          this.pollTimeout,
          this.abortController.signal,
        );

        failures = 0;
        this.lastPollAt = Date.now();

        // Process each update: dispatch handler, advance offset only on success.
        // Handlers run in background (fire-and-forget) so /stop stays responsive.
        // We track settlements and advance the disk offset for the contiguous
        // prefix of successfully-handled updates.
        if (updates.length > 0) {
          const sorted = [...updates].sort((a, b) => a.update_id - b.update_id);

          for (const update of sorted) {
            try {
              const result = this.onUpdate(update);
              if (result instanceof Promise) {
                result.catch((err: unknown) => logError("poller", "Error in update handler", err));
              }
            } catch (err) {
              logError("poller", "Error in update handler (sync)", err);
            }
          }

          // Advance offset immediately — don't wait for handlers to settle.
          // Next getUpdates will fetch new messages without blocking on in-flight handlers.
          this.offset = sorted[sorted.length - 1]!.update_id + 1;
          await this.offsetStore.write(this.offset);
        }
      } catch (err) {
        if (!this.running) break;

        failures++;
        const baseDelay = Math.min(2 ** failures * 1000, 60_000);
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay + jitter;
        const is409 = String(err).includes("409") || String(err).includes("terminated by other getUpdates");
        const log = is409 ? (failures >= 50 ? logError : logWarn) : (failures < 3 ? logWarn : logError);
        if (is409 && failures < 50) {
          log("poller", `409 conflict (attempt ${failures}) — another instance running, backing off`);
        } else {
          log("poller", `Error (attempt ${failures}), retrying in ${Math.round(delay)}ms`, err);
        }
        await sleep(delay);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
