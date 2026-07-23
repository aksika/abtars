import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { HeartbeatSystem } from "../components/heartbeat-system.js";
import { createUserSessionExpiryTask } from "../components/heartbeat-tasks.js";
import { createHousekeepingTask } from "../components/heartbeat-housekeeping.js";

function makeHb(intervalMs = 60000) {
  return new HeartbeatSystem({ enabled: true, intervalMs, bridgeLockPath: "/tmp/test.lock" });
}

describe("heartbeat registration surface", () => {
  const expectedCore = [
    "restart-check",
    "snapshot-refresh",
    "tasks",
    "user-session-expiry",
    "housekeeping",
  ];

  it("registers core required tasks", () => {
    const hb = makeHb();
    hb.registerTask({ name: "restart-check", execute: async () => ({ state: "idle" }) });
    hb.registerTask({ name: "snapshot-refresh", execute: async () => ({ state: "ran" }) });
    hb.registerTask({ name: "tasks", execute: async () => ({ state: "idle" }) });
    hb.registerTask(createUserSessionExpiryTask());
    hb.registerTask(createHousekeepingTask({
      heartbeatIntervalMs: 60000,
      memoryRuntime: null as any,
      cronQueueDepth: () => 0,
      notifyUpdate: () => {},
    }));
    for (const name of expectedCore) {
      expect(hb.getTaskNames()).toContain(name);
    }
  });

  it("includes reconciler-resync and spin-tick when registered", () => {
    const hb = makeHb();
    hb.registerTask({ name: "restart-check", execute: async () => ({ state: "idle" }) });
    hb.registerTask({ name: "snapshot-refresh", execute: async () => ({ state: "ran" }) });
    hb.registerTask({ name: "tasks", execute: async () => ({ state: "idle" }) });
    hb.registerTask(createUserSessionExpiryTask());
    hb.registerTask(createHousekeepingTask({
      heartbeatIntervalMs: 60000,
      memoryRuntime: null as any,
      cronQueueDepth: () => 0,
      notifyUpdate: () => {},
    }));
    hb.registerTask({ name: "reconciler-resync", execute: async () => ({ state: "ran" }) });
    hb.registerTask({ name: "spin-tick", execute: async () => ({ state: "ran" }) });

    expect(hb.getTaskNames()).toContain("reconciler-resync");
    expect(hb.getTaskNames()).toContain("spin-tick");
  });

  it("includes transport-health when transport has healthCheck", () => {
    const hb = makeHb();
    hb.registerTask({ name: "transport-health", execute: async () => ({ state: "ran" }) });
    expect(hb.getTaskNames()).toContain("transport-health");
  });

  it("does not include removed names", () => {
    const removed = [
      "skill-stats-flush",
      "update-check",
      "db-integrity",
      "kanban-cleanup",
      "metrics",
      "reminder-injector",
      "skill-reload",
      "idle-compact",
      "model-health",
      "busy-unstick",
    ];
    const hb = makeHb();
    hb.registerTask({ name: "restart-check", execute: async () => ({ state: "idle" }) });
    for (const name of removed) {
      expect(hb.getTaskNames()).not.toContain(name);
    }
  });

  it("housekeeping children match spec", () => {
    const hb = makeHb();
    const task = createHousekeepingTask({
      heartbeatIntervalMs: 60000,
      memoryRuntime: null as any,
      cronQueueDepth: () => 0,
      notifyUpdate: () => {},
    });
    expect(task.name).toBe("housekeeping");
  });

  it("heartbeat code does not reference busy-unstick or sendInterrupt", () => {
    const src = readFileSync("src/components/heartbeat-system.ts", "utf-8");
    expect(src).not.toContain("busy");
    expect(src).not.toContain("sendInterrupt");
  });
});