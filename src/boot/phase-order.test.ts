/**
 * phase-order.test — assert BOOT_PHASES name sequence matches expected order.
 *
 * Prevents silent reorder/rename regressions. If a phase is added, removed,
 * or renamed, update the expected array below in the same PR that does it.
 */

import { describe, expect, test } from "vitest";
import { BOOT_PHASES } from "../bridge-app.js";

const EXPECTED_PHASE_ORDER = [
  "phaseConfig",
  "phaseMemory",
  "phaseTransport",
  "phaseMemoryIpc",
  "phasePipelineDeps",
  "phasePlatforms",
  "phaseCapabilities",
  "phaseStartupNotification",
  "phaseHeartbeat",
  "phaseSleep",
  "phaseDashboard",
  "phaseAgentApi",
  "phaseShutdown",
] as const;

describe("BOOT_PHASES", () => {
  test("has exactly 13 phases", () => {
    expect(BOOT_PHASES).toHaveLength(EXPECTED_PHASE_ORDER.length);
  });

  test("phase names match expected order", () => {
    const actual = BOOT_PHASES.map(p => p.name);
    expect(actual).toEqual(EXPECTED_PHASE_ORDER);
  });

  test("every phase is a function", () => {
    for (const phase of BOOT_PHASES) {
      expect(typeof phase).toBe("function");
    }
  });
});
