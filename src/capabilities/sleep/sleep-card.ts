import { kanbanEnqueue, kanbanUpdate, kanbanComplete } from "../../components/tasks/kanban-board.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";

type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

interface StepItem {
  name: string;
  status: StepStatus;
}

interface SleepCardEvent {
  type: string;
  detail?: string;
  stepId?: string;
  step?: { id: string };
}

const MARK: Record<StepStatus, string> = {
  pending: "[ ]",
  running: "[~]",
  done: "[x]",
  skipped: "[skip]",
  failed: "[fail]",
};

const TAG = "sleep-card";

export interface SleepCard {
  onEvent(event: SleepCardEvent): void;
  complete(): void;
}

function renderChecklist(items: readonly StepItem[]): string {
  return items.map(item => `${MARK[item.status]} ${item.name}`).join("\n");
}

export function startSleepCard(): SleepCard {
  let cardId = 0;
  let items: StepItem[] = [];
  let completed = false;

  function ensureCard(): number {
    if (cardId) return cardId;
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      cardId = kanbanEnqueue(`Sleep ${dateStr}`, "scheduled", undefined, {
        type: "D", deliveryMode: "silent", notes: "",
      });
      if (cardId) kanbanUpdate(cardId, { status: "running" });
    } catch (err) {
      logAndSwallow(TAG, "start", err);
    }
    return cardId;
  }

  function ensureStep(name: string): void {
    if (items.some(i => i.name === name)) return;
    items.push({ name, status: "pending" as StepStatus });
    if (cardId) {
      try { kanbanUpdate(cardId, { notes: renderChecklist(items) }); } catch { /* best effort */ }
    }
  }

  function setStatus(stepId: string, status: StepStatus): void {
    if (!cardId) return;
    ensureStep(stepId);
    const item = items.find(i => i.name === stepId);
    if (!item) return;
    item.status = status;
    try { kanbanUpdate(cardId, { notes: renderChecklist(items) }); } catch (err) { logAndSwallow(TAG, "tick", err); }
  }

  return {
    onEvent(event: SleepCardEvent): void {
      ensureCard();
      switch (event.type) {
        case "step_started":
          if (event.stepId) setStatus(event.stepId, "running");
          break;
        case "step_completed":
          if (event.step?.id) setStatus(event.step.id, "done");
          break;
        case "step_skipped":
          if (event.step?.id) setStatus(event.step.id, "skipped");
          break;
        case "step_failed":
          if (event.step?.id) setStatus(event.step.id, "failed");
          break;
        default: break;
      }
    },

    complete(): void {
      if (!cardId || completed) return;
      completed = true;
      const done = items.filter(i => i.status === "done").length;
      const skipped = items.filter(i => i.status === "skipped").length;
      const failed = items.filter(i => i.status === "failed").length;
      const summary = `Sleep complete — ${done} done, ${skipped} skipped, ${failed} failed (of ${items.length})`;
      try { kanbanComplete(cardId, null, summary); } catch (err) { logAndSwallow(TAG, "complete", err); }
    },
  };
}
