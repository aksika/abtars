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
import type { SleepStepEvent } from "abmind";

const STEPS = [
  { name: "gc-noise", filename: "01-gc-noise.md", rawPrompt: "", skippable: true },
  { name: "daily-summary", filename: "02-daily-summary.md", rawPrompt: "", skippable: false },
  { name: "extract-memories", filename: "03-extract-memories.md", rawPrompt: "", skippable: false },
];

function ev(name: string, phase: SleepStepEvent["phase"], index: number): SleepStepEvent {
  return { name, filename: `${name}.md`, index, total: STEPS.length, phase };
}

function lastNotes(): string {
  const calls = mockUpdate.mock.calls.filter(c => (c[1] as { notes?: string }).notes !== undefined);
  return (calls[calls.length - 1]?.[1] as { notes: string }).notes;
}

describe("startSleepCard (#895)", () => {
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

  it("ticks the matching item: start -> [~], done -> [x], skipped -> [skip], failed -> [fail]", () => {
    const card = startSleepCard();
    card.onStep(ev("gc-noise", "start", 1));
    expect(lastNotes()).toContain("[~] gc-noise");
    card.onStep(ev("gc-noise", "done", 1));
    expect(lastNotes()).toContain("[x] gc-noise");
    card.onStep(ev("daily-summary", "skipped", 2));
    expect(lastNotes()).toContain("[skip] daily-summary");
    card.onStep(ev("extract-memories", "failed", 3));
    expect(lastNotes()).toContain("[fail] extract-memories");
  });

  it("complete() marks the card done exactly once (idempotent)", () => {
    const card = startSleepCard();
    card.onStep(ev("gc-noise", "done", 1));
    card.complete();
    card.complete();
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [id, , summary] = mockComplete.mock.calls[0];
    expect(id).toBe(42);
    expect(summary).toContain("1 done");
  });

  it("no manifest -> no card; onStep/complete are safe no-ops", () => {
    mockLoadSleepSteps.mockReturnValue([]);
    const card = startSleepCard();
    expect(mockEnqueue).not.toHaveBeenCalled();
    card.onStep(ev("gc-noise", "start", 1));
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
