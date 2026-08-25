import type { KanbanCard } from "./kanban-board.js";
import { kanbanMarkDelivered, kanbanClaimDelivery, kanbanClaimProjectDelivery, kanbanGetCard, kanbanPending, kanbanTransition, sqliteNow } from "./kanban-board.js";
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

/** #1724: resolved handoff target for a Main-owned announcement. */
export interface MainAnnounceInput {
  cardId: number;
  title: string;
  /** Bounded, redacted settled result (the card's durable outbox payload). */
  result: string;
}

export interface DeliverDeps {
  sendMessage: (chatId: string, text: string) => Promise<SendOutcome>;
  sendDocument: (chatId: string, filePath: string, caption: string) => Promise<SendOutcome>;
  announce: (prompt: string) => Promise<void>;
  chatIdFor: (card: KanbanCard) => string;
  /**
   * #1724: Main-owned announcement for scheduled one-shot T announce cards.
   * The boot-composed closure resolves the target identity from the card at
   * delivery time and submits through the normal conversation pipeline; it
   * resolves only after Main's response was externally delivered ("sent"),
   * definitely was not ("not_sent"), or may have partially been ("unknown").
   * When absent, a matching card is treated as definitely-not-sent — never a
   * direct platform fallback.
   */
  announceToMain?: (card: KanbanCard) => Promise<import("../../types/platform.js").MainDeliveryResult>;
}

/**
 * #1595: card ids whose O-type done-without-accepted-supervision skip was
 * already warned. The delivery poll visits such cards every heartbeat, so the
 * warning must fire once per card episode, not once per poll. The id is
 * removed again when the card actually gets claimed — a later episode (e.g.
 * card re-pending after repair) may warn anew.
 */
const warnedUnacceptedOCards = new Set<number>();

export async function deliverCard(card: KanbanCard, deps: DeliverDeps): Promise<void> {
  // Only deliver cards with result_path (report artifacts) or result_summary
  // Skip cards that have already been delivered or have unknown delivery state
  const fresh = kanbanGetCard(card.id);
  if (!fresh) return;
  if (fresh.status === "delivered") {
    warnedUnacceptedOCards.delete(card.id);
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

  if (fresh.type === "O") {
    const { ProjectReviewStore } = await import("../project-acceptance/project-review-store.js");
    const store = new ProjectReviewStore();
    const sup = store.getSupervision(fresh.id);
    if (!sup || sup.state !== "accepted") {
      if (!warnedUnacceptedOCards.has(fresh.id)) {
        warnedUnacceptedOCards.add(fresh.id);
        logWarn(TAG, `Card ${fresh.id} (${fresh.title}) is done but its O-type project has no accepted supervision (state=${sup?.state ?? "none"}) — skipping delivery. Complete the project acceptance review (review_project accept) to deliver this card.`);
      }
      return;
    }
    // #1644: the project-aware claim rechecks the exact root/run/generation
    // and successful run outcome inside the claim transaction. A stale claim
    // for a blocked project, mismatched generation, or failed run loses the
    // CAS and is never sent.
    if (!kanbanClaimProjectDelivery(fresh.id, {
      projectGeneration: sup.generation,
      scheduledRunId: fresh.source === "task" && fresh.source_id ? fresh.source_id : undefined,
    })) {
      logSwarmTrace({ event: "delivery_claim_lost", card: fresh.id, reason: "project_authority_lost_or_claimed" });
      return;
    }
  } else if (!kanbanClaimDelivery(card.id)) {
    logSwarmTrace({ event: "delivery_claim_lost", card: card.id, reason: "already_claimed_or_delivered" });
    return;
  }
  warnedUnacceptedOCards.delete(card.id);
  logSwarmTrace({ event: "delivery_claim_won", card: card.id });
  const chatId = deps.chatIdFor(card);

  if (card.delivery_mode === "silent") {
    kanbanMarkDelivered(card.id);
    logSwarmTrace({ event: "delivery_sent", card: card.id, reason: "silent_mode" });
    return;
  }

  // #1724: scheduled one-shot T announce results are announced BY MAIN
  // through the normal conversation pipeline. The exact predicate matters:
  // the same generic `announce` mode is also used by scheduled K role cards,
  // which keep their direct role-session delivery route. There is no
  // direct-send fallback for a matching card — Main is the only component
  // that may deliver this result.
  // Use the post-claim read, not the caller's possibly stale snapshot, for
  // the ownership discriminator and payload. A stale snapshot must never
  // reopen the direct-send path for a card that is now a scheduled T announce.
  const isScheduledTAnnounce = fresh.source === "task" && fresh.type === "T" && fresh.delivery_mode === "announce";
  if (isScheduledTAnnounce) {
    if (!deps.announceToMain) {
      // Unwired ingress is an unambiguous pre-send failure, not an excuse to
      // bypass Main with the raw adapter sender.
      logWarn(TAG, `Card ${card.id}: scheduled T announce has no Main ingress wired — definitely not sent`);
      markDefinitelyNotSent(card.id);
      logSwarmTrace({ event: "delivery_failed", card: card.id, reason: "main_ingress_unwired" });
      return;
    }
    try {
      const outcome = await deps.announceToMain(fresh);
      recordOutcome(card.id, outcome, "announce_main");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Main announcement failed for card ${card.id}: ${msg}`);
      markUnknown(card.id);
      logSwarmTrace({ event: "delivery_failed", card: card.id, reason: "main_ingress_failed" });
    }
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
