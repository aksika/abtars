/**
 * sandbox-runtime.ts — spawn and manage Docker containers for sandboxed sessions.
 * Only active when SECURITY_MODE=sandbox and Docker is available.
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { logInfo, logError } from "./logger.js";

const TAG = "sandbox";

export interface SandboxSession {
  containerId: string;
  sessionToken: string;
  sessionType: string;
  startedAt: number;
}

const activeSessions = new Map<string, SandboxSession>();

/** Check if Docker is available on this machine. */
export function dockerAvailable(): boolean {
  const result = spawnSync("docker", ["info"], { stdio: "pipe", timeout: 5000 });
  return result.status === 0;
}

/** Spawn a sandboxed session in a Docker container. */
export function spawnSandbox(opts: {
  sessionId: string;
  sessionType: string;
  apiKey: string;
  socketPath: string;
  workspacePath: string;
  image?: string;
  memoryLimit?: string;
  timeoutSec?: number;
  network?: "bridge" | "none";
}): SandboxSession | null {
  const token = randomBytes(32).toString("hex");
  const image = opts.image ?? "abtars-sandbox:latest";
  const memLimit = opts.memoryLimit ?? "512m";
  const timeout = opts.timeoutSec ?? 300;
  const network = opts.network ?? (opts.sessionType === "B" ? "bridge" : "none");

  const args = [
    "run", "--rm", "-d",
    "--name", `abtars-session-${opts.sessionId}`,
    "--memory", memLimit,
    "--pids-limit", "100",
    "--security-opt", "no-new-privileges:true",
    "--network", network,
    "--stop-timeout", String(timeout),
    "-e", `SESSION_TOKEN=${token}`,
    "-e", `SESSION_ID=${opts.sessionId}`,
    "-e", `SESSION_TYPE=${opts.sessionType}`,
    "-e", `API_KEY=${opts.apiKey}`,
    "-v", `${opts.socketPath}:/run/bridge.sock:ro`,
    "-v", `${opts.workspacePath}:/workspace`,
    image,
  ];

  const result = spawnSync("docker", args, { encoding: "utf-8", timeout: 30_000 });
  if (result.status !== 0) {
    logError(TAG, `Failed to spawn sandbox: ${(result.stderr || "").trim()}`);
    return null;
  }

  const containerId = (result.stdout || "").trim().slice(0, 12);
  logInfo(TAG, `Spawned sandbox ${containerId} for session ${opts.sessionId} (type=${opts.sessionType}, net=${network})`);

  const session: SandboxSession = {
    containerId,
    sessionToken: token,
    sessionType: opts.sessionType,
    startedAt: Date.now(),
  };

  activeSessions.set(opts.sessionId, session);
  return session;
}

/** Stop and remove a sandboxed session container. */
export function killSandbox(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  spawnSync("docker", ["kill", session.containerId], { stdio: "pipe", timeout: 10_000 });
  activeSessions.delete(sessionId);
  logInfo(TAG, `Killed sandbox ${session.containerId} (session ${sessionId})`);
}

/** Kill all active sandbox containers (bridge shutdown). */
export function killAllSandboxes(): void {
  for (const [id] of activeSessions) {
    killSandbox(id);
  }
}

/** Get active sandbox sessions for observability. */
export function getActiveSandboxes(): ReadonlyMap<string, SandboxSession> {
  return activeSessions;
}
