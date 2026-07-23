import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSelfHealerTask } from "./self-healer.js";
import { _resetEnv } from "./env-schema.js";

let tmpDir: string;
let logFile: string;

const mockAdapter = {
  sendNotification: vi.fn(),
  sendMessage: vi.fn(),
  sendDocument: vi.fn(),
  injectMessage: vi.fn(),
};

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

  function makeTask() {
    const task = createSelfHealerTask(() => mockAdapter as any, new Set([123]));
    task.enabled = true;
    return task;
  }

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