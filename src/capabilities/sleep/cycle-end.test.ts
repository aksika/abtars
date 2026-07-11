/**
 * cycle-end.test.ts — #1287: the night Dreamy session tears down on EVERY cycle
 * outcome. createSleepHandle must invoke opts.onCycleEnd exactly once per cycle on
 * success, partial-failure (!ok), and thrown-error paths — regardless of onComplete.
 *
 * #1321: admission is via startManual() (no forceSleep flag, no sleep window).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const { HOME, SLEEP_DIR } = vi.hoisted(() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const HOME = join(tmpdir(), `ab-cycleend-test-${process.pid}`);
  return { HOME, SLEEP_DIR: join(HOME, "sleep") };
});

vi.mock("../../paths.js", () => ({
  abtarsHome: () => HOME,
  reportsDir: (cat: string) => join(HOME, "reports", cat),
}));

const { mockRunSleepCycle } = vi.hoisted(() => ({
  mockRunSleepCycle: vi.fn(async () => ({ ok: true, failCount: 0 })),
}));

vi.mock("abmind", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("abmind");
  return { ...actual, runSleepCycle: mockRunSleepCycle, hasSleepAuditToday: vi.fn(() => false) };
});

vi.mock("../../utils/abmind-lazy.js", () => ({
  abmind: () => ({
    hasSleepAuditToday: () => false,
    DEFAULT_LEVEL: "normal",
    parseLevel: (s: string) => s,
    runSleepCycle: mockRunSleepCycle,
  }),
  loadAbmind: async () => ({}),
}));

// system-event-buffer is imported lazily on the success path — stub it so no real
// event is buffered and the dynamic import resolves in tests.
vi.mock("../../components/system-event-buffer.js", () => ({
  bufferSystemEvent: vi.fn(),
}));

import { createSleepHandle } from "./index.js";

const stubRuntime = { complete: async () => "" };

async function settle(): Promise<void> {
  // Success path awaits a dynamic import() before .finally — needs macrotasks, not
  // just microtasks. Poll a few real ticks so the whole chain settles.
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

describe("createSleepHandle — onCycleEnd teardown (#1287)", () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(SLEEP_DIR, { recursive: true });
    vi.clearAllMocks();
    mockRunSleepCycle.mockImplementation(async () => ({ ok: true, failCount: 0 }));
  });
  afterEach(() => rmSync(HOME, { recursive: true, force: true }));

  function makeHandle(onCycleEnd: () => void) {
    return createSleepHandle({
      sleepAuditDir: SLEEP_DIR,
      memoryEnabled: false,   // onComplete memory path off — teardown must still fire
      runtime: stubRuntime,
      onComplete: () => {},
      onCycleEnd,
    });
  }

  it("fires onCycleEnd on the success path", async () => {
    mockRunSleepCycle.mockImplementation(async () => ({ ok: true, failCount: 0 }));
    const onCycleEnd = vi.fn();
    const r = makeHandle(onCycleEnd).startManual({ fresh: true, resume: false });
    expect(r.status).toBe("accepted");
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onCycleEnd on the partial-failure (!ok) path", async () => {
    mockRunSleepCycle.mockImplementation(async () => ({ ok: false, failCount: 2 }));
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

  it("startScheduled also tears down on success (#1321)", async () => {
    mockRunSleepCycle.mockImplementation(async () => ({ ok: true, failCount: 0 }));
    const onCycleEnd = vi.fn();
    const r = makeHandle(onCycleEnd).startScheduled();
    expect(r.status).toBe("accepted");
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("already_running when a cycle is active (#1321 req 8)", async () => {
    // Block runSleepCycle so the cycle stays in-flight.
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    mockRunSleepCycle.mockImplementation(async () => { await gate; return { ok: true, failCount: 0 }; });
    const handle = makeHandle(vi.fn());
    expect(handle.startScheduled().status).toBe("accepted");
    expect(handle.startScheduled().status).toBe("already_running");
    expect(handle.startManual({ fresh: true, resume: false }).status).toBe("already_running");
    release();
    await settle();
  });
});
