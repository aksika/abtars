import type { KanbanCard } from "./kanban-board.js";
import { kanbanMarkDelivered, kanbanClaimDelivery } from "./kanban-board.js";

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

  // Claim and increment atomically. Two heartbeat ticks holding the same
  // stale card object cannot both enter the delivery side effects.
  if (!kanbanClaimDelivery(card.id)) return;
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
