/**
 * Dashboard HTTP server with WebSocket support via the `ws` library.
 * Routes requests to controllers, serves the inline HTML dashboard,
 * and manages WebSocket connections for real-time status push.
 *
 * Uses `ws` with noServer mode (same pattern as openclaw canvas-host).
 */

import * as http from "node:http";
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
