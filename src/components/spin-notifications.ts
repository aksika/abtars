/**
 * spin-notifications.ts — Per-project notification buffer for Orc (#907).
 * Subscribes to Nerve card:done/card:failed. Buffers structured messages
 * keyed by parent_id. Orc drains its project's buffer before each turn.
 */

import { nerve } from "./nerve.js";
import { kanbanGetCard } from "./tasks/kanban-board.js";

const buffers = new Map<number, string[]>();

nerve.on("card:done", (cardId: number) => {
  const card = kanbanGetCard(cardId);
  if (!card || !card.parent_id) return;
  const buf = buffers.get(card.parent_id) ?? [];
  buf.push(`[WORKER COMPLETE] Card #${cardId} "${card.title}" — done. Summary: "${card.result_summary?.slice(0, 150) ?? ""}"`);
  buffers.set(card.parent_id, buf);
});

nerve.on("card:failed", (cardId: number) => {
  const card = kanbanGetCard(cardId);
  if (!card || !card.parent_id) return;
  const buf = buffers.get(card.parent_id) ?? [];
  buf.push(`[WORKER FAILED] Card #${cardId} "${card.title}" — ${card.error?.slice(0, 100) ?? "unknown error"}`);
  buffers.set(card.parent_id, buf);
});

/** Drain notifications for a specific project card. Returns and clears buffered messages. */
export function drainOrcNotifications(projectCardId: number): string[] {
  const msgs = buffers.get(projectCardId) ?? [];
  buffers.delete(projectCardId);
  return msgs;
}
