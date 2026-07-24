import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockEnqueue, mockUpdate, mockComplete } = vi.hoisted(() => ({
  mockEnqueue: vi.fn((_title: string, _source: string, _sid: unknown, _opts: unknown) => 42),
  mockUpdate: vi.fn(),
  mockComplete: vi.fn(),
}));

vi.mock("../../components/tasks/kanban-board.js", () => ({
  kanbanEnqueue: mockEnqueue,
  kanbanUpdate: mockUpdate,
  kanbanComplete: mockComplete,
}));

import { startSleepCard } from "./sleep-card.js";

const STEPS = ["gc-noise", "daily-summary", "extract-memories"];

function lastNotes(): string {
  const calls = mockUpdate.mock.calls.filter(c => (c[1] as { notes?: string }).notes !== undefined);
  return (calls[calls.length - 1]?.[1] as { notes: string }).notes;
}

describe("startSleepCard (event-driven, #1381)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates ONE card on first event, type D, running status", () => {
    const card = startSleepCard();
    card.onEvent({ type: "step_started", stepId: "gc-noise" });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [title, source, , opts] = mockEnqueue.mock.calls[0];
    expect(title).toMatch(/^Sleep \d{4}-\d{2}-\d{2}$/);
    expect(source).toBe("scheduled");
    expect((opts as { type: string }).type).toBe("D");
    expect((opts as { deliveryMode: string }).deliveryMode).toBe("silent");
    expect(mockUpdate).toHaveBeenCalledWith(42, { status: "running" });
  });

  it("ticks the matching item: step_started -> [~], step_completed -> [x]", () => {
    const card = startSleepCard();
    card.onEvent({ type: "step_started", stepId: "gc-noise" });
    expect(lastNotes()).toContain("[~] gc-noise");
    card.onEvent({ type: "step_completed", step: { id: "gc-noise" } });
    expect(lastNotes()).toContain("[x] gc-noise");
  });

  it("accumulates steps from events", () => {
    const card = startSleepCard();
    card.onEvent({ type: "step_started", stepId: "gc-noise" });
    card.onEvent({ type: "step_started", stepId: "daily-summary" });
    card.onEvent({ type: "step_started", stepId: "extract-memories" });
    const notes = lastNotes();
    for (const s of STEPS) expect(notes).toContain(s);
  });

  it("complete() marks the card done exactly once (idempotent)", () => {
    const card = startSleepCard();
    card.onEvent({ type: "step_completed", step: { id: "gc-noise" } });
    card.complete();
    card.complete();
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("no events -> no card; onEvent/complete are safe no-ops", () => {
    const card = startSleepCard();
    expect(mockEnqueue).not.toHaveBeenCalled();
    card.complete();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });
});
