import { describe, it, expect } from "vitest";
import { PowerTransitionStore } from "./power-transition-store.js";
import { currentTestSandbox } from "../../test-support/runtime-isolation.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("PowerTransitionStore", () => {
  it("returns null when no file exists", () => {
    const store = new PowerTransitionStore();
    expect(store.read()).toBeNull();
  });

  it("returns null when transition is inactive", () => {
    const store = new PowerTransitionStore();
    expect(store.isActive()).toBe(false);
  });

  it("stores and retrieves a transition state under the sandbox", () => {
    const sandbox = currentTestSandbox();
    const customPath = join(sandbox.abtarsHome, "state", "power-transition.json");
    const store = new PowerTransitionStore(customPath);
    const state = {
      state: "suspending" as const,
      taskId: "hardware-sleep",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      expectedWakeAt: Date.now() + 8 * 3600_000,
    };
    store.write(state);
    expect(existsSync(customPath)).toBe(true);
    const read = store.read();
    expect(read).not.toBeNull();
    expect(read!.state).toBe("suspending");
    expect(read!.taskId).toBe("hardware-sleep");
  });

  it("default constructor writes under sandboxed ABTARS_HOME", () => {
    const store = new PowerTransitionStore();
    const state = {
      state: "suspending",
      taskId: "test",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      expectedWakeAt: Date.now() + 8 * 3600_000,
    };
    store.write(state);
    expect(store.read()).not.toBeNull();
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

  it("two stores with different paths do not interfere", () => {
    const sandbox = currentTestSandbox();
    const storeA = new PowerTransitionStore(join(sandbox.abtarsHome, "state", "a.json"));
    const storeB = new PowerTransitionStore(join(sandbox.abtarsHome, "state", "b.json"));
    storeA.write({
      state: "suspending",
      taskId: "a",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      expectedWakeAt: Date.now() + 8 * 3600_000,
    });
    expect(storeA.read()).not.toBeNull();
    expect(storeB.read()).toBeNull();
    expect(storeB.isActive()).toBe(false);
  });

  describe("#1517 attempt ownership", () => {
    function marker(attemptId?: string) {
      return {
        state: "suspending" as const,
        taskId: "hardware-sleep",
        requestedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        expectedWakeAt: Date.now() + 8 * 3600_000,
        ...(attemptId !== undefined ? { attemptId } : {}),
      };
    }

    it("isActiveExcept ignores only the exact attempt ID", () => {
      const store = new PowerTransitionStore();
      store.write(marker("own-attempt"));
      expect(store.isActiveExcept()).toBe(true);
      expect(store.isActiveExcept("own-attempt")).toBe(false);
      expect(store.isActiveExcept("other-attempt")).toBe(true);
    });

    it("never excludes a marker without an attempt ID", () => {
      const store = new PowerTransitionStore();
      store.write(marker(undefined));
      expect(store.isActiveExcept("anything")).toBe(true);
    });

    it("clearIfOwned clears only the marker owned by that attempt", () => {
      const store = new PowerTransitionStore();
      store.write(marker("own-attempt"));
      expect(store.clearIfOwned("stale-attempt")).toBe(false);
      expect(store.read()).not.toBeNull();
      expect(store.clearIfOwned("own-attempt")).toBe(true);
      expect(store.read()).toBeNull();
    });

    it("stale cleanup cannot erase a replacement marker", () => {
      const store = new PowerTransitionStore();
      store.write(marker("new-attempt"));
      expect(store.clearIfOwned("old-attempt")).toBe(false);
      expect(store.read()?.attemptId).toBe("new-attempt");
    });
  });
});
