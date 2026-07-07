/**
 * kanban-delivery.ts — shared delivery logic for kanban task cards (#1298).
 *
 * Called exclusively by the nerve card:done handler in heartbeat-tier3.ts.
 * The polling createKanbanDeliveryTask was removed — nerve is the sole delivery trigger.
 *
 * delivery_mode values:
 *   "deliver"  — send file (if any) + plain confirmation directly via sendMessage. No model.
 *   "announce" — inject into the pipeline for natural language delivery. Fire-and-forget;
 *                model failures are suppressed at the pipeline layer (no ❌ spam).
 *   "silent"   — mark delivered, send nothing.
 */

import type { KanbanCard } from "./kanban-board.js";
import { kanbanMarkDelivered, kanbanSetDelivering } from "./kanban-board.js";

export interface DeliverDeps {
  /** Direct Telegram/Discord sendMessage — must not invoke the model. */
  sendMessage: (chatId: string, text: string) => Promise<void>;
  /** Direct file delivery — must not invoke the model. */
  sendDocument: (chatId: string, filePath: string, caption: string) => Promise<void>;
  /** Fire-and-forget model route (sendSystemMessage). Used only for announce mode. */
  announce: (prompt: string) => Promise<void>;
  /** Resolve the target chat ID for a card (card.chat_id || masterChatId). */
  chatIdFor: (card: KanbanCard) => string;
}

export async function deliverCard(card: KanbanCard, deps: DeliverDeps): Promise<void> {
  kanbanSetDelivering(card.id);
  const chatId = deps.chatIdFor(card);

  if (card.delivery_mode === "silent") {
    kanbanMarkDelivered(card.id);
    return;
  }

  if (card.delivery_mode === "announce") {
    // Natural-language delivery via the pipeline (fire-and-forget).
    // If models are down, the pipeline error is suppressed at the message-pipeline layer
    // ([TASK COMPLETE] prefix — see #1294 / #1298). Card is marked delivered regardless.
    await deps.announce(
      `[TASK COMPLETE] "${card.title}" done.\nResult:\n${card.result_summary ?? "(no output)"}\n\nDeliver this to the user naturally.`
    );
    kanbanMarkDelivered(card.id);
    return;
  }

  // Default: "deliver" — plain delivery, never touches the model.
  if (card.result_path) {
    await deps.sendDocument(chatId, card.result_path, card.title);
  }
  const confirmation = card.result_path
    ? `Task "${card.title}" complete. File delivered: ${card.result_path}`
    : `Task "${card.title}" complete.`;
  await deps.sendMessage(chatId, confirmation);
  kanbanMarkDelivered(card.id);
}
