import type { KanbanCard } from "./kanban-board.js";
import { kanbanMarkDelivered, kanbanClaimDelivery, kanbanGetCard, requireTaskDatabase } from "./kanban-board.js";
import { logDebug, logWarn } from "../logger.js";
import { logSwarmTrace } from "../swarm-trace.js";

const TAG = "kanban-delivery";

export interface DeliverDeps {
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendDocument: (chatId: string, filePath: string, caption: string) => Promise<void>;
  announce: (prompt: string) => Promise<void>;
  chatIdFor: (card: KanbanCard) => string;
}

export async function deliverCard(card: KanbanCard, deps: DeliverDeps): Promise<void> {
  if (card.type === "O") {
    const { ProjectReviewStore } = await import("../project-acceptance/project-review-store.js");
    const store = new ProjectReviewStore();
    const sup = store.getSupervision(card.id);
    if (!sup || sup.state !== "accepted") {
      return;
    }
  }

  // Only deliver cards with result_path (report artifacts) or result_summary
  // Skip cards that have already been delivered or have unknown delivery state
  const fresh = kanbanGetCard(card.id);
  if (!fresh) return;
  if (fresh.status === "delivered") {
    logDebug(TAG, `Card ${card.id} already delivered — skipping`);
    return;
  }
  if (fresh.delivery_result === "unknown") {
    logDebug(TAG, `Card ${card.id} delivery_result=unknown — skipping auto-retry`);
    return;
  }

  if (!kanbanClaimDelivery(card.id)) {
    logSwarmTrace({ event: "delivery_claim_lost", card: card.id, reason: "already_claimed_or_delivered" });
    return;
  }
  logSwarmTrace({ event: "delivery_claim_won", card: card.id });
  const chatId = deps.chatIdFor(card);

  if (card.delivery_mode === "silent") {
    kanbanMarkDelivered(card.id);
    logSwarmTrace({ event: "delivery_sent", card: card.id, reason: "silent_mode" });
    return;
  }

  if (card.result_path) {
    try {
      await deps.sendDocument(chatId, card.result_path, card.title);
      markSent(card.id, "sent");
      logSwarmTrace({ event: "delivery_sent", card: card.id, reason: "document" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `sendDocument failed for card ${card.id}: ${msg}`);
      markUnknown(card.id);
      logSwarmTrace({ event: "delivery_failed", card: card.id, reason: "send_document_failed" });
    }
    return;
  }

  if (card.delivery_mode === "announce") {
    const text = card.result_summary
      ? `${card.title} complete.\n\n${card.result_summary}`
      : `${card.title} complete.`;
    try {
      await deps.sendMessage(chatId, text);
      markSent(card.id, "sent");
      logSwarmTrace({ event: "delivery_sent", card: card.id, reason: "announce" });
    } catch {
      markUnknown(card.id);
      logSwarmTrace({ event: "delivery_failed", card: card.id, reason: "announce_failed" });
    }
    return;
  }

  const summary = card.result_summary ? `\n\n${card.result_summary}` : "";
  try {
    await deps.sendMessage(chatId, `${card.title} complete.${summary}`);
    markSent(card.id, "sent");
    logSwarmTrace({ event: "delivery_sent", card: card.id, reason: "message" });
  } catch {
    markUnknown(card.id);
    logSwarmTrace({ event: "delivery_failed", card: card.id, reason: "message_failed" });
  }
}

function markSent(cardId: number, receipt: string): void {
  try {
    const db = requireTaskDatabase();
    db.prepare(
      `UPDATE kanban_board SET status = 'delivered', delivery_result = 'sent', delivery_receipt = ?, delivered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(receipt, cardId);
    logDebug(TAG, `Card ${cardId}: marked sent`);
  } catch (err) {
    logWarn(TAG, `markSent failed for card ${cardId}: ${err}`);
  }
}

function markUnknown(cardId: number): void {
  try {
    const db = requireTaskDatabase();
    db.prepare(
      `UPDATE kanban_board SET status = 'done', delivery_result = 'unknown', updated_at = datetime('now') WHERE id = ? AND delivery_result IS NULL`
    ).run(cardId);
    logWarn(TAG, `Card ${cardId}: delivery_result=unknown (send failed)`);
  } catch (err) {
    logWarn(TAG, `markUnknown failed for card ${cardId}: ${err}`);
  }
}

export function markDefinitelyNotSent(cardId: number): void {
  try {
    const db = requireTaskDatabase();
    db.prepare(
      `UPDATE kanban_board SET delivery_result = 'definitely_not_sent', status = 'done', updated_at = datetime('now') WHERE id = ?`
    ).run(cardId);
    logDebug(TAG, `Card ${cardId}: delivery_result=definitely_not_sent`);
  } catch (err) {
    logWarn(TAG, `markDefinitelyNotSent failed for card ${cardId}: ${err}`);
  }
}

