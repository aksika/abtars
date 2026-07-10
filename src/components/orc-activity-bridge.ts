import { nerve, type NerveEvent } from "./nerve.js";
import { type OrcActivityFeed, type CardActivityKind } from "./orc-activity-feed.js";
import { kanbanGetCard, resolveRootId } from "./tasks/kanban-board.js";
import type { ManagedSession } from "./spin-types.js";
import { logWarn } from "./logger.js";

const TAG = "orc-bridge";

const CARD_EVENT_KINDS: Record<string, CardActivityKind> = {
  "card:queued": "card.queued",
  "card:running": "card.running",
  "card:done": "card.completed",
  "card:failed": "card.failed",
  "card:delivered": "card.delivered",
};

const CARD_NERVE_EVENTS: NerveEvent[] = ["card:queued", "card:running", "card:done", "card:failed", "card:delivered"];

/**
 * #1319: Bridge Nerve events into the Orc activity feed.
 * Subscribes to card and channel events, resolves their root card,
 * finds the Orc session whose root matches, and publishes a bounded event.
 *
 * Returns an unsubscribe function for teardown.
 */
export function bridgeNerveToFeed(
  feed: OrcActivityFeed,
  listOrcSessions: () => ManagedSession[],
): () => void {
  const handlers: Array<() => void> = [];

  for (const nerveEvent of CARD_NERVE_EVENTS) {
    const handler = (cardId: number): void => {
      try {
        const card = kanbanGetCard(cardId);
        if (!card) return;

        const rootId = resolveRootId(cardId);
        if (rootId === undefined) return;

        // Find Orc session whose activeRootCardId matches
        const orc = listOrcSessions().find(s => s.activeRootCardId === rootId);
        if (!orc) return;
        if (!orc.activeExecutionId) return;

        feed.publish({
          kind: CARD_EVENT_KINDS[nerveEvent],
          title: card.title.slice(0, 200),
          status: card.status,
          sessionId: orc.id,
          executionId: orc.activeExecutionId,
          rootCardId: rootId,
          cardId: card.id,
          parentCardId: card.parent_id ?? undefined,
        });
      } catch (err) {
        logWarn(TAG, `card handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    nerve.on(nerveEvent, handler);
    handlers.push(() => nerve.off(nerveEvent, handler));
  }

  // Channel messages
  const channelHandler = (cardId: number, meta?: Record<string, unknown>): void => {
    try {
      if (!meta || typeof meta.from !== "string" || typeof meta.message !== "string") return;

      const rootId = resolveRootId(cardId);
      if (rootId === undefined) return;

      const orc = listOrcSessions().find(s => s.activeRootCardId === rootId);
      if (!orc) return;
      if (!orc.activeExecutionId) return;

      feed.publish({
        kind: "channel.message",
        from: meta.from,
        to: typeof meta.to === "string" ? meta.to : "ALL",
        message: meta.message.slice(0, 200),
        sessionId: orc.id,
        executionId: orc.activeExecutionId,
        rootCardId: rootId,
        cardId,
      });
    } catch (err) {
      logWarn(TAG, `channel handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  nerve.on("channel:message", channelHandler as any);
  handlers.push(() => nerve.off("channel:message", channelHandler as any));

  return () => { for (const h of handlers) h(); };
}
