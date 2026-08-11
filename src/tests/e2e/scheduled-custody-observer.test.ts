/**
 * scheduled-custody-observer.test.ts — #1548 focused observer tests.
 *
 * The observer is a structural oracle over injected store handles, so these
 * tests use in-memory fakes with a controllable clock. They prove the sampling
 * specificity rules: correlation isolation, single no-effect wake tolerance,
 * two-wake failure with separation, rapid wake immunity, and the settle grace.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ScheduledCustodyObserver,
  CustodyGapError,
  CUSTODY_CONSTANTS,
  type ObserverStores,
} from "./scheduled-custody-observer.js";
import type { ActiveTaskRun } from "../../components/tasks/task-state-store.js";
import type { LifecycleDueSource } from "../../components/lifecycle-wake-scheduler.js";

const { CHILD_SETTLE_GRACE_MS, WAKE_EFFECT_WINDOW_MS, NO_EFFECT_WAKE_MIN_SEPARATION_MS } = CUSTODY_CONSTANTS;

function makeRun(partial: Partial<ActiveTaskRun> = {}): ActiveTaskRun {
  const now = Date.now();
  return {
    runId: "task-a_run1",
    groupId: "task-a:group:1",
    attempt: 1,
    trigger: "schedule",
    occurrenceAt: now,
    reservedAt: now,
    deadlineAt: now + 30 * 60 * 1000,
    phase: "executing",
    lastProgressAt: now,
    ...partial,
  };
}

interface FakeState {
  run?: ActiveTaskRun;
  historyOutcome?: string;
  cards: Map<number, Record<string, unknown>>;
  children: Map<number, number[]>;
  attempts: Map<number, Array<{ id: string; lifecycle: string }>>;
  leases: Map<string, { semanticState: string }>;
  supervision?: { state: string };
  reviewCase?: { id: number; status: string };
  inputs: number;
  currentJobs: Array<{ runId: string }>;
  clock: number;
}

function makeStores(initial: Partial<FakeState> = {}): { stores: ObserverStores; state: FakeState } {
  const state: FakeState = {
    cards: new Map(),
    children: new Map(),
    attempts: new Map(),
    leases: new Map(),
    inputs: 0,
    currentJobs: [],
    clock: Date.now(),
    ...initial,
  };
  const stores: ObserverStores = {
    readRun: () => state.run,
    historyOutcome: () => state.historyOutcome,
    card: id => (state.cards.has(id) ? state.cards.get(id) as never : undefined),
    childrenOf: rootId => (state.children.get(rootId) ?? []).map(id => state.cards.get(id) as never),
    attemptsForCard: cardId => state.attempts.get(cardId) ?? [],
    leaseFor: attemptId => state.leases.get(attemptId) as never,
    supervision: () => state.supervision as never,
    latestReviewCase: () => state.reviewCase as never,
    pendingInputRequests: () => (state.inputs > 0 ? [{ id: `input-${state.inputs}` }] : []),
    currentJobs: () => state.currentJobs,
    now: () => state.clock,
  };
  return { stores, state };
}

/** A running W child with a valid non-terminal attempt — the live-child shape. */
function liveChild(state: FakeState, id: number, parentId: number): void {
  state.children.set(parentId, [...(state.children.get(parentId) ?? []), id]);
  state.cards.set(id, childCard(id, parentId, "running", new Date(state.clock).toISOString().slice(0, 23)));
  state.attempts.set(id, [{ id: `att_${id}`, lifecycle: "running" }]);
}

function makeWakeSource(state: { clock: number }, items: Array<{ key: string; dueAt: number }>): LifecycleDueSource & { setItems: (i: Array<{ key: string; dueAt: number }>) => void } {
  let current = items;
  return {
    id: "run-deadline",
    listDueItems: () => current,
    wakeDue: () => {},
    setItems: (i) => { current = i; },
  };
}

function childCard(id: number, parentId: number, status: string, updatedAtIso: string): Record<string, unknown> {
  return { id, parent_id: parentId, status, type: "W", source: "agent", updated_at: updatedAtIso };
}

describe("ScheduledCustodyObserver — #1548", () => {
  it("rejects unrelated activity as custody for the observed run", () => {
    const { stores, state } = makeStores();
    state.run = makeRun();
    liveChild(state, 10, 2);
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);

    expect(() => observer.checkpoint()).toThrow(CustodyGapError);
  });

  it("grants custody only for the observed run's own live child", () => {
    const { stores, state } = makeStores();
    state.run = makeRun({ cardId: 2 });
    liveChild(state, 10, 2);
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);

    expect(() => observer.checkpoint()).not.toThrow();
  });

  it("a single no-effect wake is tolerated and recorded", async () => {
    const { stores, state } = makeStores();
    state.run = makeRun();
    const source = makeWakeSource(state, []);
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);

    // A run in executing with no child is already a custody gap; for the wake
    // test give the run queue ownership in the queued phase so custody holds
    // while we exercise the wake bookkeeping.
    state.run = makeRun({ phase: "queued" });
    state.currentJobs = [{ runId: state.run.runId }];
    const item = { key: `run:${state.run.runId}`, dueAt: state.clock + 1000 };
    source.setItems([item]);
    await observer.fireWake(source);
    state.clock += WAKE_EFFECT_WINDOW_MS + 1;
    expect(() => observer.checkpoint()).not.toThrow();

    // The wake was recorded as no-effect: a second wake past the minimum
    // separation now fails with both wake times.
    state.clock += NO_EFFECT_WAKE_MIN_SEPARATION_MS + 100;
    source.setItems([{ ...item, dueAt: state.clock + 1000 }]);
    await observer.fireWake(source);
    state.clock += WAKE_EFFECT_WINDOW_MS + 1;
    let err: CustodyGapError | undefined;
    try { observer.checkpoint(); } catch (e) { err = e as CustodyGapError; }
    expect(err).toBeInstanceOf(CustodyGapError);
    expect(err!.kind).toBe("two_no_effect_wakes");
    expect(err!.wake?.wakeTimes).toHaveLength(2);
    expect(String(err!.message)).toContain(state.run!.runId);
  });

  it("two no-effect wakes closer than the minimum separation do not qualify", async () => {
    const { stores, state } = makeStores();
    state.run = makeRun({ phase: "queued" });
    state.currentJobs = [{ runId: state.run.runId }];
    const source = makeWakeSource(state, []);
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);
    const item = { key: `run:${state.run.runId}`, dueAt: state.clock + 1000 };
    source.setItems([item]);

    await observer.fireWake(source);
    state.clock += WAKE_EFFECT_WINDOW_MS + 1;
    expect(() => observer.checkpoint()).not.toThrow();

    // Second wake just inside the minimum separation from the first fire:
    // tolerated even after its own effect window elapses.
    state.clock += NO_EFFECT_WAKE_MIN_SEPARATION_MS - 2 * WAKE_EFFECT_WINDOW_MS - 100;
    source.setItems([{ ...item, dueAt: state.clock + 1000 }]);
    await observer.fireWake(source);
    state.clock += WAKE_EFFECT_WINDOW_MS + 1;
    expect(() => observer.checkpoint()).not.toThrow();

    // Third wake now past the separation from the FIRST no-effect wake fails.
    state.clock += NO_EFFECT_WAKE_MIN_SEPARATION_MS - 2 * WAKE_EFFECT_WINDOW_MS + 100;
    source.setItems([{ ...item, dueAt: state.clock + 1000 }]);
    await observer.fireWake(source);
    state.clock += WAKE_EFFECT_WINDOW_MS + 1;
    let err: CustodyGapError | undefined;
    try { observer.checkpoint(); } catch (e) { err = e as CustodyGapError; }
    expect(err).toBeInstanceOf(CustodyGapError);
    expect(err!.kind).toBe("two_no_effect_wakes");
  });

  it("a wake whose due item moved later counts as an effect", async () => {
    const { stores, state } = makeStores();
    state.run = makeRun({ phase: "queued" });
    state.currentJobs = [{ runId: state.run.runId }];
    const source = makeWakeSource(state, [{ key: `run:${state.run.runId}`, dueAt: state.clock + 1000 }]);
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);

    await observer.fireWake(source);
    source.setItems([{ key: `run:${state.run.runId}`, dueAt: state.clock + 5000 }]);
    state.clock += WAKE_EFFECT_WINDOW_MS + 1;
    expect(() => observer.checkpoint()).not.toThrow();

    // Two more pushes with real movement keep it green.
    await observer.fireWake(source);
    source.setItems([]); // item consumed
    state.clock += WAKE_EFFECT_WINDOW_MS + 1;
    expect(() => observer.checkpoint()).not.toThrow();
  });

  it("a child terminal fact inside the settle grace stays green, then settlement ends observation", () => {
    const { stores, state } = makeStores();
    state.run = makeRun({ cardId: 2 });
    state.children.set(2, [10]);
    state.cards.set(10, childCard(10, 2, "done", new Date(state.clock - 100).toISOString().slice(0, 23)));
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);

    // Inside the 500ms child-fact grace: no gap.
    state.clock += CHILD_SETTLE_GRACE_MS - 100;
    expect(() => observer.checkpoint()).not.toThrow();

    // Grace elapsed with no settlement and no custody: gap.
    state.clock += 200;
    expect(() => observer.checkpoint()).toThrow(/settle grace/);

    // Now settle within the grace instead: green at every checkpoint.
    state.clock = state.clock - 1000;
    state.cards.set(10, childCard(10, 2, "done", new Date(state.clock - 100).toISOString().slice(0, 23)));
    state.historyOutcome = "success";
    const observer2 = new ScheduledCustodyObserver("task-a", state.run.runId, stores);
    state.clock += CHILD_SETTLE_GRACE_MS + 500;
    expect(() => observer2.checkpoint()).not.toThrow();
  });

  it("the absolute deadline is never custody for a run with no owner", () => {
    const { stores, state } = makeStores();
    state.run = makeRun();
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);

    let err: CustodyGapError | undefined;
    try { observer.checkpoint(); } catch (e) { err = e as CustodyGapError; }
    expect(err).toBeInstanceOf(CustodyGapError);
    expect(err!.kind).toBe("no_custody");
    expect(String(err!.message)).toContain("is not custody");
    expect(String(err!.message)).toContain(state.run!.runId);
  });

  it("assertTerminal proves the declared source from correlated evidence", () => {
    const { stores, state } = makeStores();
    state.run = makeRun({ cardId: 2 });
    state.historyOutcome = "success";
    state.supervision = { state: "accepted" };
    state.children.set(2, [10]);
    state.cards.set(10, childCard(10, 2, "done", "2026-08-05T10:00:00.000"));
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);

    expect(() => observer.assertTerminal({ outcome: "success", source: "project_accepted" })).not.toThrow();
    // A declared source that the durable evidence cannot prove fails.
    expect(() => observer.assertTerminal({ outcome: "success", source: "project_blocked" }))
      .toThrow(/source not proven/);
    // An outcome that never occurred fails.
    expect(() => observer.assertTerminal({ outcome: "failed", source: "project_accepted" }))
      .toThrow(/terminal contract violated/);
    state.supervision = undefined;
    expect(() => observer.assertTerminal({ outcome: "success", source: "project_accepted" }))
      .toThrow(/source not proven/);
  });

  it("assertTerminal requires a diagnostic code for deadline and restart sources", () => {
    const { stores, state } = makeStores();
    state.run = makeRun();
    state.historyOutcome = "failed";
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);

    expect(() => observer.assertTerminal({ outcome: "failed", source: "deadline_exceeded" }))
      .toThrow(/requires a diagnosticCode/);
  });

  it("uses vi.stubGlobal-free pure fake timers via the injected clock", () => {
    // Sanity: the observer never touches global timers; its clock is injected.
    const { stores, state } = makeStores();
    state.run = makeRun({ phase: "queued" });
    state.currentJobs = [{ runId: state.run.runId }];
    const observer = new ScheduledCustodyObserver("task-a", state.run.runId, stores);
    expect(() => observer.checkpoint()).not.toThrow();
    observer.stop();
  });

  void vi;
});
