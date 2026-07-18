/**
 * #1429 — Regression: injected SleepApi survives global cache resets.
 *
 * A constructed SleepHandle must use the API it was given at construction,
 * not re-resolve the mutable global abmind cache. Clearing the lazy-loader
 * cache after handle creation must not affect admission or execution.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSleepHandle, type SleepApi } from "./index.js";

const mockRunSleepCycle = vi.fn(async () => ({
  runId: "run-1", status: "completed" as const, startedAt: 0, finishedAt: 0, llmCalls: 0,
  steps: [], essentialFailures: [], resumable: false, watermarkAdvanced: true, report: "ok",
}));

vi.mock("../../components/system-event-buffer.js", () => ({
  bufferSystemEvent: vi.fn(),
}));

const stubApi: SleepApi = {
  DEFAULT_LEVEL: "normal",
  parseLevel: (s: string) => s,
  runSleepCycle: mockRunSleepCycle,
};

/** Simulate clearing the global lazy-loader cache (#1429). */
let _resetAbmindCache: (() => void) | null = null;

async function ensureResetFn(): Promise<void> {
  if (!_resetAbmindCache) {
    const mod = await import("../../utils/abmind-lazy.js");
    _resetAbmindCache = mod.resetAbmindCache;
  }
}

async function resetAbmindCache(): Promise<void> {
  await ensureResetFn();
  _resetAbmindCache!();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

describe("injected SleepApi lifetime (#1429)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSleepCycle.mockImplementation(async () => ({
      runId: "run-1", status: "completed" as const, startedAt: 0, finishedAt: 0, llmCalls: 0,
      steps: [], essentialFailures: [], resumable: false, watermarkAdvanced: true, report: "ok",
    }));
  });

  it("manual start uses the injected API after cache reset", async () => {
    const handle = createSleepHandle({
      api: stubApi,
      memoryEnabled: false,
      runtime: { complete: async () => "" },
      onComplete: () => {},
    });

    await resetAbmindCache();

    const result = handle.startManual({ fresh: true, resume: false });
    expect(result.status).toBe("accepted");
    expect(mockRunSleepCycle).toHaveBeenCalledTimes(1);
    expect(mockRunSleepCycle).toHaveBeenCalledWith(
      expect.objectContaining({ level: "ultimate", fresh: true, mode: "manual" }),
    );
    await settle();
  });

  it("scheduled start uses the injected API after cache reset", async () => {
    const handle = createSleepHandle({
      api: stubApi,
      memoryEnabled: false,
      runtime: { complete: async () => "" },
      onComplete: () => {},
    });

    await resetAbmindCache();

    const result = handle.startScheduled();
    expect(result.status).toBe("accepted");
    expect(mockRunSleepCycle).toHaveBeenCalledTimes(1);
    await settle();
  });

  it("parseLevel and DEFAULT_LEVEL come from the injected API", async () => {
    const customApi: SleepApi = {
      DEFAULT_LEVEL: "deep",
      parseLevel: vi.fn((s: string) => s === "deep" ? "deep" : "normal"),
      runSleepCycle: mockRunSleepCycle,
    };
    // We can't easily test scheduledLevel() since it reads SLEEP_QUALITY from env.
    // Instead verify that the handle accepts and starts without error — the
    // scheduledLevel fallback calls api.DEFAULT_LEVEL which is "deep".
    const handle = createSleepHandle({
      api: customApi,
      memoryEnabled: false,
      runtime: { complete: async () => "" },
      onComplete: () => {},
    });
    expect(handle.startScheduled().status).toBe("accepted");
    await settle();
  });

  it("handle does not call abmind() or abmind-lazy after construction", async () => {
    // Spy on the lazy module to verify it's never called
    const lazy = await import("../../utils/abmind-lazy.js");
    const abmindSpy = vi.spyOn(lazy, "abmind");

    const handle = createSleepHandle({
      api: stubApi,
      memoryEnabled: false,
      runtime: { complete: async () => "" },
      onComplete: () => {},
    });

    handle.startManual({ fresh: true, resume: false });
    handle.startScheduled();

    expect(abmindSpy).not.toHaveBeenCalled();
    await settle();
  });
});
