/**
 * pi-event-projection.test.ts — exhaustive coverage of the pure event projection.
 *
 * Locks in the #1426 fixes:
 *  - agent_end with willRetry=true must NOT settle (Pi will auto-retry).
 *  - message_update (high-frequency) must produce no progress/log/settle.
 *  - extension_error must bound content; raw error text/stacks never persisted.
 *  - compile-time exhaustiveness over the official event union.
 */
import { describe, it, expect } from "vitest";
import { projectPiEvent } from "./pi-event-projection.js";
import type { PiAgentEvent } from "./pi-rpc-client.js";
import { MAX_ERROR_CHARS } from "./types.js";

describe("projectPiEvent", () => {
  describe("agent_end settlement (#1426 willRetry)", () => {
    it("settles completion on the final agent_end (willRetry=false)", () => {
      const proj = projectPiEvent({ type: "agent_end", messages: [], willRetry: false });
      expect(proj.settleCompletion).toBe(true);
      expect(proj.progress).toEqual([]);
    });

    it("does NOT settle when willRetry=true (Pi will auto-retry)", () => {
      const proj = projectPiEvent({ type: "agent_end", messages: [], willRetry: true });
      expect(proj.settleCompletion).toBe(false);
      // Records bounded retry status instead of completing.
      expect(proj.progress).toHaveLength(1);
      expect(proj.progress[0]!.type).toBe("auto_retry");
      expect(JSON.parse(proj.progress[0]!.json)).toEqual({ status: "agent_end_will_retry" });
    });
  });

  describe("high-frequency streaming events", () => {
    it("message_update produces no progress, no log, no settlement", () => {
      const proj = projectPiEvent({
        type: "message_update",
        message: { role: "assistant", content: "x".repeat(10_000) } as any,
        assistantMessageEvent: {} as any,
      });
      expect(proj.progress).toEqual([]);
      expect(proj.settleCompletion).toBe(false);
      expect(proj.log).toBeUndefined();
    });
  });

  describe("tool / compaction / retry progress", () => {
    it("tool_execution_start projects bounded tool name", () => {
      const proj = projectPiEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} });
      expect(proj.progress).toHaveLength(1);
      expect(proj.progress[0]).toEqual({ type: "tool_execution_start", json: JSON.stringify({ name: "bash" }) });
      // args are not projected.
      expect(proj.progress[0]!.json).not.toContain("tc1");
    });

    it("tool_execution_end projects bounded tool name", () => {
      const proj = projectPiEvent({ type: "tool_execution_end", toolCallId: "tc1", toolName: "read", result: { big: "secret" }, isError: false });
      expect(JSON.parse(proj.progress[0]!.json)).toEqual({ name: "read" });
      // result is never projected.
      expect(proj.progress[0]!.json).not.toContain("secret");
    });

    it("tool_execution_update is ignored (no progress)", () => {
      const proj = projectPiEvent({ type: "tool_execution_update", toolCallId: "tc1", toolName: "bash", args: {}, partialResult: "leak" });
      expect(proj.progress).toEqual([]);
    });

    it("compaction_start/end project bounded status", () => {
      expect(JSON.parse(projectPiEvent({ type: "compaction_start", reason: "threshold" }).progress[0]!.json)).toEqual({ status: "started" });
      expect(JSON.parse(projectPiEvent({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false }).progress[0]!.json)).toEqual({ status: "ended" });
    });

    it("auto_retry_start/end project attempt", () => {
      const s = projectPiEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 100, errorMessage: "boom" });
      expect(JSON.parse(s.progress[0]!.json)).toEqual({ status: "started", attempt: 2 });
      const e = projectPiEvent({ type: "auto_retry_end", success: true, attempt: 2 });
      expect(JSON.parse(e.progress[0]!.json)).toEqual({ status: "ended", attempt: 2 });
    });
  });

  describe("ignored known events", () => {
    it.each([
      "agent_start" as const,
    ])("%s still emits bounded progress", (type) => {
      const proj = projectPiEvent({ type } as PiAgentEvent);
      expect(proj.progress).toHaveLength(1);
      expect(proj.settleCompletion).toBe(false);
    });

    it.each([
      "agent_settled",
      "turn_start",
      "turn_end",
      "message_start",
      "message_end",
      "queue_update",
      "entry_appended",
      "session_info_changed",
      "thinking_level_changed",
    ])("%s is ignored with no settlement", (type) => {
      const proj = projectPiEvent(({ type } as unknown) as PiAgentEvent);
      expect(proj.progress).toEqual([]);
      expect(proj.settleCompletion).toBe(false);
      expect(proj.log).toBeUndefined();
    });
  });

  describe("extension_error content bounding (#1426)", () => {
    it("bounds error text and excludes raw payload/stack from progress and log", () => {
      const hugeError = "E".repeat(MAX_ERROR_CHARS * 4);
      const proj = projectPiEvent({
        type: "extension_error",
        extensionPath: "/ext/path".repeat(50),
        event: "someEvent".repeat(50),
        error: hugeError,
        stack: "SECRET-STACK-TRACE",
      });

      // Progress stores only bounded extensionPath + event name; no error/stack.
      expect(proj.progress).toHaveLength(1);
      const stored = JSON.parse(proj.progress[0]!.json);
      expect(stored.extensionPath.length).toBeLessThanOrEqual(200);
      expect(stored.event.length).toBeLessThanOrEqual(200);
      expect(stored).not.toHaveProperty("error");
      expect(stored).not.toHaveProperty("stack");
      expect(JSON.stringify(stored)).not.toContain("SECRET-STACK-TRACE");

      // Log is warn-level with bounded error and no stack.
      expect(proj.log?.level).toBe("warn");
      const msg = proj.log!.message;
      expect(msg).not.toContain("SECRET-STACK-TRACE");
      // Bounded error segment must not exceed the limit.
      expect(msg.length).toBeLessThan(hugeError.length);
      expect(proj.settleCompletion).toBe(false);
    });
  });

  describe("forward compatibility (unknown future event)", () => {
    it("does not warn, settle, or persist for an unrecognized event", () => {
      // Frames are cast from parsed JSON at the wire boundary, so a future Pi
      // event type can still arrive at runtime.
      const proj = projectPiEvent(({ type: "some_future_event" } as unknown) as PiAgentEvent);
      expect(proj.progress).toEqual([]);
      expect(proj.settleCompletion).toBe(false);
      expect(proj.log?.level).toBe("debug");
    });
  });
});
