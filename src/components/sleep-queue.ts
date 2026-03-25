import { logInfo } from "./logger.js";
import type { QueuedMessage, PlatformAdapter } from "../types/platform.js";

/**
 * Platform-agnostic message queue for the sleep/wake cycle.
 * Queues inbound messages while the sleep routine runs,
 * then replays them through the appropriate platform adapter on wake.
 */
export class SleepQueue {
  private readonly queue: QueuedMessage[] = [];
  private readonly repliedSessions = new Set<string>();

  get isActive(): boolean {
    return this._active;
  }
  private _active = false;

  activate(): void {
    this._active = true;
  }

  deactivate(): void {
    this._active = false;
    this.repliedSessions.clear();
  }

  /** Returns true if this is the first message for this session (caller should send wake-up reply). */
  enqueue(msg: QueuedMessage): boolean {
    this.queue.push(msg);
    if (this.repliedSessions.has(msg.sessionKey)) return false;
    this.repliedSessions.add(msg.sessionKey);
    return true;
  }

  /**
   * Replay queued messages through platform adapters.
   * Groups messages by sessionKey, merges text, and calls adapter.injectMessage().
   */
  replay(adapters: Map<string, PlatformAdapter>): void {
    this.repliedSessions.clear();
    if (this.queue.length === 0) return;
    logInfo("sleep-queue", `Replaying ${this.queue.length} message(s) queued during sleep`);

    const grouped = new Map<string, QueuedMessage[]>();
    for (const msg of this.queue) {
      const group = grouped.get(msg.sessionKey);
      if (group) group.push(msg);
      else grouped.set(msg.sessionKey, [msg]);
    }
    this.queue.length = 0;

    for (const msgs of grouped.values()) {
      const first = msgs[0]!;
      const combinedText = msgs.map((m) => m.text).join("\n\n");
      const adapter = adapters.get(first.platform);
      if (adapter?.injectMessage) {
        adapter.injectMessage({
          platform: first.platform,
          channelId: first.channelId,
          sessionKey: first.sessionKey,
          senderId: "",
          senderName: "queued",
          text: combinedText,
          timestamp: Date.now(),
          threadId: first.threadId,
          isGroup: false,
          isVoice: false,
        });
      } else {
        logInfo("sleep-queue", `No adapter for ${first.platform}, dropping ${msgs.length} queued message(s)`);
      }
    }
  }
}
