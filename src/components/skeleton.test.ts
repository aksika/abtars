import { describe, it, expect } from "vitest";
import { HeartbeatSystem } from "./heartbeat-system.js";
import { SkillWatcher } from "./skill-watcher.js";
import { DashboardServer } from "./dashboard/dashboard-server.js";
import type { ITaskSlot, ISkillSlot, IDashboardSlot } from "./skeleton.js";

describe("Skeleton slot conformance", () => {
  it("HeartbeatSystem implements ITaskSlot", () => {
    const hb = new HeartbeatSystem({ enabled: false, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock" });
    const slot: ITaskSlot = hb;
    expect(typeof slot.registerTask).toBe("function");
    expect(typeof slot.start).toBe("function");
    expect(typeof slot.stop).toBe("function");
    expect(typeof slot.getTaskNames).toBe("function");
    expect(typeof slot.getTaskStatuses).toBe("function");
    expect(typeof slot.intervalMs).toBe("number");
  });

  it("SkillWatcher implements ISkillSlot", () => {
    const sw = new SkillWatcher("/tmp/skills", "/tmp/TOOLS.md");
    const slot: ISkillSlot = sw;
    expect(typeof slot.checkForChanges).toBe("function");
    expect(typeof slot.appendToTools).toBe("function");
  });

  it("DashboardServer implements IDashboardSlot", () => {
    // Type-level check — DashboardServer satisfies IDashboardSlot
    const check: IDashboardSlot = { start: DashboardServer.prototype.start, stop: DashboardServer.prototype.stop };
    expect(typeof check.start).toBe("function");
    expect(typeof check.stop).toBe("function");
  });
});
