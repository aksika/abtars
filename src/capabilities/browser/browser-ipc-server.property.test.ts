import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { BrowserIpcServer } from "./browser-ipc-server.js";
import type { BrowserAction, BrowserActionType, BrowserToolResult } from "../../types/browser.js";
import type { BrowserTool } from "./browser-tool.js";

// ── Helpers ───────────────────────────────────────────────────────────

let counter = 0;
function tmpSocketPath(): string {
  return path.join(os.tmpdir(), `browser-ipc-prop-${Date.now()}-${counter++}.sock`);
}

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

const ACTION_TYPES: BrowserActionType[] = [
  "navigate", "click", "fill", "extract_text", "screenshot", "get_page_info", "close_session",
];

const arbAlphaNum = fc.stringMatching(/^[a-zA-Z0-9]+$/).filter((s) => s.length > 0);

const arbAction: fc.Arbitrary<BrowserAction> = fc.record({
  action: fc.constantFrom(...ACTION_TYPES),
  sessionId: arbAlphaNum,
  url: fc.option(fc.webUrl(), { nil: undefined }),
  selector: fc.option(arbAlphaNum, { nil: undefined }),
  value: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: undefined }),
  fullPage: fc.option(fc.boolean(), { nil: undefined }),
});

// ── Property Tests ────────────────────────────────────────────────────

describe("BrowserIpcServer — Property Tests", () => {
  let server: BrowserIpcServer;

  afterEach(async () => {
    if (server) await server.shutdown();
  });

  it("Property: any BrowserAction round-trips through IPC and returns a valid result", async () => {
    const sockPath = tmpSocketPath();
    const echoTool = {
      execute: async (action: BrowserAction) => ({
        success: true,
        title: action.sessionId,
        url: action.url,
      } as BrowserToolResult),
    } as unknown as BrowserTool;

    server = new BrowserIpcServer(echoTool, sockPath);
    await server.start();

    await fc.assert(
      fc.asyncProperty(arbAction, async (action) => {
        const result = await sendAction(sockPath, action);
        expect(result.success).toBe(true);
        expect(result.title).toBe(action.sessionId);
        if (action.url !== undefined) {
          expect(result.url).toBe(action.url);
        }
      }),
      { numRuns: 20 },
    );
  });

  it("Property: tool errors are returned as success=false, never crash the server", async () => {
    const sockPath = tmpSocketPath();
    const failTool = {
      execute: async () => { throw new Error("boom"); },
    } as unknown as BrowserTool;

    server = new BrowserIpcServer(failTool, sockPath);
    await server.start();

    await fc.assert(
      fc.asyncProperty(arbAction, async (action) => {
        const result = await sendAction(sockPath, action);
        expect(result.success).toBe(false);
        expect(result.error).toContain("IPC parse/execute error");
        // Server should still be alive
        expect(server.isListening).toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  it("Property: sessionId is preserved through the IPC boundary", async () => {
    const sockPath = tmpSocketPath();
    const captureTool = {
      execute: async (action: BrowserAction) => ({
        success: true,
        title: action.sessionId,
      } as BrowserToolResult),
    } as unknown as BrowserTool;

    server = new BrowserIpcServer(captureTool, sockPath);
    await server.start();

    await fc.assert(
      fc.asyncProperty(
        arbAlphaNum,
        async (sessionId) => {
          const action: BrowserAction = { action: "extract_text", sessionId };
          const result = await sendAction(sockPath, action);
          expect(result.title).toBe(sessionId);
        },
      ),
      { numRuns: 20 },
    );
  });
});
