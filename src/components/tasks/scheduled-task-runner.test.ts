import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ScheduledTaskRunner } from "./scheduled-task-runner.js";
import { settleRunOnce } from "./task-run-settler.js";

vi.mock("./task-state-store.js", () => ({
  updateActiveRun: vi.fn(),
  appendRun: vi.fn(),
  incrementDeferrals: vi.fn(() => 0),
  advanceNextRun: vi.fn(),
  readLastPromptAt: vi.fn(() => 0),
}));
vi.mock("./task-history-store.js", () => ({
  appendRunOnce: vi.fn(),
  hasRun: vi.fn(() => false),
}));
vi.mock("./task-run-settler.js", () => ({ settleRunOnce: vi.fn() }));
vi.mock("./task-preflight.js", () => ({ preflightTask: vi.fn(), validateReportArtifact: vi.fn() }));
vi.mock("../transport/bridge-lock-transport.js", () => ({ readLastPromptAt: vi.fn(() => 0) }));
vi.mock("../transport/pi-core-host.js", () => ({ getToolDescriptor: vi.fn(() => undefined) }));
vi.mock("./task-log-ctx.js", () => ({ logTaskDebug: vi.fn(), logTaskTrace: vi.fn() }));

const mockedSettle = vi.mocked(settleRunOnce);

function makeEntry(id: string): any {
  return {
    id,
    kind: "agent",
    prompt: "run the task",
    agent: "task",
    delivery: "announce",
    chatId: "1",
    schedule: "* * * * *",
    enabled: true,
    priority: "medium",
  };
}

function makeReservation(id: string): any {
  return {
    runId: `${id}-run`,
    groupId: `${id}-group`,
    attempt: 1,
    trigger: "manual",
    occurrenceAt: Date.now(),
    reservedAt: Date.now(),
    deadlineAt: Date.now() + 10_000,
    phase: "reserved",
    lastProgressAt: Date.now(),
  };
}

describe("ScheduledTaskRunner #1506 deadline ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedSettle.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles a timed-out caller-owned card with its ID and terminalizes control", async () => {
    let started!: (control: any) => void;
    const startedPromise = new Promise<any>((resolve) => { started = resolve; });
    const runner = new ScheduledTaskRunner({
      agentRunner: async (request) => {
        request.executionControl?.setCardId(42);
        started(request.executionControl);
        return await new Promise<never>(() => {});
      },
    });

    const runPromise = runner.run(makeEntry("runner-timeout"), makeReservation("runner-timeout"));
    const control = await startedPromise;
    expect(control.cardId).toBe(42);
    await vi.advanceTimersByTimeAsync(15_000);
    const outcome = await runPromise;

    expect(outcome.status).toBe("timed_out");
    expect(control.cancelled).toBe(true);
    expect(control.terminalOutcome).toBe("timed_out");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "timed_out",
      cardId: 42,
    }));
  });

  it("keeps a late completion from winning after the deadline", async () => {
    let started!: (control: any) => void;
    let complete!: (value: { cardId: number; result: string }) => void;
    const startedPromise = new Promise<any>((resolve) => { started = resolve; });
    const resultPromise = new Promise<{ cardId: number; result: string }>((resolve) => { complete = resolve; });
    const runner = new ScheduledTaskRunner({
      agentRunner: async (request) => {
        request.executionControl?.setCardId(43);
        started(request.executionControl);
        return resultPromise;
      },
    });

    const runPromise = runner.run(makeEntry("runner-race"), makeReservation("runner-race"));
    const control = await startedPromise;
    expect(control.cardId).toBe(43);
    await vi.advanceTimersByTimeAsync(10_000);
    complete({ cardId: 43, result: "late" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.mocked(settleRunOnce)).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    await vi.advanceTimersByTimeAsync(1);

    const outcome = await runPromise;
    expect(outcome.status).toBe("timed_out");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "timed_out", cardId: 43 }));
    expect(mockedSettle).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });
});
