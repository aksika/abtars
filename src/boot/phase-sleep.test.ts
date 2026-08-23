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
  startScheduled: vi.fn(() => ({
    status: "accepted" as const,
    completion: Promise.resolve({ status: "completed" as const, failedSteps: [] as string[], report: "test report" }),
  })),
  startManual: vi.fn(() => ({ status: "accepted" })),
})));

vi.mock("../capabilities/sleep/index.js", () => ({
  unavailable: mockUnavailable,
  createSleepHandle: mockCreateSleepHandle,
}));

vi.mock("../components/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logTrace: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../components/env-schema.js", () => ({
  getEnv: vi.fn(() => ({ modelApiTimeoutMs: 30000 })),
}));

function makeFakeClient(): any {
  return {
    sleep: {
      start: vi.fn(),
      status: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      events: vi.fn(),
      runtime: { open: vi.fn(), next: vi.fn(), complete: vi.fn(), fail: vi.fn(), close: vi.fn() },
    },
  };
}

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
      startScheduled: vi.fn(() => ({
        status: "accepted" as const,
        completion: Promise.resolve({ status: "completed" as const, failedSteps: [] as string[], report: "test report" }),
      })),
      startManual: vi.fn(() => ({ status: "accepted" })),
    }));
  });

  it("returns skipped and records memory_disabled when memory is disabled", async () => {
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: false, memoryDir: "" } as any,
      sendSystemMessage: vi.fn(),
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    const result = await phaseSleep(ctx);

    expect(result).toBe("skipped");
    expect(ctx.sleepUnavailable?.code).toBe("memory_disabled");
    expect(ctx.sleepHandle).toBeNull();
    expect(mockCreateSleepHandle).not.toHaveBeenCalled();
  });

  it("returns skipped and records daemon_not_connected when client is null", async () => {
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      client: null,
      sendSystemMessage: vi.fn(),
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    const result = await phaseSleep(ctx);

    expect(result).toBe("skipped");
    expect(ctx.sleepUnavailable?.code).toBe("daemon_not_connected");
    expect(ctx.sleepHandle).toBeNull();
    expect(mockCreateSleepHandle).not.toHaveBeenCalled();
  });

  it("returns skipped and records heartbeat_unavailable when sendSystemMessage is absent", async () => {
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      client: makeFakeClient(),
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
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      client: makeFakeClient(),
      sendSystemMessage: vi.fn(),
      sessionManager: fakeSessionManager as any,
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    const result = await phaseSleep(ctx);

    expect(result).toBe("ran");
    expect(ctx.sleepUnavailable).toBeNull();
    expect(ctx.sleepHandle).not.toBeNull();
    expect(mockCreateSleepHandle).toHaveBeenCalledTimes(1);
    expect(mockCreateSleepHandle.mock.calls[0]?.[0]?.client).toBe(ctx.client);
  });

  it("memory disabled takes precedence over missing client", async () => {
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: false, memoryDir: "" } as any,
      client: null,
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
      client: null,
      sendSystemMessage: vi.fn(),
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    await phaseSleep(ctx);

    const registry = getSystemTaskRegistry();
    expect(registry.has("sleep-cycle")).toBe(true);
  });

  it("#1603: the sleep-cycle handler settles on the awaited cycle outcome — ok on completed", async () => {
    const fakeSessionManager = {
      spin: vi.fn().mockResolvedValue({ result: "ok", sessionId: "sess-1" }),
      getSessionById: vi.fn().mockReturnValue(null),
      allocateDreamySession: vi.fn(),
    };
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      client: makeFakeClient(),
      sendSystemMessage: vi.fn(),
      sessionManager: fakeSessionManager as any,
    });
    const { phaseSleep } = await import("./phase-sleep.js");
    await phaseSleep(ctx);

    const registry = (await import("../components/tasks/system-task-registry.js")).getSystemTaskRegistry();
    const result = await registry.dispatch(
      { id: "sleep-cycle", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", enabled: true, priority: "medium", delivery: "silent" },
      { progress: vi.fn(), signal: new AbortController().signal },
    );
    expect(result.status).toBe("ok");
    expect(registry.has("sleep-cycle")).toBe(true);
  });

  it("#1603: a failed cycle outcome settles the run as failed with the failing steps named", async () => {
    mockCreateSleepHandle.mockImplementationOnce(() => ({
      isActive: false,
      progress: null,
      startScheduled: vi.fn(() => ({
        status: "accepted" as const,
        completion: Promise.resolve({ status: "failed" as const, failedSteps: ["retro-derive"] as string[], report: "report" }),
      })),
      startManual: vi.fn(() => ({ status: "accepted" })),
    }));
    const fakeSessionManager = {
      spin: vi.fn().mockResolvedValue({ result: "ok", sessionId: "sess-1" }),
      getSessionById: vi.fn().mockReturnValue(null),
      allocateDreamySession: vi.fn(),
    };
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      client: makeFakeClient(),
      sendSystemMessage: vi.fn(),
      sessionManager: fakeSessionManager as any,
    });
    const { phaseSleep } = await import("./phase-sleep.js");
    await phaseSleep(ctx);

    const registry = (await import("../components/tasks/system-task-registry.js")).getSystemTaskRegistry();
    const result = await registry.dispatch(
      { id: "sleep-cycle", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", enabled: true, priority: "medium", delivery: "silent" },
      { progress: vi.fn(), signal: new AbortController().signal },
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("retro-derive");
  });
});

describe("#1706 late composition", () => {
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
      startScheduled: vi.fn(() => ({
        status: "accepted" as const,
        completion: Promise.resolve({ status: "completed" as const, failedSteps: [] as string[], report: "test report" }),
      })),
      startManual: vi.fn(() => ({ status: "accepted" })),
    }));
  });

  it("dispatch fails closed before memory composes; after late composeSleep the SAME registration uses the client", async () => {
    const fakeSessionManager = {
      spin: vi.fn().mockResolvedValue({ result: "ok", sessionId: "sess-1" }),
      getSessionById: vi.fn().mockReturnValue(null),
      allocateDreamySession: vi.fn(),
    };
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      client: null,
      sendSystemMessage: vi.fn(),
      sessionManager: fakeSessionManager as any,
    });
    const { phaseSleep, composeSleep } = await import("./phase-sleep.js");
    await phaseSleep(ctx);

    const registry = (await import("../components/tasks/system-task-registry.js")).getSystemTaskRegistry();
    expect(registry.has("sleep-cycle")).toBe(true);
    const entry = { id: "sleep-cycle", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", enabled: true, priority: "medium", delivery: "silent" };
    const taskCtx = { progress: vi.fn(), signal: new AbortController().signal };

    const before = await registry.dispatch(entry, taskCtx);
    expect(before.status).toBe("failed");
    if (before.status === "failed") expect(before.error).toBe("reason:daemon_not_connected");

    // Late memory publication delivers the client through the same ctx.
    composeSleep(ctx, makeFakeClient());

    expect(ctx.sleepHandle).not.toBeNull();
    expect(mockCreateSleepHandle).toHaveBeenCalledTimes(1); // no duplicate handle
    expect(registry.has("sleep-cycle")).toBe(true);          // no duplicate registration

    const handleInstance = mockCreateSleepHandle.mock.results[0]!.value;
    const after = await registry.dispatch(entry, taskCtx);
    expect(after.status).toBe("ok");
    expect(handleInstance.startScheduled).toHaveBeenCalledTimes(1);
  });

  it("composeSleep is idempotent — an existing handle is never replaced", async () => {
    const fakeSessionManager = {
      spin: vi.fn().mockResolvedValue({ result: "ok", sessionId: "sess-1" }),
      getSessionById: vi.fn().mockReturnValue(null),
      allocateDreamySession: vi.fn(),
    };
    const ctx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      client: makeFakeClient(),
      sendSystemMessage: vi.fn(),
      sessionManager: fakeSessionManager as any,
    });
    const { composeSleep } = await import("./phase-sleep.js");

    composeSleep(ctx, makeFakeClient());
    const first = ctx.sleepHandle;
    composeSleep(ctx, makeFakeClient());

    expect(ctx.sleepHandle).toBe(first);
    expect(mockCreateSleepHandle).toHaveBeenCalledTimes(1);
  });

  it("keeps the process-scoped dispatcher on the newest restart generation", async () => {
    const firstCtx = createBootCtx({
      memoryConfig: { memoryEnabled: false, memoryDir: "" } as any,
      client: null,
      sendSystemMessage: vi.fn(),
    });
    const fakeSessionManager = {
      spin: vi.fn().mockResolvedValue({ result: "ok", sessionId: "sess-1" }),
      getSessionById: vi.fn().mockReturnValue(null),
      allocateDreamySession: vi.fn(),
    };
    const secondClient = makeFakeClient();
    const secondCtx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" } as any,
      client: secondClient,
      sendSystemMessage: vi.fn(),
      sessionManager: fakeSessionManager as any,
    });

    const { phaseSleep } = await import("./phase-sleep.js");
    await phaseSleep(firstCtx);
    await phaseSleep(secondCtx);

    const registry = (await import("../components/tasks/system-task-registry.js")).getSystemTaskRegistry();
    const result = await registry.dispatch(
      { id: "sleep-cycle", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", enabled: true, priority: "medium", delivery: "silent" },
      { progress: vi.fn(), signal: new AbortController().signal },
    );

    expect(result.status).toBe("ok");
    expect(mockCreateSleepHandle.mock.calls.at(-1)?.[0]?.client).toBe(secondClient);
  });
});
