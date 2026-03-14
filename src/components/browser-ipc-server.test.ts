import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BrowserIpcServer } from "./browser-ipc-server.js";
import type { BrowserAction, BrowserToolResult } from "../types/browser.js";
import type { BrowserTool } from "./browser-tool.js";

// ── Helpers ───────────────────────────────────────────────────────────

function tmpSocketPath(): string {
  return path.join(os.tmpdir(), `browser-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function makeMockTool(result: BrowserToolResult): BrowserTool {
  return {
    execute: async (_action: BrowserAction) => result,
  } as unknown as BrowserTool;
}

function makeMockToolCapture(): { tool: BrowserTool; captured: () => BrowserAction | undefined } {
  let lastAction: BrowserAction | undefined;
  const tool = {
    execute: async (action: BrowserAction) => {
      lastAction = action;
      return { success: true } as BrowserToolResult;
    },
  } as unknown as BrowserTool;
  return { tool, captured: () => lastAction };
}

/** Send a JSON action to the socket and return the parsed result. */
function sendAction(socketPath: string, action: BrowserAction): Promise<BrowserToolResult> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath, () => {
      conn.end(JSON.stringify(action) + "\n");
    });
    let data = "";
    conn.on("data", (chunk) => { data += chunk.toString(); });
    conn.on("end", () => {
      try { resolve(JSON.parse(data.trim())); } catch (e) { reject(e); }
    });
    conn.on("error", reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("BrowserIpcServer", () => {
  let server: BrowserIpcServer;
  let sockPath: string;

  beforeEach(() => {
    sockPath = tmpSocketPath();
  });

  afterEach(async () => {
    if (server) await server.shutdown();
  });

  it("starts and listens on the socket path", async () => {
    server = new BrowserIpcServer(makeMockTool({ success: true }), sockPath);
    await server.start();

    expect(server.isListening).toBe(true);
    expect(fs.existsSync(sockPath)).toBe(true);
  });

  it("removes socket file on shutdown", async () => {
    server = new BrowserIpcServer(makeMockTool({ success: true }), sockPath);
    await server.start();
    await server.shutdown();

    expect(fs.existsSync(sockPath)).toBe(false);
    expect(server.isListening).toBe(false);
  });

  it("removes stale socket file on start", async () => {
    // Create a stale file
    fs.writeFileSync(sockPath, "stale");
    expect(fs.existsSync(sockPath)).toBe(true);

    server = new BrowserIpcServer(makeMockTool({ success: true }), sockPath);
    await server.start();

    expect(server.isListening).toBe(true);
  });

  it("routes action to BrowserTool and returns result", async () => {
    const expected: BrowserToolResult = { success: true, title: "Test Page", url: "https://example.com", status: 200 };
    server = new BrowserIpcServer(makeMockTool(expected), sockPath);
    await server.start();

    const action: BrowserAction = { action: "navigate", sessionId: "s1", url: "https://example.com" };
    const result = await sendAction(sockPath, action);

    expect(result).toEqual(expected);
  });

  it("passes the correct action to BrowserTool", async () => {
    const { tool, captured } = makeMockToolCapture();
    server = new BrowserIpcServer(tool, sockPath);
    await server.start();

    const action: BrowserAction = { action: "fill", sessionId: "auth", selector: "#email", value: "test@example.com" };
    await sendAction(sockPath, action);

    expect(captured()).toEqual(action);
  });

  it("returns error for malformed JSON", async () => {
    server = new BrowserIpcServer(makeMockTool({ success: true }), sockPath);
    await server.start();

    const result = await new Promise<BrowserToolResult>((resolve, reject) => {
      const conn = net.createConnection(sockPath, () => {
        conn.end("not valid json\n");
      });
      let data = "";
      conn.on("data", (chunk) => { data += chunk.toString(); });
      conn.on("end", () => {
        try { resolve(JSON.parse(data.trim())); } catch (e) { reject(e); }
      });
      conn.on("error", reject);
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("IPC parse/execute error");
  });

  it("handles concurrent connections", async () => {
    let callCount = 0;
    const tool = {
      execute: async (_action: BrowserAction) => {
        callCount++;
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        return { success: true } as BrowserToolResult;
      },
    } as unknown as BrowserTool;

    server = new BrowserIpcServer(tool, sockPath);
    await server.start();

    const action: BrowserAction = { action: "extract_text", sessionId: "default" };
    const results = await Promise.all([
      sendAction(sockPath, action),
      sendAction(sockPath, action),
      sendAction(sockPath, action),
    ]);

    expect(callCount).toBe(3);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("exposes socketPath from constructor", () => {
    server = new BrowserIpcServer(makeMockTool({ success: true }), sockPath);
    expect(server.socketPath).toBe(sockPath);
  });
});
