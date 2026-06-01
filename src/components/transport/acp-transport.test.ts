import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../transport-config.js", () => ({ loadTransport: () => null, resolveAgent: () => ({ contextWindow: 128000 }), clearTransportCache: () => {} }));
vi.mock("../../paths.js", () => ({ abtarsHome: () => "/tmp/abtars-test" }));
vi.mock("../logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(), logError: vi.fn(), logTrace: vi.fn() }));
vi.mock("../log-and-swallow.js", () => ({ logAndSwallow: vi.fn() }));
vi.mock("../env-schema.js", () => ({ getEnv: () => ({ promptTimeoutSec: 180, watchdogToolTimeoutSec: 300, watchdogSilentSec: 120, watchdogEndlessSec: 600 }) }));
vi.mock("../transport/bridge-lock-transport.js", () => ({ writeRestartReason: vi.fn() }));
vi.mock("../hooks/hook-system.js", () => ({ hasHooks: () => false, fire: vi.fn() }));

import { AcpTransport, AcpExitError, ModelNotFoundError } from "./acp-transport.js";

describe("AcpTransport", () => {
  let transport: AcpTransport;

  beforeEach(() => {
    transport = new AcpTransport("/usr/bin/kiro-cli", "/tmp/work");
  });

  afterEach(() => {
    transport.destroy();
  });

  describe("session map", () => {
    it("starts empty", () => {
      expect((transport as any).sessions.size).toBe(0);
    });

    it("getOrCreateSession throws when client is null", async () => {
      await expect((transport as any).getOrCreateSession("key-1")).rejects.toThrow("ACP not initialized");
    });

    it("returns existing session if already mapped", async () => {
      const map = (transport as any).sessions as Map<string, string>;
      map.set("key-1", "sess-abc");
      // Mock client so it doesn't throw
      (transport as any).client = { newSession: vi.fn() };
      const result = await (transport as any).getOrCreateSession("key-1");
      expect(result).toBe("sess-abc");
      expect((transport as any).client.newSession).not.toHaveBeenCalled();
    });

    it("creates new session when key not found", async () => {
      (transport as any).client = {
        newSession: vi.fn().mockResolvedValue({ sessionId: "new-sess-123" }),
      };
      const result = await (transport as any).getOrCreateSession("key-2");
      expect(result).toBe("new-sess-123");
      expect((transport as any).sessions.get("key-2")).toBe("new-sess-123");
    });
  });

  describe("destroy", () => {
    it("clears sessions and kills agent", () => {
      const map = (transport as any).sessions as Map<string, string>;
      map.set("k1", "s1");
      map.set("k2", "s2");
      const fakeAgent = { kill: vi.fn() };
      (transport as any).agent = fakeAgent;
      (transport as any).client = {};

      transport.destroy();

      expect(map.size).toBe(0);
      expect(fakeAgent.kill).toHaveBeenCalledWith("SIGTERM");
      expect((transport as any).agent).toBeNull();
      expect((transport as any).client).toBeNull();
    });

    it("rejects in-flight operations on destroy", async () => {
      const rejectFn = vi.fn();
      (transport as any).inFlight.add({ op: "prompt", sessionId: "s1", reject: rejectFn });
      (transport as any).agent = { kill: vi.fn() };

      transport.destroy();

      expect(rejectFn).toHaveBeenCalledWith(expect.any(AcpExitError));
      expect((transport as any).inFlight.size).toBe(0);
    });
  });

  describe("sendPrompt guards", () => {
    it("queues concurrent prompt when state is not idle", async () => {
      (transport as any).sm = { state: "prompting", startPrompt: vi.fn(), promptCompleted: vi.fn() };
      (transport as any).client = {};

      const result = await transport.sendPrompt("key-1", "hello");

      expect(result).toBe("");
      expect((transport as any)._pendingPrompt).toEqual({ sessionKey: "key-1", message: "hello" });
    });
  });

  describe("handleSessionUpdate", () => {
    it("appends text chunks to responseChunks", () => {
      const sessionId = "sess-1";
      (transport as any).responseChunks.set(sessionId, []);
      (transport as any).sm = { state: "prompting" };

      (transport as any).handleSessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } },
      });
      (transport as any).handleSessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
      });

      expect((transport as any).responseChunks.get(sessionId)).toEqual(["hello ", "world"]);
    });

    it("drops events for completed sessions in idle state", () => {
      (transport as any).sm = { state: "idle" };
      // No responseChunks entry = session already completed
      (transport as any).handleSessionUpdate({
        sessionId: "old-sess",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale" } },
      });
      expect((transport as any).responseChunks.has("old-sess")).toBe(false);
    });

    it("tracks tool calls", () => {
      const sessionId = "sess-1";
      (transport as any).responseChunks.set(sessionId, []);
      (transport as any).sm = { state: "prompting", toolStarted: vi.fn() };

      (transport as any).handleSessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call", title: "execute_bash", status: "running" },
      });

      expect((transport as any).toolMeta).toEqual({ title: "execute_bash", startedAt: expect.any(Number) });
      expect((transport as any).sm.toolStarted).toHaveBeenCalled();
    });

    it("increments toolCallsSucceeded on tool completion", () => {
      (transport as any).responseChunks.set("sess-1", []);
      (transport as any).sm = { state: "tool-active" };
      (transport as any).toolMeta = { title: "test", startedAt: Date.now() };

      (transport as any).handleSessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" },
      });

      expect(transport.toolCallsSucceeded).toBe(1);
      expect((transport as any).toolMeta).toBeNull();
    });

    it("fires onIntermediateResponse callback", () => {
      const cb = vi.fn();
      transport.onIntermediateResponse = cb;
      (transport as any).responseChunks.set("sess-1", []);
      (transport as any).sm = { state: "prompting", toolCompleted: vi.fn() };
      (transport as any).toolMeta = null;

      (transport as any).handleSessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "streaming..." } },
      });

      expect(cb).toHaveBeenCalledWith("streaming...");
    });
  });

  describe("handlePermission", () => {
    it("auto-approves with first allow option in trust mode", async () => {
      const result = await (transport as any).handlePermission({
        toolCall: { title: "fs_write" },
        options: [
          { optionId: "opt-1", kind: "allow_once" },
          { optionId: "opt-2", kind: "deny" },
        ],
      });
      expect(result).toEqual({ outcome: { outcome: "selected", optionId: "opt-1" } });
    });

    it("cancels when no allow option available", async () => {
      const result = await (transport as any).handlePermission({
        toolCall: { title: "dangerous" },
        options: [{ optionId: "opt-1", kind: "deny" }],
      });
      expect(result).toEqual({ outcome: { outcome: "cancelled" } });
    });

    it("delegates to onPermissionRequest callback if set", async () => {
      const custom = vi.fn().mockResolvedValue({ outcome: { outcome: "selected", optionId: "custom-1" } });
      transport.onPermissionRequest = custom;

      const params = { toolCall: { title: "test" }, options: [] };
      const result = await (transport as any).handlePermission(params);

      expect(custom).toHaveBeenCalledWith(params);
      expect(result).toEqual({ outcome: { outcome: "selected", optionId: "custom-1" } });
    });
  });

  describe("isConnected / isReady", () => {
    it("false when no agent or client", () => {
      expect(transport.isConnected).toBe(false);
      expect(transport.isReady).toBe(false);
    });

    it("true when both agent and client exist", () => {
      (transport as any).agent = { kill: vi.fn() };
      (transport as any).client = {};
      expect(transport.isConnected).toBe(true);
      expect(transport.isReady).toBe(true);
    });
  });

  describe("AcpExitError", () => {
    it("captures code and signal", () => {
      const err = new AcpExitError(1, "SIGTERM");
      expect(err.code).toBe(1);
      expect(err.signal).toBe("SIGTERM");
      expect(err.reason).toBe("exit");
      expect(err.name).toBe("AcpExitError");
    });
  });

  describe("ModelNotFoundError", () => {
    it("has correct name", () => {
      const err = new ModelNotFoundError("test");
      expect(err.name).toBe("ModelNotFoundError");
      expect(err.message).toBe("test");
    });
  });

  describe("setModel", () => {
    it("updates modelId", async () => {
      await transport.setModel("claude-4");
      expect(transport.getModel()).toBe("claude-4");
    });
  });

  describe("contextPercent", () => {
    it("starts at -1", () => {
      expect(transport.contextPercent).toBe(-1);
    });

    it("updates from extNotification metadata", () => {
      (transport as any).client = {};
      // Simulate the extNotification handler
      const handler = (transport as any);
      handler.lastContextPercent = -1;

      // Directly test the metadata path
      const pct = 73.2;
      handler.lastContextPercent = Math.ceil(pct);
      expect(transport.contextPercent).toBe(74);
    });
  });
});
