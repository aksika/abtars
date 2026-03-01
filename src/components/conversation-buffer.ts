import { logDebug } from "./logger.js";

const TAG = "ConversationBuffer";

export interface BufferEntry {
  sender: string;
  text: string;
  ts: number;
}

/**
 * Generic conversation history buffer shared across messaging platforms.
 * Accumulates non-triggered messages per channel/thread key and drains
 * them as context when the bot is actually invoked.
 */
export class ConversationBuffer {
  private readonly limit: number;
  private readonly history = new Map<string, BufferEntry[]>();

  constructor(limit = 50) {
    this.limit = limit;
  }

  /** Push a message into the buffer for a given channel key. */
  push(channelKey: string, sender: string, text: string): void {
    let entries = this.history.get(channelKey);
    if (!entries) {
      entries = [];
      this.history.set(channelKey, entries);
    }
    entries.push({ sender, text, ts: Date.now() });
    while (entries.length > this.limit) entries.shift();
    logDebug(TAG, `Buffered message in ${channelKey} (size=${entries.length})`);
  }

  /**
   * Drain all buffered messages for a channel key, returning them as
   * a formatted context string. Clears the buffer for that key.
   * Returns empty string if no history.
   */
  drain(channelKey: string): string {
    const entries = this.history.get(channelKey);
    if (!entries || entries.length === 0) return "";
    const lines = entries.map((e) => `[${e.sender}]: ${e.text}`);
    this.history.delete(channelKey);
    logDebug(TAG, `Drained ${lines.length} entries from ${channelKey}`);
    return "--- Recent conversation context ---\n" + lines.join("\n") + "\n--- End context ---\n\n";
  }

  /** Clear the buffer for a specific channel key. */
  clear(channelKey: string): void {
    this.history.delete(channelKey);
  }
}
