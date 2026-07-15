import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { SupervisedPiRpcClient } from "./pi-rpc-client.js";

function makeMockChild() {
  const ee = new EventEmitter() as any;
  ee.stdin = new PassThrough() as any;
  vi.spyOn(ee.stdin, "write").mockReturnValue(true);
  ee.stdout = new PassThrough({ readableHighWaterMark: 1024 * 1024 }) as any;
  ee.stderr = new PassThrough() as any;
  ee.pid = 12345;
  ee.kill = vi.fn().mockReturnValue(true);
  ee.killed = false;
  return ee;
}

describe("SupervisedPiRpcClient", () => {
  let client: SupervisedPiRpcClient;
  let child: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    client = new SupervisedPiRpcClient();
    child = makeMockChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });

  afterEach(async () => {
    await client.close().catch(() => {});
  });

  describe("launch", () => {
    it("spawns the configured command with args", async () => {
      await client.launch("/usr/bin/pi", ["--mode", "rpc"], "/ws", { HOME: "/home" });
      expect(spawn).toHaveBeenCalledWith("/usr/bin/pi", ["--mode", "rpc"], {
        cwd: "/ws",
        env: { HOME: "/home" },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    });

    it("throws if already started", async () => {
      await client.launch("/usr/bin/pi", [], "/ws", {});
      await expect(client.launch("/usr/bin/pi", [], "/ws", {})).rejects.toThrow("already running");
    });
  });

  describe("command send/receive", () => {
    beforeEach(async () => {
      await client.launch("/usr/bin/pi", [], "/ws", {});
    });

    it("getState resolves with parsed session state from official RpcResponse", async () => {
      const statePromise = client.getState();
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      child.stdout.write(JSON.stringify({
        type: "response", id: sent.id, command: "get_state", success: true,
        data: { sessionId: "sess-1", isStreaming: false, sessionFile: "/tmp/sess.json" },
      }) + "\n");
      const state = await statePromise;
      expect(state.sessionId).toBe("sess-1");
      expect(state.isStreaming).toBe(false);
      expect(state.sessionFile).toBe("/tmp/sess.json");
    });

    it("send uses official {id,type,...fields} format (no cmd/args)", async () => {
      const promptPromise = client.prompt("Hello");
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      expect(sent.type).toBe("prompt");
      expect(sent.message).toBe("Hello");
      expect(sent.id).toBeDefined();
      expect(sent).not.toHaveProperty("cmd");
      expect(sent).not.toHaveProperty("args");
      child.stdout.write(JSON.stringify({ type: "response", id: sent.id, command: "prompt", success: true }) + "\n");
      await promptPromise;
    });

    it("set_model uses official {type:set_model,provider,modelId}", async () => {
      const smPromise = client.setModel("zai", "z-4.5");
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      expect(sent.type).toBe("set_model");
      expect(sent.provider).toBe("zai");
      expect(sent.modelId).toBe("z-4.5");
      child.stdout.write(JSON.stringify({ type: "response", id: sent.id, command: "set_model", success: true }) + "\n");
      await smPromise;
    });

    it("switch_session uses official {type:switch_session,sessionPath}", async () => {
      const ssPromise = client.switchSession("/tmp/sess.json");
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      expect(sent.type).toBe("switch_session");
      expect(sent.sessionPath).toBe("/tmp/sess.json");
      child.stdout.write(JSON.stringify({
        type: "response", id: sent.id, command: "switch_session", success: true,
        data: { cancelled: false },
      }) + "\n");
      const result = await ssPromise;
      expect(result.cancelled).toBe(false);
    });

    it("rejects on success: false with error text", async () => {
      const gsPromise = client.getState();
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      child.stdout.write(JSON.stringify({
        type: "response", id: sent.id, command: "get_state", success: false,
        error: "Session not found",
      }) + "\n");
      await expect(gsPromise).rejects.toThrow("Session not found");
    });

    it("rejects on command mismatch in response", async () => {
      const gsPromise = client.getState();
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      child.stdout.write(JSON.stringify({ type: "response", id: sent.id, command: "set_model", success: true }) + "\n");
      await expect(gsPromise).rejects.toThrow('Expected response for "get_state" but got "set_model"');
    });

    it("drops unknown response IDs without error", async () => {
      child.stdout.write(JSON.stringify({
        type: "response", id: "nonexistent", command: "get_state", success: true,
        data: { sessionId: "x" },
      }) + "\n");
    });
  });

  describe("event routing", () => {
    beforeEach(async () => {
      await client.launch("/usr/bin/pi", [], "/ws", {});
    });

    it("routes agent_start events to subscribers", async () => {
      const eventSpy = vi.fn();
      client.subscribe(eventSpy);
      child.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
      expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_start" }));
    });

    it("routes tool_execution_start with toolName", async () => {
      const eventSpy = vi.fn();
      client.subscribe(eventSpy);
      child.stdout.write(JSON.stringify({
        type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: {},
      }) + "\n");
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tool_execution_start", toolName: "bash", toolCallId: "tc-1" }),
      );
    });
  });

  describe("extension UI request routing", () => {
    beforeEach(async () => {
      await client.launch("/usr/bin/pi", [], "/ws", {});
    });

    it("routes dialog extension_ui_request to onUiRequest listeners", async () => {
      const uiSpy = vi.fn();
      client.onUiRequest(uiSpy);
      child.stdout.write(JSON.stringify({
        type: "extension_ui_request", id: "ui-1", method: "confirm",
        title: "Confirm?", message: "Proceed?",
      }) + "\n");
      expect(uiSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "extension_ui_request", id: "ui-1", method: "confirm" }),
      );
    });

    it("routes fire-and-forget extension_ui_request (notify) to listeners", async () => {
      const uiSpy = vi.fn();
      client.onUiRequest(uiSpy);
      child.stdout.write(JSON.stringify({
        type: "extension_ui_request", id: "ui-2", method: "notify", message: "Thinking...",
      }) + "\n");
      expect(uiSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "extension_ui_request", id: "ui-2", method: "notify" }),
      );
    });
  });

  describe("respondToUi", () => {
    beforeEach(async () => {
      await client.launch("/usr/bin/pi", [], "/ws", {});
    });

    it("sends official extension_ui_response with value for string input", async () => {
      const result = await client.respondToUi("ui-1", "yes");
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      expect(sent.type).toBe("extension_ui_response");
      expect(sent.id).toBe("ui-1");
      expect(sent.value).toBe("yes");
      expect(result.ok).toBe(true);
      expect(result.delivery).toBe("written_unacknowledged");
    });

    it("sends confirmed for boolean true", async () => {
      const result = await client.respondToUi("ui-1", true);
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      expect(sent.confirmed).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.delivery).toBe("written_unacknowledged");
    });

    it("sends cancelled for null", async () => {
      const result = await client.respondToUi("ui-1", null);
      const writeData = child.stdin.write.mock.calls.find(
        (c: any[]) => typeof c[0] === "string",
      )?.[0] as string;
      const sent = JSON.parse(writeData);
      expect(sent.cancelled).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.delivery).toBe("written_unacknowledged");
    });

    it("returns not_written when client is closed", async () => {
      await client.close();
      const result = await client.respondToUi("ui-1", "no");
      expect(result.ok).toBe(false);
      expect(result.delivery).toBe("not_written");
    });
  });

  describe("malformed/oversized lines", () => {
    beforeEach(async () => {
      await client.launch("/usr/bin/pi", [], "/ws", {});
    });

    it("does not crash on malformed JSON line", async () => {
      child.stdout.write("{invalid json!!!\n");
    });

    it("does not crash on oversized line", async () => {
      child.stdout.write("x".repeat(20 * 1024) + "\n");
    });
  });

  describe("close and cleanup", () => {
    beforeEach(async () => {
      await client.launch("/usr/bin/pi", [], "/ws", {});
    });

    it("rejects pending commands on close", async () => {
      const statePromise = client.getState();
      await client.close();
      await expect(statePromise).rejects.toThrow("closed");
    });

    it("close is idempotent", async () => {
      await client.close();
      await client.close();
    });
  });
});
