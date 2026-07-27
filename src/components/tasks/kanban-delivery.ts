import type { KanbanCard } from "./kanban-board.js";
import { kanbanMarkDelivered, kanbanSetDelivering, requireTaskDatabase } from "./kanban-board.js";
import { logDebug } from "../logger.js";

export interface DeliverDeps {
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendDocument: (chatId: string, filePath: string, caption: string) => Promise<void>;
  announce: (prompt: string) => Promise<void>;
  chatIdFor: (card: KanbanCard) => string;
}

export async function deliverCard(card: KanbanCard, deps: DeliverDeps): Promise<void> {
  // #1363 Task 9: O-type cards (projects) only deliver if they have an accepted supervision state
  if (card.type === "O") {
    const { ProjectReviewStore } = await import("../project-acceptance/project-review-store.js");
    const store = new ProjectReviewStore();
    const sup = store.getSupervision(card.id);
    if (!sup || sup.state !== "accepted") {
      return;
    }
  }

  // Idempotent: skip if already delivered or delivering
  if (card.status === "delivered") {
    logDebug("kanban-delivery", `Card ${card.id}: already delivered — skipping duplicate`);
    return;
  }
  if (card.status === "delivering") {
    logDebug("kanban-delivery", `Card ${card.id}: already delivering — skipping duplicate`);
    return;
  }

  // Increment delivery_attempts
  try {
    const db = requireTaskDatabase();
    db.prepare("UPDATE kanban_board SET delivery_attempts = COALESCE(delivery_attempts, 0) + 1, updated_at = datetime('now') WHERE id = ?").run(card.id);
  } catch { /* best effort */ }

  kanbanSetDelivering(card.id);
  const chatId = deps.chatIdFor(card);

  if (card.delivery_mode === "silent") {
    kanbanMarkDelivered(card.id);
    return;
  }

  if (card.delivery_mode === "announce") {
    const text = card.result_summary
      ? `${card.title} complete.\n\n${card.result_summary}`
      : `${card.title} complete.`;
    await deps.sendMessage(chatId, text);
    kanbanMarkDelivered(card.id);
    return;
  }

  if (card.result_path) {
    await deps.sendDocument(chatId, card.result_path, card.title);
    kanbanMarkDelivered(card.id);
    return;
  }
  const summary = card.result_summary ? `\n\n${card.result_summary}` : "";
  await deps.sendMessage(chatId, `${card.title} complete.${summary}`);
  kanbanMarkDelivered(card.id);
}
