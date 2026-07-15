import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBootCtx } from "./context.js";
import { _resetSystemTaskRegistry } from "../components/tasks/system-task-registry.js";

const mockUnavailable = vi.hoisted(() => vi.fn((code: string) => ({
  status: "unavailable" as const,
  code,
  reason: `reason:${code}`,
})));

const mockCreateSleepHandle = vi.hoisted(() => vi.fn(() => ({
  isActive: false,
  progress: null,
  startScheduled: vi.fn(() => ({ status: "accepted" })),
  startManual: vi.fn(() => ({ status: "accepted" })),
})));

vi.mock("../capabilities/sleep/index.js", () => ({
  unavailable: mockUnavailable,
  createSleepHandle: mockCreateSleepHandle,
}));

vi.mock("../components/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../components/env-schema.js", () => ({
  getEnv: vi.fn(() => ({ modelApiTimeoutMs: 30000 })),
}));

describe("phaseSleep — #1429 precedence and construction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSystemTaskRegistry();
    mockUnavailable.mockImplementation((code: string) => ({
      status: "unavailable" as const,
      code,
      reason: `reason:${code}`,
    }));
    mockCreateSleepHandle.mockImplementation(() => ({
      isActive: false,
      progress: null,
      startScheduled: vi.fn(() => ({ status: "accepted" })),
      startManual: vi.fn(() => ({ status: "accepted" })),
    }));
  });

  it("returns skipped and records memory_disabled when memory is disabled", async () => {
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: false, memoryDir: "" } as any,
      abmindModule: {} as any,
      sendSystemMessage: vi.fn(),
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    const result = await phaseSleep(ctx);

    expect(result).toBe("skipped");
    expect(ctx.sleepUnavailable?.code).toBe("memory_disabled");
    expect(ctx.sleepHandle).toBeNull();
    expect(mockCreateSleepHandle).not.toHaveBeenCalled();
  });

  it("returns skipped and records abmind_not_loaded when abmindModule is null", async () => {
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      abmindModule: null,
      sendSystemMessage: vi.fn(),
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    const result = await phaseSleep(ctx);

    expect(result).toBe("skipped");
    expect(ctx.sleepUnavailable?.code).toBe("abmind_not_loaded");
    expect(ctx.sleepHandle).toBeNull();
    expect(mockCreateSleepHandle).not.toHaveBeenCalled();
  });

  it("returns skipped and records heartbeat_unavailable when sendSystemMessage is absent", async () => {
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      abmindModule: {} as any,
      sendSystemMessage: undefined,
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    const result = await phaseSleep(ctx);

    expect(result).toBe("skipped");
    expect(ctx.sleepUnavailable?.code).toBe("heartbeat_unavailable");
    expect(ctx.sleepHandle).toBeNull();
    expect(mockCreateSleepHandle).not.toHaveBeenCalled();
  });

  it("constructs handle and returns ran when all prerequisites pass", async () => {
    const fakeSessionManager = {
      spin: vi.fn().mockResolvedValue({ result: "ok", sessionId: "sess-1" }),
      getSessionById: vi.fn().mockReturnValue(null),
      allocateDreamySession: vi.fn(),
    };
    const fakeModule = {};
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      abmindModule: fakeModule as any,
      sendSystemMessage: vi.fn(),
      sessionManager: fakeSessionManager as any,
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    const result = await phaseSleep(ctx);

    expect(result).toBe("ran");
    expect(ctx.sleepUnavailable).toBeNull();
    expect(ctx.sleepHandle).not.toBeNull();
    expect(mockCreateSleepHandle).toHaveBeenCalledTimes(1);
    expect(mockCreateSleepHandle.mock.calls[0]?.[0]?.api).toBe(fakeModule);
  });

  it("memory disabled takes precedence over missing abmindModule", async () => {
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: false, memoryDir: "" } as any,
      abmindModule: null,
      sendSystemMessage: vi.fn(),
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    const result = await phaseSleep(ctx);

    expect(result).toBe("skipped");
    expect(ctx.sleepUnavailable?.code).toBe("memory_disabled");
  });

  it("registers unavailable handler when prerequisites fail", async () => {
    const { getSystemTaskRegistry } = await import("../components/tasks/system-task-registry.js");
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: false, memoryDir: "" } as any,
      abmindModule: null,
      sendSystemMessage: vi.fn(),
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    await phaseSleep(ctx);

    const registry = getSystemTaskRegistry();
    expect(registry.has("sleep-cycle")).toBe(true);
  });
});
