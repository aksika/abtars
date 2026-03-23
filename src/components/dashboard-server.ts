/**
 * Dashboard HTTP server with WebSocket support via the `ws` library.
 * Routes requests to controllers, serves the inline HTML dashboard,
 * and manages WebSocket connections for real-time status push.
 *
 * Uses `ws` with noServer mode (same pattern as openclaw canvas-host).
 */

import * as http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import type { DashboardConfig, StatusSnapshot } from "./dashboard-config.js";
import { AuthGate } from "./auth-gate.js";
import { StatusBroadcaster } from "./status-broadcaster.js";
import type { PlatformController } from "./platform-controller.js";
import type { TransportController } from "./transport-controller.js";
import type { MemorySearchController } from "./memory-search-controller.js";
import { logInfo, logError } from "./logger.js";

// ── Constants ───────────────────────────────────────────────────────────────

const TAG = "dashboard-server";
const LOG_FILE = resolve(homedir(), ".agentbridge", "logs", "bridge.log");
const CRON_FILE = resolve(homedir(), ".agentbridge", "memory", "cron.json");

// ── Types ───────────────────────────────────────────────────────────────────

export type DashboardServerDeps = {
  config: DashboardConfig;
  authGate: AuthGate;
  getStatus: () => StatusSnapshot;
  platformController: PlatformController;
  transportController: TransportController;
  memorySearchController: MemorySearchController | null;
  dashboardHtml: string;
};

// ── DashboardServer ─────────────────────────────────────────────────────────

export class DashboardServer {
  private readonly deps: DashboardServerDeps;
  private readonly _broadcaster: StatusBroadcaster;
  private readonly wss: WebSocketServer;
  private server: http.Server | null = null;

  constructor(deps: DashboardServerDeps) {
    this.deps = deps;
    this._broadcaster = new StatusBroadcaster(
      deps.getStatus,
      deps.config.webPushIntervalMs,
    );
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Access the broadcaster for pushing ad-hoc updates. */
  get broadcaster(): StatusBroadcaster {
    return this._broadcaster;
  }

  /** Start listening on the configured host and port. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { config } = this.deps;

      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("upgrade", (req, socket, head) => {
        this.handleUpgrade(req, socket as Socket, head);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          logError(TAG, `Port ${config.webPort} is already in use`);
          process.exit(1);
        }
        logError(TAG, "Server error", err);
        reject(err);
      });

      this.server.listen(config.webPort, config.webHost, () => {
        logInfo(TAG, `Dashboard listening on ${config.webHost}:${config.webPort}`);
        resolve();
      });
    });
  }

  /** Close all WebSocket connections and stop the HTTP server. */
  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      this._broadcaster.shutdown();

      this.wss.close(() => {
        if (this.server) {
          this.server.close(() => resolve());
        } else {
          resolve();
        }
      });
    });
  }

  // ── HTTP Request Handler ──────────────────────────────────────────────

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    try {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";
      const pathname = url.split("?")[0];

      // GET / — serve dashboard HTML (unauthenticated)
      if (method === "GET" && pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(this.deps.dashboardHtml);
        return;
      }

      // GET /api/memory/search — auth gate → memory search controller
      if (method === "GET" && pathname === "/api/memory/search") {
        if (!this.deps.authGate.guard(req, res)) return;

        if (!this.deps.memorySearchController) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "memory not enabled" }));
          return;
        }

        const qIdx = url.indexOf("?");
        const params = qIdx !== -1 ? new URLSearchParams(url.slice(qIdx)) : new URLSearchParams();

        this.deps.memorySearchController
          .handle(params)
          .then((result) => {
            res.writeHead(result.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.body));
          })
          .catch((err) => {
            this.sendError(res, 500, err);
          });
        return;
      }

      // GET /api/memory/chats — auth gate → list stored chat IDs
      if (method === "GET" && pathname === "/api/memory/chats") {
        if (!this.deps.authGate.guard(req, res)) return;

        if (!this.deps.memorySearchController) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "memory not enabled" }));
          return;
        }

        const result = this.deps.memorySearchController.listChats();
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }

      // POST /api/platforms/:platform/:action — auth gate → platform controller
      const platformMatch = method === "POST" && pathname?.match(/^\/api\/platforms\/([^/]+)\/([^/]+)$/);
      if (platformMatch) {
        if (!this.deps.authGate.guard(req, res)) return;

        const [, platform, action] = platformMatch;
        this.deps.platformController
          .handle(platform!, action!)
          .then((result) => {
            res.writeHead(result.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.body));
          })
          .catch((err) => {
            this.sendError(res, 500, err);
          });
        return;
      }

      // POST /api/transport/switch — auth gate → transport controller
      if (method === "POST" && pathname === "/api/transport/switch") {
        if (!this.deps.authGate.guard(req, res)) return;

        this.readJsonBody(req)
          .then((body) => {
            const mode = body?.mode;
            if (mode !== "tmux" && mode !== "acp") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: 'Invalid mode. Expected "tmux" or "acp".' }));
              return;
            }
            return this.deps.transportController.handle(mode);
          })
          .then((result) => {
            if (result) {
              res.writeHead(result.status, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result.body));
            }
          })
          .catch((err) => {
            this.sendError(res, 500, err);
          });
        return;
      }

      // GET /api/logs — auth gate → read bridge.log (last 24h, optional level filter)
      if (method === "GET" && pathname === "/api/logs") {
        if (!this.deps.authGate.guard(req, res)) return;

        const qIdx = url.indexOf("?");
        const params = qIdx !== -1 ? new URLSearchParams(url.slice(qIdx)) : new URLSearchParams();
        const levelFilter = params.get("level")?.split(",") ?? [];
        const limit = Math.min(parseInt(params.get("limit") ?? "500", 10) || 500, 2000);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;

        try {
          const lines = readLogLines(cutoff, levelFilter, limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, lines }));
        } catch (err) {
          this.sendError(res, 500, err);
        }
        return;
      }

      // POST /api/cron/:id/pause|resume|trigger — auth gate → cron control
      const cronMatch = method === "POST" && pathname?.match(/^\/api\/cron\/([^/]+)\/(pause|resume|trigger)$/);
      if (cronMatch) {
        if (!this.deps.authGate.guard(req, res)) return;

        const [, id, action] = cronMatch;
        try {
          const result = handleCronAction(id!, action!);
          res.writeHead(result.ok ? 200 : 404, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          this.sendError(res, 500, err);
        }
        return;
      }

      // Unknown route → 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      this.sendError(res, 500, err);
    }
  }

  // ── WebSocket Upgrade Handler ─────────────────────────────────────────

  private handleUpgrade(
    req: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void {
    const url = req.url ?? "";
    const pathname = url.split("?")[0];

    // Only accept upgrades on /ws
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Auth via query param or header
    const token = this.deps.authGate.extractToken(req);
    if (!token || !this.deps.authGate.validate(token)) {
      logInfo(TAG, `WebSocket auth failed (token ${token ? "provided but invalid" : "missing"}) from ${req.socket.remoteAddress}`);
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n" +
        "Content-Type: application/json\r\n" +
        "\r\n" +
        JSON.stringify({ error: "Unauthorized" }),
      );
      socket.destroy();
      return;
    }

    logInfo(TAG, `WebSocket client authenticated from ${req.socket.remoteAddress}`);

    // Delegate handshake to ws library (same pattern as openclaw canvas-host)
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
      this._broadcaster.addClient(ws);
      logInfo(TAG, "WebSocket client connected");
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Read and parse a JSON request body. */
  private readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve(raw ? JSON.parse(raw) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  /** Send an error response, logging the error. */
  private sendError(
    res: http.ServerResponse,
    status: number,
    err: unknown,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    logError(TAG, `Request error: ${message}`);
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }
}

// ── Log Reader ──────────────────────────────────────────────────────────────

function readLogLines(cutoffMs: number, levelFilter: string[], limit: number): string[] {
  if (!existsSync(LOG_FILE)) return [];
  const content = readFileSync(LOG_FILE, "utf-8");
  const allLines = content.split("\n").filter((l) => l.length > 0);
  const cutoffIso = new Date(cutoffMs).toISOString();

  const filtered: string[] = [];
  for (let i = allLines.length - 1; i >= 0 && filtered.length < limit; i--) {
    const line = allLines[i]!;
    // Format: 2026-03-23T19:20:10.123Z INFO  [tag] message
    const ts = line.slice(0, 24);
    // Skip lines that don't start with a timestamp (stack traces, continuations)
    if (ts.length < 24 || ts[4] !== "-" || ts[10] !== "T") continue;
    if (ts < cutoffIso) break; // lines are chronological, stop early

    if (levelFilter.length > 0) {
      const level = line.slice(25, 30).trim().toLowerCase();
      if (!levelFilter.includes(level)) continue;
    }
    filtered.push(line);
  }
  return filtered.reverse();
}

// ── Cron Control ────────────────────────────────────────────────────────────

function handleCronAction(id: string, action: string): { ok: boolean; error?: string } {
  if (!existsSync(CRON_FILE)) return { ok: false, error: "cron.json not found" };
  const entries = JSON.parse(readFileSync(CRON_FILE, "utf-8")) as Array<Record<string, unknown>>;
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { ok: false, error: `Entry ${id} not found` };

  if (action === "pause") {
    entry.paused = true;
  } else if (action === "resume") {
    delete entry.paused;
  } else if (action === "trigger") {
    entry.fireAt = Date.now() - 1000; // set to past so next cron tick picks it up
    delete entry.paused;
    entry.fired = false;
  }

  writeFileSync(CRON_FILE, JSON.stringify(entries, null, 2), "utf-8");
  return { ok: true };
}
