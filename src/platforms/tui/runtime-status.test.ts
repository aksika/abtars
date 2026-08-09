/**
 * runtime-status.test.ts — #1612 truthful status projection.
 *
 * The TUI footer must never show invented zero usage: a usage snapshot whose
 * every metric is zero (provider reported nothing) is projected as unknown
 * (`?`/omitted), and real usage keeps its cache-hit percentage.
 */

import { describe, it, expect } from "vitest";
import { truthfulUsage, buildTuiRuntimeStatus } from "./runtime-status.js";
import type { ManagedSession } from "../../components/spin-types.js";

describe("truthfulUsage (#1612)", () => {
  it("treats absent usage as unknown", () => {
    expect(truthfulUsage(undefined)).toBeUndefined();
  });

  it("treats a zero-only snapshot as unknown (provider reported nothing)", () => {
    expect(truthfulUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(truthfulUsage({ input: 0, output: 0 })).toBeUndefined();
  });

  it("keeps a snapshot with any real usage", () => {
    const usage = { input: 1200, output: 340, cacheRead: 800, cacheWrite: 90 };
    expect(truthfulUsage(usage)).toEqual(usage);
    // Only cache fields measured still counts as real usage.
    expect(truthfulUsage({ input: 0, output: 0, cacheRead: 5, cacheWrite: 0 })).toBeDefined();
  });
});

describe("buildTuiRuntimeStatus (#1612)", () => {
  function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
    return {
      id: "s1",
      userId: "aksika",
      platform: "tui",
      status: "ready",
      busy: false,
      instructionQueue: [],
      steeringAccepting: false,
      ...overrides,
    } as unknown as ManagedSession;
  }

  it("omits zero-only usage instead of reporting measured zeros", () => {
    const status = buildTuiRuntimeStatus(session({
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      lastTurnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }), 1);
    expect(status.sessionUsage).toBeUndefined();
    expect(status.lastTurnUsage).toBeUndefined();
  });

  it("keeps real usage with a cache-hit percentage", () => {
    const status = buildTuiRuntimeStatus(session({
      sessionUsage: { input: 1000, output: 200, cacheRead: 400, cacheWrite: 0 },
    }), 1);
    expect(status.sessionUsage?.input).toBe(1000);
    expect(status.sessionUsage?.cacheHitPercent).toBeCloseTo(40);
  });

  it("keeps the transport's last-turn usage when the session has none", () => {
    const status = buildTuiRuntimeStatus(session({
      transport: { getRuntimeStatus: () => ({ lastTurnUsage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 } }) },
    }) as unknown as ManagedSession, 1);
    expect(status.lastTurnUsage?.input).toBe(50);
  });

  it("does not infer provider/context fields that the transport omits", () => {
    const status = buildTuiRuntimeStatus(session({ model: undefined, contextPercent: undefined }), 1);
    expect(status.model).toBeUndefined();
    expect(status.contextPercent).toBeUndefined();
  });
});
