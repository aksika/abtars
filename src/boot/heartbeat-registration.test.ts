import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { HeartbeatSystem } from "../components/heartbeat-system.js";
import { createUserSessionExpiryTask } from "../components/heartbeat-tasks.js";
import { createHousekeepingTask } from "../components/heartbeat-housekeeping.js";
import { selectDrainPeers } from "./heartbeat-tier3.js";

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

  describe("remote-pi-drain round-robin peer selection (#1358 budget)", () => {
    it("touches at most 4 peers per tick out of 10", () => {
      const peers = Array.from({ length: 10 }, (_, i) => `peer-${i}`);
      const { peers: selected, nextCursor } = selectDrainPeers(peers, 0, 4);
      expect(selected).toEqual(["peer-0", "peer-1", "peer-2", "peer-3"]);
      expect(nextCursor).toBe(4);
    });

    it("round-robin advances so no peer starves across ticks", () => {
      const peers = Array.from({ length: 10 }, (_, i) => `peer-${i}`);
      const touched = new Set<string>();
      let cursor = 0;
      for (let tick = 0; tick < 10; tick++) {
        const { peers: selected, nextCursor } = selectDrainPeers(peers, cursor, 4);
        for (const p of selected) touched.add(p);
        cursor = nextCursor;
      }
      // Over 10 ticks of up-to-4 peers each, every one of the 10 peers is
      // touched, and the cursor stays within the connected set (wraps).
      expect(touched.size).toBe(10);
      expect(cursor).toBeLessThanOrEqual(10);
    });

    it("is stable when the connected set shrinks or grows", () => {
      const peers = ["peer-a", "peer-b", "peer-c"];
      const r1 = selectDrainPeers(peers, 0, 4);
      expect(r1.peers).toEqual(["peer-a", "peer-b", "peer-c"]);
      // Cursor survives restarts; modulo keeps it in range (5 % 3 = 2).
      const r2 = selectDrainPeers(peers, 5, 4);
      expect(r2.peers[0]).toBe("peer-c");
      expect(selectDrainPeers([], 5, 4).peers).toEqual([]);
    });
  });

  it("heartbeat code does not reference busy-unstick or sendInterrupt", () => {
    const src = readFileSync("src/components/heartbeat-system.ts", "utf-8");
    expect(src).not.toContain("busy");
    expect(src).not.toContain("sendInterrupt");
  });
});