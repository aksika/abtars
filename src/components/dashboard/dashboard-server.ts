/**
 * Dashboard HTTP server with WebSocket support via the `ws` library.
 * Routes requests to controllers, serves the inline HTML dashboard,
 * and manages WebSocket connections for real-time status push.
 *
 * Uses `ws` with noServer mode (same pattern as openclaw canvas-host).
 */

import * as http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import type { DashboardConfig, StatusSnapshot } from "./dashboard-config.js";
import { AuthGate } from "../auth-gate.js";
import { StatusBroadcaster } from "../status-broadcaster.js";
import type { ServiceRegistry } from "../service-registry.js";
import type { MemorySearchController } from "../memory-search-controller.js";
import { logInfo, logError, getLogFile } from "../logger.js";

// ── Constants ───────────────────────────────────────────────────────────────

const TAG = "dashboard-server";

// ── Types ───────────────────────────────────────────────────────────────────

export type DashboardServerDeps = {
  config: DashboardConfig;
  authGate: AuthGate;
  getStatus: () => StatusSnapshot;
  registry: ServiceRegistry;
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

      // Force-close all WebSocket clients so server.close() doesn't hang
      for (const client of this.wss.clients) {
        try { client.terminate(); } catch { /* best-effort */ }
      }

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

      // GET /*.js or /*.css — serve static files from dist/public/
      if (method === "GET" && /^\/([\w-]+)\.(js|css)$/.test(pathname ?? "")) {
        const filename = pathname!.slice(1);
        const filePath = join(dirname(fileURLToPath(import.meta.url)), "..", "public", filename);
        if (existsSync(filePath)) {
          const ext = filename.endsWith(".css") ? "text/css" : "text/javascript";
          res.writeHead(200, { "Content-Type": `${ext}; charset=utf-8` });
          res.end(readFileSync(filePath, "utf-8"));
          return;
        }
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

      // GET /api/memory/all — auth gate → all extracted memories for visualization
      if (method === "GET" && pathname === "/api/memory/all") {
        if (!this.deps.authGate.guard(req, res)) return;

        if (!this.deps.memorySearchController) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "memory not enabled" }));
          return;
        }

        const result = this.deps.memorySearchController.listAll();
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }

      // POST /api/services/:name/start|stop — auth gate → service registry
      const svcMatch = method === "POST" && pathname?.match(/^\/api\/services\/([^/]+)\/(start|stop)$/);
      if (svcMatch) {
        if (!this.deps.authGate.guard(req, res)) return;

        const [, name, action] = svcMatch;
        const doAction = action === "start"
          ? this.deps.registry.start(name!)
          : Promise.resolve(this.deps.registry.stop(name!));

        doAction
          .then((result) => {
            res.writeHead(result.ok ? 200 : 409, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
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
  const logFile = getLogFile();
  if (!existsSync(logFile)) return [];
  const content = readFileSync(logFile, "utf-8");
  const allLines = content.split("\n").filter((l) => l.length > 0);
  const cutoffIso = new Date(cutoffMs).toISOString().slice(0, 23);

  const filtered: string[] = [];
  for (let i = allLines.length - 1; i >= 0 && filtered.length < limit; i--) {
    const line = allLines[i]!;
    // Format: 2026-03-27T23:51:06.548 INFO  [tag] message (local time, no Z)
    const ts = line.slice(0, 23);
    if (ts.length < 23 || ts[4] !== "-" || ts[10] !== "T") continue;
    if (ts < cutoffIso) break;

    if (levelFilter.length > 0) {
      const level = line.slice(24, 29).trim().toLowerCase();
      if (!levelFilter.includes(level)) continue;
    }
    filtered.push(line);
  }
  return filtered.reverse();
}

// ── Cron Control ────────────────────────────────────────────────────────────

import { readEntry as cronReadEntry, writeEntry as cronWriteEntry } from "../cron/cron-db.js";

function handleCronAction(id: string, action: string): { ok: boolean; error?: string } {
  const entry = cronReadEntry(id);
  if (!entry) return { ok: false, error: `Entry ${id} not found` };

  if (action === "pause") {
    entry.paused = true;
  } else if (action === "resume") {
    entry.paused = false;
  } else if (action === "trigger") {
    entry.fireAt = Date.now() - 1000;
    entry.paused = false;
    entry.fired = false;
  }

  cronWriteEntry(entry);
  return { ok: true };
}
