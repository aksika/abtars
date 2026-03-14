import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeViaIpc } from "./agentbridge-browser.js";
import type { BrowserAction, BrowserToolResult } from "../types/browser.js";

// ── Helpers ───────────────────────────────────────────────────────────

let counter = 0;
function tmpSocketPath(): string {
  return path.join(os.tmpdir(), `browser-ipc-cli-test-${Date.now()}-${counter++}.sock`);
}

/** Minimal echo server: reads JSON action, responds with success + sessionId as title. */
function startEchoServer(sockPath: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const srv = net.createServer((conn) => {
      let data = "";
      conn.on("data", (chunk) => { data += chunk.toString(); });
      conn.on("end", () => {
        try {
          const action = JSON.parse(data.trim()) as BrowserAction;
          const result: BrowserToolResult = { success: true, title: action.sessionId };
          conn.end(JSON.stringify(result) + "\n");
        } catch {
          conn.end(JSON.stringify({ success: false, error: "bad json" }) + "\n");
        }
      });
    });
    srv.listen(sockPath, () => resolve(srv));
  });
}

function stopServer(srv: net.Server, sockPath: string): Promise<void> {
  return new Promise((resolve) => {
    srv.close(() => {
      try { fs.unlinkSync(sockPath); } catch { /* ok */ }
      resolve();
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("executeViaIpc", () => {
  let srv: net.Server | null = null;
  let sockPath: string;

  afterEach(async () => {
    if (srv) {
      await stopServer(srv, sockPath);
      srv = null;
    }
  });

  it("returns null when socket file does not exist", async () => {
    const action: BrowserAction = { action: "navigate", sessionId: "s1", url: "https://example.com" };
    const result = await executeViaIpc(action, "/tmp/nonexistent-socket-12345.sock");
    expect(result).toBeNull();
  });

  it("sends action and receives result via IPC", async () => {
    sockPath = tmpSocketPath();
    srv = await startEchoServer(sockPath);

    const action: BrowserAction = { action: "extract_text", sessionId: "mySession" };
    const result = await executeViaIpc(action, sockPath);

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.title).toBe("mySession");
  });

  it("returns null when socket exists but server is not running", async () => {
    sockPath = tmpSocketPath();
    // Create a file that looks like a socket but isn't one
    fs.writeFileSync(sockPath, "");

    const action: BrowserAction = { action: "screenshot", sessionId: "default" };
    const result = await executeViaIpc(action, sockPath);

    expect(result).toBeNull();
    fs.unlinkSync(sockPath);
  });

  it("preserves sessionId through the IPC round-trip", async () => {
    sockPath = tmpSocketPath();
    srv = await startEchoServer(sockPath);

    const action: BrowserAction = { action: "close_session", sessionId: "auth-flow-42" };
    const result = await executeViaIpc(action, sockPath);

    expect(result).not.toBeNull();
    expect(result!.title).toBe("auth-flow-42");
  });
});
