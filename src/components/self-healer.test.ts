import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSelfHealerTask } from "./self-healer.js";
import { _resetEnv } from "./env-schema.js";
import { BOOT_QUIET_MS, isWithinBootQuietWindow } from "./self-healer-utils.js";

/*
 * TEST DEFICIENCY (2026-08-13):
 * Missing: handleUnknownFault's #1651 v2 text-only success gate — a non-text
 * dispatchAwait outcome routes through the failure path (recordResult false,
 * AGENT FAIL notification) instead of AGENT OK. The full path needs a live
 * bridge.lock, adapter notify stub, and a git-clone fallback harness.
 * Reason deferred: disproportionate harness (fs + git + adapter mocks) for a
 * 4-line guard whose policy shape is identical to the tested Agent API peer
 * gate (agent-api-adapter.test.ts) and scheduled announce gate
 * (scheduled-task-runner.test.ts).
 * Future verification: a component test mocking fs/git after the healer is
 * refactored to accept an injectable dispatch facade.
 */

vi.mock("./logger.js", () => ({
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
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

describe("createSelfHealerTask", () => {
  beforeEach(() => { _resetEnv(); });

  it("creates task with correct name", () => {
    const task = createSelfHealerTask(() => null, new Set());
    expect(task.name).toBe("self-healer");
  });

  it("respects enabled toggle", () => {
    const task = createSelfHealerTask(() => null, new Set());
    expect(task.enabled).toBe(false); // default from env schema
    task.enabled = true;
    expect(task.enabled).toBe(true);
  });

  it("execute does nothing when disabled", async () => {
    const task = createSelfHealerTask(() => null, new Set());
    task.enabled = false;
    await task.execute(); // should not throw
  });

  it("execute runs without error when enabled with empty log", async () => {
    const task = createSelfHealerTask(() => null, new Set());
    task.enabled = true;
    // /dev/null is empty — should complete without errors
    await task.execute();
  });
});
