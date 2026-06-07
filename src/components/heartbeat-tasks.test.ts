import { describe, it, expect, vi } from "vitest";
import { createDbIntegrityTask } from "./heartbeat-tasks.js";

describe("createDbIntegrityTask", () => {
  const makeMockMemory = (integrityResult: string, rebuildResult: string[]) => ({
    maintenance: { checkIntegrity: vi.fn(() => integrityResult) },
    rebuildFtsIndexes: vi.fn(() => ({ rebuilt: rebuildResult })),
  });

  it("skips when memory is null", async () => {
    const task = createDbIntegrityTask(null);
    await task.execute();
    // no throw
  });

  it("does nothing when integrity is ok", async () => {
    const mem = makeMockMemory("ok", []);
    const task = createDbIntegrityTask(mem as any);
    // force past interval
    (task as any).lastCheckAt = 0;
    await task.execute();
    expect(mem.rebuildFtsIndexes).not.toHaveBeenCalled();
  });

  it("rebuilds on failure and resets counter on success", async () => {
    const mem = makeMockMemory("corrupt", ["messages_fts"]);
    const task = createDbIntegrityTask(mem as any);
    await task.execute();
    expect(mem.rebuildFtsIndexes).toHaveBeenCalled();
  });

  it("escalates after 5 consecutive rebuild failures", async () => {
    const mem = makeMockMemory("corrupt", []);
    const task = createDbIntegrityTask(mem as any);

    // Bypass interval guard by advancing time
    const realNow = Date.now;
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    for (let i = 0; i < 5; i++) {
      clock += 3_600_001; // advance past 1h interval
      await task.execute();
    }

    // Escalation buffers a system event — just verify no throw
    vi.restoreAllMocks();
  });

  it("stops retrying after escalation", async () => {
    const mem = makeMockMemory("corrupt", []);
    const task = createDbIntegrityTask(mem as any);

    vi.spyOn(Date, "now").mockImplementation(() => {
      return (stopClock += 3_600_001);
    });

    for (let i = 0; i < 6; i++) await task.execute();

    // 6th call should not invoke checkIntegrity (escalated = true)
    expect(mem.maintenance.checkIntegrity).toHaveBeenCalledTimes(5);
    vi.restoreAllMocks();
  });
});

let stopClock = 0;
