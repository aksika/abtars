import type { KanbanCard } from "./kanban-board.js";
import { kanbanMarkDelivered, kanbanSetDelivering } from "./kanban-board.js";

export interface DeliverDeps {
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendDocument: (chatId: string, filePath: string, caption: string) => Promise<void>;
  announce: (prompt: string) => Promise<void>;
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
    const text = card.result_summary
      ? `✅ "${card.title}" complete.\n\n${card.result_summary}`
      : `✅ "${card.title}" complete.`;
    await deps.sendMessage(chatId, text);
    kanbanMarkDelivered(card.id);
    return;
  }

  // "report" (also stored as legacy "deliver"): attach the artifact exactly once —
  // no generic confirmation text and no host path. Fall back to a plain completion
  // message only when there is no artifact to send.
  if (card.result_path) {
    await deps.sendDocument(chatId, card.result_path, card.title);
    kanbanMarkDelivered(card.id);
    return;
  }
  const summary = card.result_summary ? `\n\n${card.result_summary}` : "";
  await deps.sendMessage(chatId, `✅ "${card.title}" complete.${summary}`);
  kanbanMarkDelivered(card.id);
}
