import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock SubagentRuntime and SessionManager before importing
vi.mock("../subagent-runtime.js", () => ({ SubagentRuntime: vi.fn() }));
vi.mock("../session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../completion-buffer.js", () => ({
  addCompletion: vi.fn(),
  drainCompletions: vi.fn(() => []),
  hasCompletions: vi.fn(() => false),
}));

const { spawnSessionTool, checkSessionTool, terminateSessionTool, sendToSessionTool, setDelegationDeps, getActiveBackgrounds, consumePendingInstruction } = await import("./delegation-tools.js");

describe("Delegation Tools", () => {
  beforeEach(() => {
    getActiveBackgrounds().clear();
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
      getActiveBackgrounds().set("t3", {
        taskId: "t3", sessionId: "s3", goal: "g", startedAt: Date.now(),
        status: "running", inputTokens: 0, outputTokens: 0,
      });
      expect(consumePendingInstruction("t3")).toBeUndefined();
    });

    it("returns and clears pending instruction", () => {
      getActiveBackgrounds().set("t4", {
        taskId: "t4", sessionId: "s4", goal: "g", startedAt: Date.now(),
        status: "running", inputTokens: 0, outputTokens: 0,
        pendingInstruction: "focus on auth",
      });
      expect(consumePendingInstruction("t4")).toBe("focus on auth");
      expect(consumePendingInstruction("t4")).toBeUndefined();
    });
  });

  describe("check_session", () => {
    it("returns error for unknown task", async () => {
      const result = JSON.parse(await checkSessionTool.execute({ task_id: "nope" }));
      expect(result.error).toContain("No background session");
    });

    it("returns status for known task", async () => {
      getActiveBackgrounds().set("t5", {
        taskId: "t5", sessionId: "s5", goal: "test goal", startedAt: Date.now() - 5000,
        status: "running", inputTokens: 0, outputTokens: 0,
      });
      const result = JSON.parse(await checkSessionTool.execute({ task_id: "t5" }));
      expect(result.status).toBe("running");
      expect(result.goal).toBe("test goal");
      expect(result.elapsed_seconds).toBeGreaterThanOrEqual(4);
    });
  });

  describe("terminate_session", () => {
    it("returns error when not initialized", async () => {
      getActiveBackgrounds().set("t6", {
        taskId: "t6", sessionId: "s6", goal: "g", startedAt: Date.now(),
        status: "done", inputTokens: 0, outputTokens: 0,
      });
      const result = JSON.parse(await terminateSessionTool.execute({ task_id: "t6" }));
      expect(result.error).toContain("not initialized");
    });
  });
});
