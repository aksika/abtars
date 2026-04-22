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
          const settlements = new Map<number, boolean>();

          const settle = async (id: number, ok: boolean): Promise<void> => {
            settlements.set(id, ok);
            // Advance offset to highest contiguous success from the batch start.
            let newOffset = this.offset;
            for (const u of sorted) {
              const s = settlements.get(u.update_id);
              if (s === true) {
                newOffset = u.update_id + 1;
              } else {
                break; // gap — either pending or failed
              }
            }
            if (newOffset > this.offset) {
              this.offset = newOffset;
              await this.offsetStore.write(newOffset);
            }
          };

          for (const update of sorted) {
            try {
              const result = this.onUpdate(update);
              if (result instanceof Promise) {
                // Fire-and-forget: settle when done, don't block the loop.
                result
                  .then(() => settle(update.update_id, true))
                  .catch((err: unknown) => {
                    logError("poller", "Error in update handler", err);
                    settle(update.update_id, false);
                  });
              } else {
                // Synchronous handler — settled immediately.
                await settle(update.update_id, true);
              }
            } catch (err) {
              logError("poller", "Error in update handler", err);
              await settle(update.update_id, false);
            }
          }

          // Wait for all handlers to settle before next getUpdates,
          // so we don't re-fetch updates that are still in-flight.
          await waitForAll(sorted, settlements);
        }
      } catch (err) {
        if (!this.running) break;

        failures++;
        const baseDelay = Math.min(2 ** failures * 1000, 60_000);
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay + jitter;
        const log = failures < 3 ? logWarn : logError;
        log("poller", `Error (attempt ${failures}), retrying in ${Math.round(delay)}ms`, err);
        await sleep(delay);
      }
    }
  }
}

/** Wait until all updates in the batch have settled (success or failure). */
async function waitForAll(sorted: TelegramUpdate[], settlements: Map<number, boolean>): Promise<void> {
  while (settlements.size < sorted.length) {
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
