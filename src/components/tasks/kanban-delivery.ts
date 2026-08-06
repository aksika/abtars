import type { KanbanCard } from "./kanban-board.js";
import { kanbanMarkDelivered, kanbanClaimDelivery, kanbanGetCard, kanbanPending, kanbanTransition, sqliteNow } from "./kanban-board.js";
import { logDebug, logWarn } from "../logger.js";
import { logSwarmTrace } from "../swarm-trace.js";
const TAG = "kanban-delivery";

/**
 * #1520: send outcome classification. `not_sent` means the boundary knows the
 * message was definitely not sent (adapter unavailable, invalid target) and
 * the card returns to the bounded poll retry. `unknown` means the send may
 * have partially happened — no automatic resend, operator review only.
 */
export type SendOutcome = "sent" | "not_sent" | "unknown";

export interface DeliverDeps {
  sendMessage: (chatId: string, text: string) => Promise<SendOutcome>;
  sendDocument: (chatId: string, filePath: string, caption: string) => Promise<SendOutcome>;
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
  if (fresh.delivery_ready === 0) {
    logDebug(TAG, `Card ${card.id} is awaiting scheduled settlement — skipping`);
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
      const outcome = await deps.sendDocument(chatId, card.result_path, card.title);
      recordOutcome(card.id, outcome, "document");
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
      const outcome = await deps.sendMessage(chatId, text);
      recordOutcome(card.id, outcome, "announce");
    } catch {
      markUnknown(card.id);
      logSwarmTrace({ event: "delivery_failed", card: card.id, reason: "announce_failed" });
    }
    return;
  }

  const summary = card.result_summary ? `\n\n${card.result_summary}` : "";
  try {
    const outcome = await deps.sendMessage(chatId, `${card.title} complete.${summary}`);
    recordOutcome(card.id, outcome, "message");
  } catch {
    markUnknown(card.id);
    logSwarmTrace({ event: "delivery_failed", card: card.id, reason: "message_failed" });
  }
}

/** #1520: record a delivery diagnostic on the card and route by outcome. */
function recordOutcome(cardId: number, outcome: SendOutcome, kind: string): void {
  if (outcome === "sent") {
    markSent(cardId, "sent");
    logSwarmTrace({ event: "delivery_sent", card: cardId, reason: kind });
    return;
  }
  if (outcome === "not_sent") {
    // Definitely not sent → back to the bounded poll for a delivery-only retry.
    markDefinitelyNotSent(cardId);
    logSwarmTrace({ event: "delivery_failed", card: cardId, reason: kind });
    return;
  }
  markUnknown(cardId);
  logSwarmTrace({ event: "delivery_failed", card: cardId, reason: kind });
}

/** #1520: the delivery poll — bounded claim over all done cards (≤5 attempts). */
export async function pollPendingDeliveries(deps: DeliverDeps): Promise<number> {
  let attempted = 0;
  for (const card of kanbanPending()) {
    await deliverCard(card, deps).catch(err => {
      logWarn(TAG, `deliverCard failed for card ${card.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    attempted++;
  }
  return attempted;
}

function markSent(cardId: number, receipt: string): void {
  try {
    kanbanTransition({
      cardId, from: ["delivering"], to: "delivered", actor: "delivery_settle",
      reason: "delivery sent",
      fields: { delivery_result: "sent", delivery_receipt: receipt, delivered_at: sqliteNow() },
      emit: false,
    });
    logDebug(TAG, `Card ${cardId}: marked sent`);
  } catch (err) {
    logWarn(TAG, `markSent failed for card ${cardId}: ${err}`);
  }
}

function markUnknown(cardId: number): void {
  try {
    kanbanTransition({
      cardId, from: ["delivering"], to: "done", actor: "delivery_settle",
      reason: "delivery unknown",
      fields: { delivery_result: "unknown" },
      extraPredicate: "delivery_result IS NULL",
      emit: false,
    });
    logWarn(TAG, `Card ${cardId}: delivery_result=unknown (send failed)`);
  } catch (err) {
    logWarn(TAG, `markUnknown failed for card ${cardId}: ${err}`);
  }
}

export function markDefinitelyNotSent(cardId: number): void {
  try {
    kanbanTransition({
      cardId, from: ["delivering"], to: "done", actor: "delivery_settle",
      reason: "delivery definitely not sent",
      fields: { delivery_result: "definitely_not_sent" },
      emit: false,
    });
    logDebug(TAG, `Card ${cardId}: delivery_result=definitely_not_sent`);
  } catch (err) {
    logWarn(TAG, `markDefinitelyNotSent failed for card ${cardId}: ${err}`);
  }
}
