/**
 * WebSocket broadcast component for pushing real-time status snapshots
 * to connected clients. Uses the `ws` library for proper WebSocket
 * protocol handling (framing, ping/pong, close frames).
 */

import { WebSocket } from "ws";
import type { StatusSnapshot } from "./dashboard/dashboard-config.js";

// ── StatusBroadcaster ───────────────────────────────────────────────────────

export class StatusBroadcaster {
  private readonly clients = new Set<WebSocket>();
  private readonly getStatus: () => StatusSnapshot;
  private readonly intervalMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(getStatus: () => StatusSnapshot, intervalMs: number) {
    this.getStatus = getStatus;
    this.intervalMs = intervalMs;
  }

  /** Add a connected WebSocket client. Sends an immediate snapshot. */
  addClient(ws: WebSocket): void {
    this.clients.add(ws);

    ws.on("close", () => this.removeClient(ws));
    ws.on("error", () => this.removeClient(ws));

    this.sendTo(ws, this.getStatus());

    if (this.clients.size === 1) {
      this.startInterval();
    }
  }

  /** Remove a client on close/error. Stops interval when no clients remain. */
  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);

    if (this.clients.size === 0) {
      this.stopInterval();
    }
  }

  /** Force-push a snapshot to all clients now (e.g. after a state change). */
  pushNow(): void {
    this.broadcast(this.getStatus());
  }

  /** Stop broadcasting and close all client sockets. */
  shutdown(): void {
    this.stopInterval();

    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // best-effort cleanup
      }
    }
    this.clients.clear();
  }

  /** Number of currently tracked clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Whether the broadcast interval is currently active. */
  get isBroadcasting(): boolean {
    return this.intervalHandle !== null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private startInterval(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.broadcast(this.getStatus());
    }, this.intervalMs);
  }

  private stopInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private broadcast(snapshot: StatusSnapshot): void {
    const payload = JSON.stringify(snapshot);
    const broken: WebSocket[] = [];

    for (const ws of this.clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        } else {
          broken.push(ws);
        }
      } catch {
        broken.push(ws);
      }
    }

    for (const ws of broken) {
      this.clients.delete(ws);
    }

    if (this.clients.size === 0) {
      this.stopInterval();
    }
  }

  private sendTo(ws: WebSocket, snapshot: StatusSnapshot): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(snapshot));
      }
    } catch {
      this.clients.delete(ws);
      if (this.clients.size === 0) {
        this.stopInterval();
      }
    }
  }
}
