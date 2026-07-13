import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PowerTransitionStore } from "./power-transition-store.js";

const TEST_FILE = join(homedir(), ".abtars", "state", "power-transition.json");

describe("PowerTransitionStore", () => {
  beforeEach(() => {
    try { mkdirSync(join(homedir(), ".abtars", "state"), { recursive: true }); } catch {}
    try { unlinkSync(TEST_FILE); } catch {}
  });

  afterEach(() => {
    try { unlinkSync(TEST_FILE); } catch {}
  });

  it("returns null when no file exists", () => {
    const store = new PowerTransitionStore();
    expect(store.read()).toBeNull();
  });

  it("returns null when transition is inactive", () => {
    const store = new PowerTransitionStore();
    expect(store.isActive()).toBe(false);
  });

  it("stores and retrieves a transition state", () => {
    const store = new PowerTransitionStore();
    const state = {
      state: "suspending" as const,
      taskId: "hardware-sleep",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      expectedWakeAt: Date.now() + 8 * 3600_000,
    };
    store.write(state);
    const read = store.read();
    expect(read).not.toBeNull();
    expect(read!.state).toBe("suspending");
    expect(read!.taskId).toBe("hardware-sleep");
  });

  it("clears the transition state", () => {
    const store = new PowerTransitionStore();
    store.write({
      state: "suspending",
      taskId: "test",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      expectedWakeAt: Date.now() + 8 * 3600_000,
    });
    store.clear();
    expect(store.read()).toBeNull();
  });

  it("returns null for expired transition", () => {
    const store = new PowerTransitionStore();
    store.write({
      state: "suspending",
      taskId: "test",
      requestedAt: Date.now() - 7200_000,
      expiresAt: Date.now() - 3600_000,
      expectedWakeAt: Date.now() - 1800_000,
    });
    expect(store.read()).toBeNull();
  });

  it("isActive returns true when transition exists", () => {
    const store = new PowerTransitionStore();
    store.write({
      state: "suspending",
      taskId: "test",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      expectedWakeAt: Date.now() + 8 * 3600_000,
    });
    expect(store.isActive()).toBe(true);
  });
});
