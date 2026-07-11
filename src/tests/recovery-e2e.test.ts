/**
 * Recovery E2E tests — verify standby resume classification (#1321: daily-cycle
 * bedtime/quiet-tick scheduling was deleted; sleep scheduling now lives in
 * tasks.json as a system cron task. General OS standby-resume detection is
 * independent of sleep scheduling and remains covered here).
 */
import { describe, it, expect } from "vitest";
import { classifyResume } from "../components/platform-detect.js";

describe("Recovery E2E: standby resume", () => {
  it("classifyResume returns valid wake type", () => {
    const result = classifyResume();
    expect(["dark", "full", "unknown"]).toContain(result);
  });
});
