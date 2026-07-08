/**
 * sleep-card.ts — stepped kanban card for a nightly sleep cycle (#895).
 *
 * Display-only. One card per cycle whose notes render a checklist that ticks as
 * abmind fires onStep events. The card is created in "running" status (NOT
 * "queued") on purpose: a queued D-type card would be picked up by
 * spin.drainQueued() and dispatched as a spurious Dreamy worker. A parentless
 * "running" card is inert — drainQueued only scans "queued", and the reconciler
 * only touches children of running O-projects.
 *
 * All kanban writes are best-effort: a display failure must never break the
 * sleep cycle.
 */

import type { SleepStepEvent } from "abmind";
import { kanbanEnqueue, kanbanUpdate, kanbanComplete } from "../../components/tasks/kanban-board.js";
import { abmind } from "../../utils/abmind-lazy.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";

type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

interface StepItem {
  name: string;
  filename: string;
  status: StepStatus;
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
  /** Flip the matching checklist item and re-render the card notes. */
  onStep(event: SleepStepEvent): void;
  /** Mark the card done once at cycle end (success or failure). Idempotent. */
  complete(): void;
}

function renderChecklist(items: readonly StepItem[]): string {
  return items.map(item => `${MARK[item.status]} ${item.name}`).join("\n");
}

/**
 * Create the stepped card for a cycle. Reads the step manifest from abmind so
 * the checklist mirrors loadSleepSteps() (name + order). Returns a no-op card if
 * abmind or the manifest is unavailable — sleep still runs.
 */
export function startSleepCard(): SleepCard {
  let cardId = 0;
  let items: StepItem[] = [];
  let completed = false;

  try {
    const steps = abmind()?.loadSleepSteps() ?? [];
    items = steps.map(step => ({ name: step.name, filename: step.filename, status: "pending" as StepStatus }));
    if (items.length > 0) {
      const dateStr = new Date().toISOString().slice(0, 10);
      cardId = kanbanEnqueue(`Sleep ${dateStr}`, "scheduled", undefined, {
        type: "D",
        deliveryMode: "silent",
        notes: renderChecklist(items),
      });
      // Move out of "queued" immediately so drainQueued() never dispatches it.
      if (cardId) kanbanUpdate(cardId, { status: "running" });
    }
  } catch (err) {
    logAndSwallow(TAG, "start", err);
    cardId = 0;
  }

  return {
    onStep(event: SleepStepEvent): void {
      if (!cardId) return;
      const item = items.find(i => i.name === event.name);
      if (!item) return;
      item.status = event.phase === "start" ? "running" : event.phase;
      try {
        kanbanUpdate(cardId, { notes: renderChecklist(items) });
      } catch (err) {
        logAndSwallow(TAG, "tick", err);
      }
    },

    complete(): void {
      if (!cardId || completed) return;
      completed = true;
      const done = items.filter(i => i.status === "done").length;
      const skipped = items.filter(i => i.status === "skipped").length;
      const failed = items.filter(i => i.status === "failed").length;
      const summary = `Sleep complete — ${done} done, ${skipped} skipped, ${failed} failed (of ${items.length})`;
      try {
        kanbanComplete(cardId, null, summary);
      } catch (err) {
        logAndSwallow(TAG, "complete", err);
      }
    },
  };
}
