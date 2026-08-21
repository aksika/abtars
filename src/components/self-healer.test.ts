import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSelfHealerTask } from "./self-healer.js";
import { _resetEnv } from "./env-schema.js";
import { BOOT_QUIET_MS, isWithinBootQuietWindow } from "./self-healer-utils.js";

vi.mock("./logger.js", () => ({
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(), logTrace: vi.fn(),
  getLogFile: () => "/dev/null",
}));

describe("isWithinBootQuietWindow (#1589)", () => {
  const now = 1_750_000_000_000;

  it.each<[string, unknown, boolean]>([
    ["inside the window suppresses", now - 60_000, true],
    ["exactly at BOOT_QUIET_MS does not suppress", now - BOOT_QUIET_MS, false],
    ["well past the window does not suppress", now - 10 * BOOT_QUIET_MS, false],
    ["undefined startedAt does not suppress", undefined, false],
    ["NaN startedAt does not suppress", NaN, false],
    ["string startedAt does not suppress", "123", false],
    ["future startedAt does not suppress", now + 60_000, false],
  ])("%s", (_name, startedAt, expected) => {
    expect(isWithinBootQuietWindow(startedAt, now)).toBe(expected);
  });
});

describe("createSelfHealerTask (#1688 log source)", () => {
  beforeEach(() => { _resetEnv(); });

  it("creates a plain heartbeat task with no process-local enable setter", () => {
    const task = createSelfHealerTask(vi.fn());
    expect(task.name).toBe("self-healer");
    expect((task as { enabled?: unknown }).enabled).toBeUndefined();
  });

  it("execute runs without error on an empty log", async () => {
    const task = createSelfHealerTask(vi.fn());
    await task.execute(); // should not throw
  });

  it("never throws on unreadable log state", async () => {
    const task = createSelfHealerTask(vi.fn());
    const result = await task.execute();
    expect(["idle", "ran"]).toContain(result.state);
  });
});