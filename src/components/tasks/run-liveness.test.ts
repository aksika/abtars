import { describe, expect, it } from "vitest";
import { ownerIsLive, pidExists, processStartTime, currentProcessStartTime } from "./run-liveness.js";

describe("run-liveness #1601", () => {
  it("records a stable start-time token for the current process", () => {
    const token = currentProcessStartTime();
    expect(typeof token).toBe("number");
    expect(processStartTime(process.pid)).toBe(token);
  });

  it("considers a live process with matching start time live", () => {
    expect(ownerIsLive(process.pid, currentProcessStartTime())).toBe(true);
  });

  it("considers a nonexistent pid dead, regardless of start time", () => {
    // 2^31-1 is above any realistic pid space; no process can own it.
    const ghost = 2147483647;
    expect(pidExists(ghost)).toBe(false);
    expect(ownerIsLive(ghost, null)).toBe(false);
    expect(ownerIsLive(ghost, 12345)).toBe(false);
  });

  it("considers a falsified owner_started_at dead (pid reuse guard)", () => {
    const token = currentProcessStartTime()!;
    expect(ownerIsLive(process.pid, token + 1)).toBe(false);
  });

  it("fails safe: an unprovable started_at reports live", () => {
    // owner_started_at IS NULL (e.g. every migrated pre-existing run) must
    // never be settled `unknown` spuriously.
    expect(ownerIsLive(process.pid, null)).toBe(true);
  });
});
