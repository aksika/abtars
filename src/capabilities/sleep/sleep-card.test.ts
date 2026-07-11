import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockEnqueue, mockUpdate, mockComplete, mockLoadSleepSteps } = vi.hoisted(() => ({
  mockEnqueue: vi.fn((_title: string, _source: string, _sid: unknown, _opts: unknown) => 42),
  mockUpdate: vi.fn(),
  mockComplete: vi.fn(),
  mockLoadSleepSteps: vi.fn(),
}));

vi.mock("../../components/tasks/kanban-board.js", () => ({
  kanbanEnqueue: mockEnqueue,
  kanbanUpdate: mockUpdate,
  kanbanComplete: mockComplete,
}));

vi.mock("../../utils/abmind-lazy.js", () => ({
  abmind: () => ({ loadSleepSteps: mockLoadSleepSteps }),
}));

import { startSleepCard } from "./sleep-card.js";
import type { SleepEvent, SleepStepSummary } from "abmind";

const STEPS = [
  { name: "gc-noise", filename: "01-gc-noise.md", rawPrompt: "", skippable: true },
  { name: "daily-summary", filename: "02-daily-summary.md", rawPrompt: "", skippable: false },
  { name: "extract-memories", filename: "03-extract-memories.md", rawPrompt: "", skippable: false },
];

function summary(id: string, status: SleepStepSummary["status"]): SleepStepSummary {
  return { id, status, essential: false, attempts: 1 };
}

function started(stepId: string, index: number): SleepEvent {
  return { type: "step_started", runId: "run-1", stepId, index, total: STEPS.length };
}
function completed(stepId: string): SleepEvent {
  return { type: "step_completed", runId: "run-1", step: summary(stepId, "completed") };
}
function skipped(stepId: string): SleepEvent {
  return { type: "step_skipped", runId: "run-1", step: summary(stepId, "skipped") };
}
function failed(stepId: string): SleepEvent {
  return { type: "step_failed", runId: "run-1", step: summary(stepId, "failed") };
}

function lastNotes(): string {
  const calls = mockUpdate.mock.calls.filter(c => (c[1] as { notes?: string }).notes !== undefined);
  return (calls[calls.length - 1]?.[1] as { notes: string }).notes;
}

describe("startSleepCard (#1353 — neutral SleepEvent contract)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSleepSteps.mockReturnValue(STEPS);
  });

  it("creates ONE card, type D, running status, checklist mirrors loadSleepSteps()", () => {
    startSleepCard();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [title, source, , opts] = mockEnqueue.mock.calls[0];
    expect(title).toMatch(/^Sleep \d{4}-\d{2}-\d{2}$/);
    expect(source).toBe("scheduled");
    expect((opts as { type: string }).type).toBe("D");
    expect((opts as { deliveryMode: string }).deliveryMode).toBe("silent");
    const notes = (opts as { notes: string }).notes;
    for (const s of STEPS) expect(notes).toContain(`[ ] ${s.name}`);
    // Moved out of "queued" so drainQueued() never dispatches it
    expect(mockUpdate).toHaveBeenCalledWith(42, { status: "running" });
  });

  it("ticks the matching item: step_started -> [~], step_completed -> [x], step_skipped -> [skip], step_failed -> [fail]", () => {
    const card = startSleepCard();
    card.onEvent(started("gc-noise", 1));
    expect(lastNotes()).toContain("[~] gc-noise");
    card.onEvent(completed("gc-noise"));
    expect(lastNotes()).toContain("[x] gc-noise");
    card.onEvent(skipped("daily-summary"));
    expect(lastNotes()).toContain("[skip] daily-summary");
    card.onEvent(failed("extract-memories"));
    expect(lastNotes()).toContain("[fail] extract-memories");
  });

  it("cycle_started / cycle_finished events are ignored by the card (no crash, no update)", () => {
    const card = startSleepCard();
    vi.clearAllMocks();
    card.onEvent({ type: "cycle_started", runId: "run-1", totalSteps: STEPS.length, resumed: false });
    card.onEvent({
      type: "cycle_finished", runId: "run-1", result: {
        runId: "run-1", status: "completed", startedAt: 0, finishedAt: 0, llmCalls: 0,
        steps: [], essentialFailures: [], resumable: false, watermarkAdvanced: true, report: "",
      },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("complete() marks the card done exactly once (idempotent)", () => {
    const card = startSleepCard();
    card.onEvent(completed("gc-noise"));
    card.complete();
    card.complete();
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [id, , summaryText] = mockComplete.mock.calls[0];
    expect(id).toBe(42);
    expect(summaryText).toContain("1 done");
  });

  it("no manifest -> no card; onEvent/complete are safe no-ops", () => {
    mockLoadSleepSteps.mockReturnValue([]);
    const card = startSleepCard();
    expect(mockEnqueue).not.toHaveBeenCalled();
    card.onEvent(started("gc-noise", 1));
    card.complete();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("loadSleepSteps throwing -> no card, no throw", () => {
    mockLoadSleepSteps.mockImplementation(() => { throw new Error("prompts missing"); });
    expect(() => startSleepCard().complete()).not.toThrow();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
