/**
 * cycle-end.test.ts — #1287: the night Dreamy session tears down on EVERY cycle
 * outcome. createSleepHandle must invoke opts.onCycleEnd exactly once per cycle on
 * every terminal SleepRunResult status and on a thrown error — regardless of
 * onComplete.
 *
 * #1353: runSleepCycle now returns a structured SleepRunResult, not {ok, failCount}.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockRunSleepCycle } = vi.hoisted(() => ({
  mockRunSleepCycle: vi.fn(async () => ({
    runId: "run-1", status: "completed" as const, startedAt: 0, finishedAt: 0, llmCalls: 0,
    steps: [], essentialFailures: [], resumable: false, watermarkAdvanced: true, report: "ok",
  })),
}));

vi.mock("abmind", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("abmind");
  return { ...actual, runSleepCycle: mockRunSleepCycle };
});

// system-event-buffer is imported lazily on the report path — stub it so no real
// event is buffered and the dynamic import resolves in tests.
vi.mock("../../components/system-event-buffer.js", () => ({
  bufferSystemEvent: vi.fn(),
}));

import { createSleepHandle } from "./index.js";

const stubRuntime = { complete: async () => "" };

function completedResult(overrides: Partial<Awaited<ReturnType<typeof mockRunSleepCycle>>> = {}) {
  return {
    runId: "run-1", status: "completed" as const, startedAt: 0, finishedAt: 0, llmCalls: 0,
    steps: [], essentialFailures: [], resumable: false, watermarkAdvanced: true, report: "ok",
    ...overrides,
  };
}

async function settle(): Promise<void> {
  // Success path awaits a dynamic import() before .finally — needs macrotasks, not
  // just microtasks. Poll a few real ticks so the whole chain settles.
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

describe("createSleepHandle — onCycleEnd teardown (#1287, #1353)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSleepCycle.mockImplementation(async () => completedResult());
  });

  const stubApi: import("./index.js").SleepApi = {
    DEFAULT_LEVEL: "normal",
    parseLevel: (s: string) => s,
    runSleepCycle: mockRunSleepCycle,
    loadSleepSteps: () => [],
  };

  function makeHandle(onCycleEnd: () => void) {
    return createSleepHandle({
      api: stubApi,
      memoryEnabled: false,
      runtime: stubRuntime,
      onComplete: () => {},
      onCycleEnd,
    });
  }

  it("fires onCycleEnd on the completed path", async () => {
    mockRunSleepCycle.mockImplementation(async () => completedResult({ status: "completed" }));
    const onCycleEnd = vi.fn();
    const r = makeHandle(onCycleEnd).startManual({ fresh: true, resume: false });
    expect(r.status).toBe("accepted");
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onCycleEnd on the partial path", async () => {
    mockRunSleepCycle.mockImplementation(async () => completedResult({ status: "partial", essentialFailures: ["retrospective"] }));
    const onCycleEnd = vi.fn();
    makeHandle(onCycleEnd).startManual({ fresh: true, resume: false });
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onCycleEnd on the failed path", async () => {
    mockRunSleepCycle.mockImplementation(async () => completedResult({ status: "failed", essentialFailures: ["daily-summary"] }));
    const onCycleEnd = vi.fn();
    makeHandle(onCycleEnd).startManual({ fresh: true, resume: false });
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onCycleEnd on the cancelled path", async () => {
    mockRunSleepCycle.mockImplementation(async () => completedResult({ status: "cancelled", resumable: true }));
    const onCycleEnd = vi.fn();
    makeHandle(onCycleEnd).startManual({ fresh: true, resume: false });
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onCycleEnd on the thrown-error path", async () => {
    mockRunSleepCycle.mockImplementation(async () => { throw new Error("boom"); });
    const onCycleEnd = vi.fn();
    makeHandle(onCycleEnd).startManual({ fresh: true, resume: false });
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("startScheduled also tears down on completed (#1321, #1353)", async () => {
    mockRunSleepCycle.mockImplementation(async () => completedResult({ status: "completed" }));
    const onCycleEnd = vi.fn();
    const r = makeHandle(onCycleEnd).startScheduled();
    expect(r.status).toBe("accepted");
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("already_running when a cycle is active (#1321 req 8)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    mockRunSleepCycle.mockImplementation(async () => { await gate; return completedResult(); });
    const handle = makeHandle(vi.fn());
    expect(handle.startScheduled().status).toBe("accepted");
    expect(handle.startScheduled().status).toBe("already_running");
    expect(handle.startManual({ fresh: true, resume: false }).status).toBe("already_running");
    release();
    await settle();
  });

  it("no_work / already_running results do not buffer a report (nothing new to say)", async () => {
    mockRunSleepCycle.mockImplementation(async () => completedResult({ status: "no_work", report: "nothing to do" }));
    const { bufferSystemEvent } = await import("../../components/system-event-buffer.js");
    makeHandle(vi.fn()).startManual({ fresh: true, resume: false });
    await settle();
    expect(bufferSystemEvent).not.toHaveBeenCalled();
  });
});
