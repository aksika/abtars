import { describe, it, expect } from "vitest";
import { MacPowerAdapter } from "./mac-power-adapter.js";

const MOLTY_FIXTURE = `Repeating power events:
  wakepoweron at 7:55AM every day

Scheduled power events:
  07/11/26 14:00:00 wakeorpoweron at 14:00:00
  07/11/26 15:00:00 wakeorpoweron at 15:00:00
`;

describe("MacPowerAdapter", () => {
  it("verifyWakeSchedule parses pmset output via fake runner", async () => {
    const adapter = new MacPowerAdapter(async (cmd, args) => {
      expect(cmd).toBe("/usr/bin/pmset");
      expect(args).toEqual(["-g", "sched"]);
      return { stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 };
    });
    const r = await adapter.verifyWakeSchedule("07:55");
    expect(r.verified).toBe(true);
    expect(r.kind).toBe("wakepoweron");
  });

  it("verifyWakeSchedule returns unverified on non-zero exit", async () => {
    const adapter = new MacPowerAdapter(async () => {
      return { stdout: "", stderr: "error", exitCode: 1 };
    });
    const r = await adapter.verifyWakeSchedule("07:55");
    expect(r.verified).toBe(false);
  });

  it("suspend throws under test runtime", async () => {
    const adapter = new MacPowerAdapter(async () => {
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await expect(adapter.suspend()).rejects.toThrow("hardware suspend disabled under test runtime");
  });
});
