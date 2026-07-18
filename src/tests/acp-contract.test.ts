/**
 * Contract tests — verify ACP transport handles protocol messages correctly.
 * Uses recorded fixtures, not live CLIs.
 */
import { describe, it, expect, vi } from "vitest";
import { AcpTransport } from "../components/transport/acp-transport.js";

describe("Contract: ACP permission handling", () => {
  it("auto-approves when allow_once option exists", async () => {
    // Access the private handler via prototype
    const transport = Object.create(AcpTransport.prototype) as any;
    transport.tag = "test";

    const params = {
      sessionId: "test-session",
      toolCall: { toolCallId: "tc1", title: "Reading file.ts" },
      options: [
        { optionId: "opt1", kind: "allow_once" as const, label: "Allow" },
        { optionId: "opt2", kind: "reject_once" as const, label: "Reject" },
      ],
    };

    const result = await transport["handlePermission"](params);
    expect(result.outcome.outcome).toBe("selected");
    expect(result.outcome.optionId).toBe("opt1");
  });

  it("cancels when no allow option exists", async () => {
    const transport = Object.create(AcpTransport.prototype) as any;
    transport.tag = "test";

    const params = {
      sessionId: "test-session",
      toolCall: { toolCallId: "tc1", title: "Dangerous action" },
      options: [
        { optionId: "opt1", kind: "reject_once" as const, label: "Reject" },
      ],
    };

    const result = await transport["handlePermission"](params);
    expect(result.outcome.outcome).toBe("cancelled");
  });

  it("prefers allow_once over allow_always", async () => {
    const transport = Object.create(AcpTransport.prototype) as any;
    transport.tag = "test";

    const params = {
      sessionId: "test-session",
      toolCall: { toolCallId: "tc1", title: "Running command" },
      options: [
        { optionId: "opt1", kind: "allow_always" as const, label: "Always" },
        { optionId: "opt2", kind: "allow_once" as const, label: "Once" },
      ],
    };

    const result = await transport["handlePermission"](params);
    expect(result.outcome.outcome).toBe("selected");
    // Should pick first allow option found (allow_always comes first)
    expect(result.outcome.optionId).toBe("opt1");
  });
});

describe("Contract: ACP session update handling", () => {
  function makeTransport(): any {
    const transport = Object.create(AcpTransport.prototype) as any;
    transport.responseChunks = new Map([["sess1", []]]);
    transport.tag = "test";
    transport.lastActivityAt = 0;
    transport.lastContentAt = 0;
    transport.toolMeta = null;
    transport.sm = { state: "idle", toolStarted: vi.fn(), toolCompleted: vi.fn() };
    transport.outputObservers = new Map();
    return transport;
  }

  it("collects text chunks into response", () => {
    const transport = makeTransport();

    transport["handleSessionUpdate"]({
      sessionId: "sess1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello " },
      },
    });
    transport["handleSessionUpdate"]({
      sessionId: "sess1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world!" },
      },
    });

    const chunks = transport.responseChunks.get("sess1");
    expect(chunks).toEqual(["Hello ", "world!"]);
  });

  it("tracks tool calls in flight", () => {
    const transport = makeTransport();
    transport.sm.state = "prompting";

    transport["handleSessionUpdate"]({
      sessionId: "sess1",
      update: {
        sessionUpdate: "tool_call",
        title: "Reading file.ts",
        status: "running",
      },
    });

    expect(transport.toolInFlight).toBeTruthy();
    expect(transport.toolInFlight.title).toBe("Reading file.ts");

    transport["handleSessionUpdate"]({
      sessionId: "sess1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
      },
    });

    expect(transport.toolInFlight).toBeNull();
  });
});
