import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { BrowserAction, BrowserToolResult } from "../types/browser.js";
import type { BrowserTool } from "./browser-tool.js";

const LOG_PREFIX = "[browser-ipc]";

/** Default socket path: ~/.agentbridge/browser.sock */
export function getDefaultSocketPath(): string {
  return path.join(os.homedir(), ".agentbridge", "browser.sock");
}

/**
 * Unix domain socket server that routes BrowserAction requests
 * to a BrowserTool instance, enabling session persistence across
 * CLI invocations.
 *
 * Protocol: client connects → sends one JSON line → receives one JSON line → connection closes.
 */
export class BrowserIpcServer {
  private _server: net.Server | null = null;
  private readonly _tool: BrowserTool;
  private readonly _socketPath: string;

  constructor(tool: BrowserTool, socketPath?: string) {
    this._tool = tool;
    this._socketPath = socketPath ?? getDefaultSocketPath();
  }

  get socketPath(): string {
    return this._socketPath;
  }

  get isListening(): boolean {
    return this._server?.listening ?? false;
  }

  /** Start listening. Removes stale socket file if present. */
  async start(): Promise<void> {
    // Ensure parent directory exists.
    const dir = path.dirname(this._socketPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Remove stale socket file from a previous run.
    this._removeSocketFile();

    return new Promise<void>((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: true }, (conn) => {
        this._handleConnection(conn);
      });

      server.on("error", (err) => {
        console.error(`${LOG_PREFIX} Server error: ${err.message}`);
        reject(err);
      });

      server.listen(this._socketPath, () => {
        this._server = server;
        console.log(`${LOG_PREFIX} Listening on ${this._socketPath}`);
        resolve();
      });
    });
  }

  /** Stop the server and remove the socket file. */
  async shutdown(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this._server) {
        this._removeSocketFile();
        resolve();
        return;
      }

      this._server.close(() => {
        this._server = null;
        this._removeSocketFile();
        console.log(`${LOG_PREFIX} Shut down`);
        resolve();
      });
    });
  }

  // ── Connection handler ──────────────────────────────────────────────

  private _handleConnection(conn: net.Socket): void {
    let data = "";

    conn.on("data", (chunk) => {
      data += chunk.toString();
    });

    conn.on("end", () => {
      void this._processRequest(data, conn);
    });

    conn.on("error", (err) => {
      console.error(`${LOG_PREFIX} Connection error: ${err.message}`);
    });
  }

  private async _processRequest(
    raw: string,
    conn: net.Socket,
  ): Promise<void> {
    let result: BrowserToolResult;

    try {
      const action = JSON.parse(raw.trim()) as BrowserAction;
      result = await this._tool.execute(action);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { success: false, error: `IPC parse/execute error: ${message}` };
    }

    conn.end(JSON.stringify(result) + "\n");
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private _removeSocketFile(): void {
    try {
      if (fs.existsSync(this._socketPath)) {
        fs.unlinkSync(this._socketPath);
      }
    } catch {
      // Best-effort removal.
    }
  }
}
