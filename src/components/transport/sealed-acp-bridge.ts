/**
 * sealed-acp-bridge.ts — ACP presentation of the sealed host tools (#1660).
 *
 * ACP's ownership model has the agent process spawn the configured MCP
 * server. We use the stable stdio MCP configuration: a bundled
 * `abtars-sealed-mcp` proxy that forwards bounded calls over a 0600 local
 * Unix socket to the in-process host tool service. The session token travels
 * in the MCP server's child environment — agent-visible by design (single
 * session, activated only for the duration of one prompt, revoked on close),
 * never model-visible, and never treated as a secret the agent cannot see.
 *
 * Only Main (session type A) sessions get the server; other session types
 * retain no sealed tools.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { abtarsHome } from "../../paths.js";
import {
  SealedTokenRegistry,
  startSealedToolSocket,
  type SealedExecutionContext,
  type SealedSocketServer,
} from "../sealed-tool-socket.js";
import type { HostToolService } from "../host-tool-service.js";
import type { AbtarsMemoryRuntime } from "../memory-runtime.js";
import type { SealedSecretHandles } from "../sealed-secret-handles.js";
import { logWarn, logInfo } from "../logger.js";

export interface SealedAcpBridgeDeps {
  hostService: HostToolService;
  runtimeHolder: { current: AbtarsMemoryRuntime | null };
  handles: SealedSecretHandles;
}

let registry: SealedTokenRegistry | null = null;
let socket: SealedSocketServer | null = null;
let depsRef: SealedAcpBridgeDeps | null = null;
/** sessionKey → session token (issued once per session, Main only). */
const sessionTokens = new Map<string, string>();

export function sealedSocketPath(): string {
  return join(abtarsHome(), "run", "sealed-tools.sock");
}

/**
 * Resolve the bundled proxy path. In the esbuild bundle the proxy chunk sits
 * next to this module's chunk; the installed layout also mirrors it under
 * ~/.abtars/app/bundle.
 */
export function sealedMcpProxyPath(): string {
  const here = fileURLToPath(import.meta.url);
  const sibling = join(here, "..", "abtars-sealed-mcp.js");
  if (existsSync(sibling)) return sibling;
  return join(abtarsHome(), "app", "bundle", "abtars-sealed-mcp.js");
}

/** Start the authenticated socket once. Idempotent; returns the path. */
export async function ensureSealedAcpBridge(deps: SealedAcpBridgeDeps): Promise<string> {
  if (socket && depsRef) return socket.path;
  depsRef = deps;
  registry = new SealedTokenRegistry();
  socket = await startSealedToolSocket(sealedSocketPath(), registry, deps);
  logInfo("sealed-acp-bridge", `Sealed tool socket listening at ${socket.path}`);
  return socket.path;
}

function requireRegistry(): SealedTokenRegistry {
  if (!registry) throw new Error("sealed ACP bridge is not initialized");
  return registry;
}

/** Issue the per-session token for a Main ACP session. */
export function sessionTokenFor(sessionKey: string): string {
  const existing = sessionTokens.get(sessionKey);
  if (existing) return existing;
  const token = requireRegistry().issueToken();
  sessionTokens.set(sessionKey, token);
  return token;
}

/**
 * Stdio MCP server definition for `mcpServers` (SDK and raw paths). Returns
 * null for non-Main sessions so they carry no sealed tools at all.
 */
export function sealedMcpServerDefinition(sessionKey: string, sessionType: string | undefined): Record<string, unknown> | null {
  if (sessionType !== "A") return null;
  const token = sessionTokenFor(sessionKey);
  return {
    type: "stdio",
    name: "abtars-sealed-tools",
    command: process.execPath,
    args: [sealedMcpProxyPath()],
    env: [
      { name: "ABTARS_SEALED_SOCKET", value: sealedSocketPath() },
      { name: "ABTARS_SEALED_TOKEN", value: token },
    ],
  };
}

/**
 * Activate the session token with the trusted execution context before a
 * prompt; deactivate in the prompt's finalizer. The socket endpoint derives
 * every tool call's context from this activation — never from the wire.
 */
export function activateSealedToken(
  sessionKey: string,
  ctx: { userId: string; executionId: string; sessionType: string; sandboxed: boolean },
): void {
  const token = sessionTokens.get(sessionKey);
  if (!token) return;
  requireRegistry().activate(token, ctx satisfies SealedExecutionContext);
}

export function deactivateSealedToken(sessionKey: string): void {
  const token = sessionTokens.get(sessionKey);
  if (!token) return;
  requireRegistry().deactivate(token);
}

export function revokeSealedSession(sessionKey: string): void {
  const token = sessionTokens.get(sessionKey);
  if (token) {
    requireRegistry().deactivate(token);
    sessionTokens.delete(sessionKey);
  }
}

export function revokeAllSealedSessions(): void {
  if (registry) registry.revokeAll();
  sessionTokens.clear();
}

export async function closeSealedAcpBridge(): Promise<void> {
  revokeAllSealedSessions();
  if (socket) {
    await socket.close();
    socket = null;
  }
  registry = null;
  depsRef = null;
  void logWarn;
}

export function isSealedBridgeReady(): boolean {
  return socket !== null && registry !== null;
}
