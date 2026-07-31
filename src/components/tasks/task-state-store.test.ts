import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

let home: string;
let store: typeof import("./task-state-store.js");

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "task-state-store-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  store = await import("./task-state-store.js");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("initializeState legacy repair", () => {
  it("preserves a valid incident while clearing incoherent auto-pause", () => {
    writeFileSync(join(home, "tasks", "task-state.json"), JSON.stringify({
      task: {
        nextRunAt: null,
        consecutiveFailures: 0,
        consecutiveDeferrals: 0,
        autoPaused: true,
        pausedAt: 123,
        lastIncident: {
          version: 1,
          category: "execution",
          code: "model_error",
          phase: "executing",
          message: "provider failed",
          retryability: "none",
          occurredAt: 122,
        },
      },
    }));

    store.initializeState([{
      id: "task", kind: "agent", prompt: "p", agent: "task", interaction: { mode: "oneshot" },
      delivery: "silent", enabled: true, priority: "medium", at: new Date().toISOString(),
    }]);

    const repaired = store.readState("task")!;
    expect(repaired.autoPaused).toBe(false);
    expect(repaired.lastIncident?.code).toBe("model_error");
  });
});
