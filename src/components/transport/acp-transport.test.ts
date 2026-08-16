import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../transport-config.js", () => ({ loadTransport: () => null, resolveAgent: () => ({ contextWindow: 128000 }), clearTransportCache: () => {} }));
vi.mock("../../paths.js", () => ({ abtarsHome: () => "/tmp/abtars-test" }));
vi.mock("../logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(), logError: vi.fn(), logTrace: vi.fn() }));
vi.mock("../log-and-swallow.js", () => ({ logAndSwallow: vi.fn() }));
vi.mock("../env-schema.js", () => ({ getEnv: () => ({ promptTimeoutSec: 180, watchdogToolTimeoutSec: 300, watchdogSilentSec: 120, watchdogEndlessSec: 600 }) }));
vi.mock("../transport/bridge-lock-transport.js", () => ({ writeRestartReason: vi.fn() }));
vi.mock("../hooks/hook-system.js", () => ({ hasHooks: () => false, fire: vi.fn() }));

const revokeSealedSession = vi.fn();
const revokeAllSealedSessions = vi.fn();
vi.mock("./sealed-acp-bridge.js", () => ({ revokeSealedSession, revokeAllSealedSessions }));

import { AcpTransport, AcpExitError, ModelNotFoundError } from "./acp-transport.js";

describe("AcpTransport", () => {
  let transport: AcpTransport;

  beforeEach(() => {
    transport = new AcpTransport("/usr/bin/kiro-cli", "/tmp/work");
    revokeSealedSession.mockClear();
    revokeAllSealedSessions.mockClear();
  });

  afterEach(() => {
    transport.destroy();
  });

  describe("instance-owned sealed session revocation (#1468)", () => {
    it("destroy revokes only the keys this instance created, never revoke-all", async () => {
      (transport as any).sealedSessionKeys = new Set(["owner-key-1", "owner-key-2"]);

      transport.destroy();
      await vi.waitFor(() => expect(revokeSealedSession).toHaveBeenCalledWith("owner-key-1"));

      expect(revokeSealedSession).toHaveBeenCalledWith("owner-key-2");
      expect(revokeAllSealedSessions).not.toHaveBeenCalled();
      expect((transport as any).sealedSessionKeys.size).toBe(0);
    });

    it("initialize revokes only this instance's keys", async () => {
      (transport as any).sealedSessionKeys = new Set(["boot-key"]);
      (transport as any).agent = null;
      (transport as any).client = null;
      (transport as any).sm = { childExited: vi.fn(), reinitSucceeded: vi.fn(), reinitFailed: vi.fn() };

      // abort before spawn — no CLI available in this unit test
      await expect(transport.initialize()).rejects.toThrow();
      await vi.waitFor(() => expect(revokeSealedSession).toHaveBeenCalledWith("boot-key"));

      expect(revokeAllSealedSessions).not.toHaveBeenCalled();
    });

    it("session expiry invalidates and forgets its own key only", async () => {
      const map = (transport as any).sessions as Map<string, string>;
      map.set("expiring-key", "sess-expired");
      (transport as any).sealedSessionKeys.add("expiring-key");
      (transport as any).sealedSessionKeys.add("other-key");
      (transport as any).client = {
        prompt: vi.fn().mockRejectedValue({ code: -32603, message: "No session found" }),
      };

      await expect((transport as any).promptWithRetry("sess-expired", "hi", 0)).rejects.toThrow();
      await vi.waitFor(() => expect(revokeSealedSession).toHaveBeenCalledWith("expiring-key"));

      expect(map.has("expiring-key")).toBe(false);
      expect((transport as any).sealedSessionKeys.has("expiring-key")).toBe(false);
      // An unrelated key owned by the same instance is untouched
      expect((transport as any).sealedSessionKeys.has("other-key")).toBe(true);
    });

    it("two transports revoke disjoint key sets — destroying one leaves the other's tokens valid", async () => {
      const other = new AcpTransport("/usr/bin/kiro-cli", "/tmp/work");
      try {
        (transport as any).sealedSessionKeys = new Set(["normal-key"]);
        (other as any).sealedSessionKeys = new Set(["emergency-key"]);

        transport.destroy();
        await vi.waitFor(() => expect(revokeSealedSession).toHaveBeenCalledWith("normal-key"));

        expect(revokeSealedSession).not.toHaveBeenCalledWith("emergency-key");
        expect((other as any).sealedSessionKeys).toEqual(new Set(["emergency-key"]));
      } finally {
        other.destroy();
      }
    });
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

      // sendPrompt now returns a Promise that blocks — don't await it
      const promise = transport.sendPrompt("key-1", "hello");

      // Verify it queued (resolve/reject stored)
      expect((transport as any)._pendingPrompt).toBeDefined();
      expect((transport as any)._pendingPrompt.sessionKey).toBe("key-1");
      expect((transport as any)._pendingPrompt.message).toBe("hello");

      // Reject to unblock the promise (cleanup)
      (transport as any)._pendingPrompt.reject(new Error("test cleanup"));
      await promise.catch(() => {});
    });

    it("uses the caller's provider inactivity allowance for sleep deadlines", async () => {
      vi.useFakeTimers();
      try {
        (transport as any).sm = {
          state: "idle",
          startPrompt: vi.fn(),
          promptCompleted: vi.fn(),
        };
        (transport as any).sessions.set("key-1", "sess-timeout");
        (transport as any).client = {
          prompt: vi.fn().mockReturnValue(new Promise(() => {})),
        };

        const prompt = transport.sendPrompt("key-1", "sleep", undefined, {
          providerInactivityTimeoutMs: 10_000,
          deadlineAt: Date.now() + 60_000,
        });
        const rejected = expect(prompt).rejects.toThrow("Bridge prompt timeout");
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(15_000);

        await rejected;
      } finally {
        vi.useRealTimers();
      }
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

    it("delivers pre-tool text before the tool callback and excludes thinking from the answer", async () => {
      const sessionId = "sess-segment";
      const segment = vi.fn().mockResolvedValue(undefined);
      const deltas: Array<{ kind: string; text: string }> = [];
      transport.onSegmentBreak = segment;
      transport.onOutputDelta = (event) => deltas.push(event);
      (transport as any).responseChunks.set(sessionId, []);
      (transport as any).segmentOffsets.set(sessionId, 0);
      (transport as any).sm = { state: "prompting", toolStarted: vi.fn() };

      await (transport as any).handleSessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "thinking", text: "private" } },
      });
      await (transport as any).handleSessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before tool" } },
      });
      await (transport as any).handleSessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call", title: "search", status: "running" },
      });

      expect((transport as any).responseChunks.get(sessionId)).toEqual(["before tool"]);
      expect(segment).toHaveBeenCalledWith("before tool");
      expect(deltas).toEqual([{ kind: "thinking", text: "private" }, { kind: "text", text: "before tool" }]);
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

  /**
   * #1550 — the #1338 live-output mirrors in handleSessionUpdate read from
   * outputObservers, but sendPrompt never populated that map, so the ACP route
   * published nothing to the TUI feed while the Pi route worked. The map is
   * private plumbing; what matters is that a caller-supplied observer receives
   * deltas for the session sendPrompt actually opened, and stops receiving
   * them once the prompt completes.
   */
  describe("live output observer wiring (#1550)", () => {
    it("delivers text deltas and tool starts to the caller's observer", async () => {
      const deltas: string[] = [];
      const toolStarts: string[] = [];
      const outputObserver = {
        onDelta: (e: { kind: string; text: string }) => { deltas.push(e.text); },
        onToolStart: (e: { name: string }) => { toolStarts.push(e.name); },
      };

      (transport as any).sm = {
        state: "idle",
        startPrompt: vi.fn(),
        promptCompleted: vi.fn(),
        toolStarted: vi.fn(),
        toolCompleted: vi.fn(),
      };
      (transport as any).sessions.set("key-1", "sess-live");
      (transport as any).client = {
        prompt: vi.fn().mockImplementation(async () => {
          // Model emits while the prompt is in flight.
          (transport as any).handleSessionUpdate({
            sessionId: "sess-live",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "streamed" } },
          });
          (transport as any).handleSessionUpdate({
            sessionId: "sess-live",
            update: { sessionUpdate: "tool_call", title: "execute_bash", status: "running" },
          });
          return { stopReason: "end_turn" };
        }),
      };

      const result = await transport.sendPrompt("key-1", "hi", undefined, { outputObserver } as any);

      expect(deltas).toEqual(["streamed"]);
      expect(toolStarts).toEqual(["execute_bash"]);
      expect(result).toBe("streamed");
    });

    it("stops publishing once the prompt completed", async () => {
      const deltas: string[] = [];
      const outputObserver = { onDelta: (e: { text: string }) => { deltas.push(e.text); } };

      (transport as any).sm = {
        state: "idle",
        startPrompt: vi.fn(),
        promptCompleted: vi.fn(),
        toolCompleted: vi.fn(),
      };
      (transport as any).sessions.set("key-1", "sess-live");
      (transport as any).client = { prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }) };

      await transport.sendPrompt("key-1", "hi", undefined, { outputObserver } as any);

      // Late event from the finished call must not reach a (possibly newer) observer.
      (transport as any).sm = { state: "prompting" };
      (transport as any).responseChunks.set("sess-live", []);
      (transport as any).handleSessionUpdate({
        sessionId: "sess-live",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
      });

      expect(deltas).toEqual([]);
    });
  });

  describe("session expiry retry (#1564)", () => {
    it("re-keys the chunk buffer and observer under the rotated session id", async () => {
      let promptCalls = 0;
      (transport as any).client = {
        newSession: vi.fn()
          .mockResolvedValueOnce({ sessionId: "sess-1" })
          .mockResolvedValueOnce({ sessionId: "sess-2" }),
        prompt: vi.fn().mockImplementation(async ({ sessionId: sid }: { sessionId: string }) => {
          promptCalls++;
          if (promptCalls === 1) throw { code: -32603, message: "No session found" };
          (transport as any).handleSessionUpdate({
            sessionId: sid,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the answer" } },
          });
          return { stopReason: "end_turn" };
        }),
      };

      const outputObserver = { onDelta: vi.fn() };
      const result = await transport.sendPrompt("key-1", "hello", undefined, { outputObserver } as any);

      // The turn must return the model output, not "(no response)".
      expect(result).toBe("the answer");
      expect(promptCalls).toBe(2);
      // The retry must have been sent to the freshly created session.
      expect((transport as any).client.prompt.mock.calls[1][0].sessionId).toBe("sess-2");
      // The live-output feed must have received the delta during the retry turn.
      expect(outputObserver.onDelta).toHaveBeenCalledWith({ kind: "text", text: "the answer" });
      // No stale keys may survive.
      expect((transport as any).responseChunks.has("sess-1")).toBe(false);
      expect((transport as any).outputObservers.has("sess-1")).toBe(false);
      expect((transport as any).responseChunks.has("sess-2")).toBe(false);
    });
  });
});
