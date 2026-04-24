import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSelfHealerTask } from "./self-healer.js";
import { _resetEnv } from "./env-schema.js";

vi.mock("./logger.js", () => ({
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
  getLogFile: () => "/dev/null",
}));

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
