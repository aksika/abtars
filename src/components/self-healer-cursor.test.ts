import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSelfHealerTask } from "./self-healer.js";
import { _resetEnv } from "./env-schema.js";
import { reload } from "./sha-tracker.js";
import { logDebug } from "./logger.js";
import { spin } from "./spin.js";

let tmpDir: string;
let logFile: string;

const mockAdapter = {
  sendNotification: vi.fn(),
  sendMessage: vi.fn(),
  sendDocument: vi.fn(),
  injectMessage: vi.fn(),
};

function makeTask() {
  const task = createSelfHealerTask(() => mockAdapter as any, new Set([123]));
  task.enabled = true;
  return task;
}

vi.mock("./logger.js", () => ({
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
  getLogFile: () => logFile,
}));

// Prevent handleUnknownFault from actually dispatching spin calls
vi.mock("./spin.js", () => ({
  spin: {
    dispatchAwait: vi.fn().mockResolvedValue({ result: "ok" }),
    listAllSessions: vi.fn().mockReturnValue([]),
    destroySession: vi.fn(),
    getActiveCardIds: vi.fn().mockReturnValue([]),
    injectGreeting: vi.fn(),
    tick: vi.fn(),
  },
}));

// Runs before the cursor tests below: sha-tracker's loadPolicy caches module
// state, so these tests need a valid policy first and must restore the
// deny-on-missing-policy state afterwards.
describe("self-healer unknown-fault gate (#1589)", () => {
  beforeEach(() => {
    _resetEnv();
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "selfheal-gate-"));
    logFile = join(tmpDir, "bridge.log");
    writeFileSync(logFile, "");
    process.env.ABTARS_HOME = tmpDir;
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(join(tmpDir, "config", "sha-policy.json"), JSON.stringify({ faults: {} }));
    reload();
    mkdirSync(join(tmpDir, "src", "abtars"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  afterAll(() => {
    // Restore deny-on-missing-policy state for the cursor tests below.
    const home = mkdtempSync(join(tmpdir(), "selfheal-reset-"));
    process.env.ABTARS_HOME = home;
    reload();
    delete process.env.ABTARS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("past the quiet window: unknown-fault dispatch is NOT suppressed (#1589)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00"));
    const now = Date.now();
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ startedAt: now - 3 * 60 * 60 * 1000 }));

    const task = makeTask();
    writeFileSync(logFile, "2026-01-01 00:00:00 INFO [test] ready\n");
    await task.execute();

    appendFileSync(logFile, "2026-01-01 00:01:00 ERROR [test] something broke\n");
    const result = await task.execute();
    await vi.runAllTimersAsync();

    expect(result.state).toBe("ran");
    expect(spin.dispatchAwait).toHaveBeenCalled();
    expect(mockAdapter.sendNotification).toHaveBeenCalled();
  });

  it("inside the quiet window: dispatch is suppressed (#1589)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00"));
    const now = Date.now();
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ startedAt: now - 60 * 1000 }));

    const task = makeTask();
    writeFileSync(logFile, "2026-01-01 00:00:00 INFO [test] ready\n");
    await task.execute();

    appendFileSync(logFile, "2026-01-01 00:01:00 ERROR [test] something broke\n");
    const result = await task.execute();

    expect(result.state).toBe("ran");
    expect(spin.dispatchAwait).not.toHaveBeenCalled();
    expect(mockAdapter.sendNotification).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith("self-healer", "Skipping SHA dispatch — inside post-boot quiet window");
  });
});

describe("self-healer cursor", () => {
  beforeEach(() => {
    _resetEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "selfheal-cursor-"));
    logFile = join(tmpDir, "bridge.log");
    writeFileSync(logFile, "");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns idle with empty log (initial EOF)", async () => {
    const task = makeTask();
    const result = await task.execute();
    expect(result.state).toBe("idle");
  });

  it("returns idle when no new data since previous tick", async () => {
    writeFileSync(logFile, "2026-01-01 00:00:00 INFO [test] ready\n");
    const task = makeTask();
    await task.execute();

    const result = await task.execute();
    expect(result.state).toBe("idle");
  });

  it("processes appended complete lines", async () => {
    writeFileSync(logFile, "2026-01-01 00:00:00 INFO [test] ready\n");
    const task = makeTask();
    await task.execute();

    appendFileSync(logFile, "2026-01-01 00:01:00 ERROR [test] something broke\n");
    const result = await task.execute();
    expect(result.state).toBe("ran");
  });

  it("retains partial line across ticks", async () => {
    const task = makeTask();

    writeFileSync(logFile, "2026-01-01 00:00:00 INFO [test] ready\n");
    await task.execute();

    appendFileSync(logFile, "2026-01-01 00:01:00 ERROR [test] partial");
    const first = await task.execute();
    expect(first.state).toBe("idle");

    appendFileSync(logFile, " line\n");
    const second = await task.execute();
    expect(second.state).toBe("ran");
  });

  it("handles file rotation (renamed -> new file)", async () => {
    const task = makeTask();

    writeFileSync(logFile, "2026-01-01 00:00:00 ERROR [test] old\n");
    await task.execute();

    const { renameSync } = await import("node:fs");
    const rotated = logFile + ".1";
    renameSync(logFile, rotated);
    writeFileSync(logFile, "2026-01-01 01:00:00 ERROR [test] new\n");
    const result = await task.execute();
    expect(result.state).toBe("ran");
    rmSync(rotated);
  });

  it("handles file truncation to smaller size", async () => {
    const task = makeTask();

    writeFileSync(logFile, "2026-01-01 00:00:00 ERROR [test] this is a very long line that will be truncated\n");
    await task.execute();

    writeFileSync(logFile, "2026-01-01 01:00:00 ERROR [test] short\n");
    const result = await task.execute();
    expect(result.state).toBe("ran");
  });

  it("reads at most MAX_READ_BYTES", async () => {
    const task = makeTask();

    const largeLine = "A".repeat(2_000_000) + "\n";
    writeFileSync(logFile, largeLine);
    const result = await task.execute();
    // Should not throw despite large data — bounded by 1 MiB
    expect(result.state).toBe("idle");
  });
});