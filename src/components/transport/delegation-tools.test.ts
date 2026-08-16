import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubagentRuntime } from "../subagent-runtime.js";

vi.mock("../master-user.js", () => ({ getMasterUserId: vi.fn(() => "master-1") }));
vi.mock("../completion-buffer.js", () => ({
  addCompletion: vi.fn(),
  drainCompletions: vi.fn(() => []),
  hasCompletions: vi.fn(() => false),
}));

const { spawnSessionTool, checkSessionTool, terminateSessionTool, sendToSessionTool, setDelegationDeps, getActiveBackgrounds, consumePendingInstruction } = await import("./delegation-tools.js");
const { addCompletion } = await import("../completion-buffer.js");

const runtime = {
  spawn: vi.fn().mockResolvedValue({ taskId: "task-1" }),
  interruptSpawn: vi.fn().mockReturnValue(true),
} as unknown as SubagentRuntime;

const sessionDispatch = {
  createSubSession: vi.fn(),
  getSessionById: vi.fn(),
  spawnChild: vi.fn(),
};

function seedBackground(overrides: Record<string, unknown> = {}): void {
  getActiveBackgrounds().set("t1", {
    taskId: "t1", sessionId: "s1", goal: "g", startedAt: Date.now(),
    status: "running", inputTokens: 0, outputTokens: 0,
    ...overrides,
  });
}

describe("Delegation Tools", () => {
  beforeEach(() => {
    getActiveBackgrounds().clear();
    vi.clearAllMocks();
    runtime.spawn.mockResolvedValue({ taskId: "task-1" });
    runtime.interruptSpawn.mockReturnValue(true);
    sessionDispatch.createSubSession.mockReturnValue({ id: "s1", motherId: "m1" });
    setDelegationDeps(runtime, sessionDispatch);
  });

  describe("send_to_session", () => {
    it("returns error for unknown task_id", async () => {
      const result = JSON.parse(await sendToSessionTool.execute({ task_id: "nope", message: "hi" }));
      expect(result.error).toContain("No background session");
    });

    it("returns error for non-running session", async () => {
      getActiveBackgrounds().set("t1", {
        taskId: "t1", sessionId: "s1", goal: "g", startedAt: Date.now(),
        status: "done", inputTokens: 0, outputTokens: 0,
      });
      const result = JSON.parse(await sendToSessionTool.execute({ task_id: "t1", message: "hi" }));
      expect(result.error).toContain("done");
    });

    it("sets pendingInstruction on running session", async () => {
      getActiveBackgrounds().set("t2", {
        taskId: "t2", sessionId: "s2", goal: "g", startedAt: Date.now(),
        status: "running", inputTokens: 0, outputTokens: 0,
      });
      const result = JSON.parse(await sendToSessionTool.execute({ task_id: "t2", message: "do more" }));
      expect(result.delivered).toBe(true);
      expect(getActiveBackgrounds().get("t2")!.pendingInstruction).toBe("do more");
    });
  });

  describe("consumePendingInstruction", () => {
    it("returns undefined when no instruction", () => {
      seedBackground({ status: "running" });
      expect(consumePendingInstruction("t1")).toBeUndefined();
    });

    it("returns and clears pending instruction", () => {
      seedBackground({ status: "running", pendingInstruction: "focus on auth" });
      expect(consumePendingInstruction("t1")).toBe("focus on auth");
      expect(consumePendingInstruction("t1")).toBeUndefined();
    });
  });

  describe("check_session", () => {
    it("returns error for unknown task", async () => {
      const result = JSON.parse(await checkSessionTool.execute({ task_id: "nope" }));
      expect(result.error).toContain("No background session");
    });

    it("returns status for known task", async () => {
      seedBackground({ startedAt: Date.now() - 5000 });
      const result = JSON.parse(await checkSessionTool.execute({ task_id: "t1" }));
      expect(result.status).toBe("running");
      expect(result.goal).toBe("g");
      expect(result.elapsed_seconds).toBeGreaterThanOrEqual(4);
    });
  });

  describe("spawn_session", () => {
    it("forwards to the injected session dispatch and runtime spawn", async () => {
      const result = JSON.parse(await spawnSessionTool.execute({ type: "code", goal: "build a thing" }));

      expect(sessionDispatch.createSubSession).toHaveBeenCalledWith("master-1", "telegram", "C");
      expect(runtime.spawn).toHaveBeenCalledWith("coding", "build a thing", expect.objectContaining({
        onComplete: expect.any(Function),
        onError: expect.any(Function),
      }));
      expect(result).toEqual({ session_id: "s1", task_id: "task-1", status: "running" });
      const entry = getActiveBackgrounds().get("task-1");
      expect(entry?.sessionId).toBe("s1");
      expect(entry?.status).toBe("running");
    });

    it("fails before session creation when the session dispatch is missing", async () => {
      setDelegationDeps(runtime, null as unknown as Parameters<typeof setDelegationDeps>[1]);
      const result = JSON.parse(await spawnSessionTool.execute({ type: "code", goal: "build a thing" }));

      expect(result.error).toContain("Delegation not initialized");
      expect(sessionDispatch.createSubSession).not.toHaveBeenCalled();
      expect(runtime.spawn).not.toHaveBeenCalled();
    });
  });

  describe("terminate_session", () => {
    it("interrupts, pauses the managed session, and preserves the mother ID", async () => {
      const managed = { id: "s1", status: "ready", motherId: "m1" };
      sessionDispatch.getSessionById.mockReturnValue(managed);
      seedBackground();

      const result = JSON.parse(await terminateSessionTool.execute({ task_id: "t1" }));

      expect(runtime.interruptSpawn).toHaveBeenCalledWith("t1");
      expect(sessionDispatch.getSessionById).toHaveBeenCalledWith("s1");
      expect(managed.status).toBe("paused");
      expect(addCompletion).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "s1",
        motherId: "m1",
        status: "terminated",
      }));
      expect(result).toEqual({ task_id: "t1", status: "terminated" });
    });

    it("records an empty mother ID when the managed session is gone", async () => {
      sessionDispatch.getSessionById.mockReturnValue(undefined);
      seedBackground();

      await terminateSessionTool.execute({ task_id: "t1" });

      expect(addCompletion).toHaveBeenCalledWith(expect.objectContaining({ motherId: "" }));
    });

    it("fails before interruption when not initialized", async () => {
      setDelegationDeps(runtime, null as unknown as Parameters<typeof setDelegationDeps>[1]);
      seedBackground();

      const result = JSON.parse(await terminateSessionTool.execute({ task_id: "t1" }));

      expect(result.error).toContain("Delegation not initialized");
      expect(runtime.interruptSpawn).not.toHaveBeenCalled();
      expect(addCompletion).not.toHaveBeenCalled();
    });
  });
});
