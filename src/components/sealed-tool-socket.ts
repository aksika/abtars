/**
 * sealed-tool-socket.ts — authenticated local Unix socket through which the
 * bundled `abtars-sealed-mcp` stdio proxy forwards bounded tool calls to the
 * in-process host tool service (#1660).
 *
 * The endpoint authenticates before parsing tool input, bounds frames,
 * rejects inactive/revoked tokens identically, and never listens on network
 * sockets. The execution context (user id, execution id, session type) comes
 * exclusively from the activated token — never from the wire — so a caller
 * cannot impersonate another execution by crafting a frame.
 */

import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import type { HostToolService } from "./host-tool-service.js";
import type { AbtarsMemoryRuntime, FindSealedSecretsInput } from "./memory-runtime.js";
import type { SealedSecretHandles } from "./sealed-secret-handles.js";
import { logWarn } from "./logger.js";

export const SEALED_TOKEN_PREFIX = "sealed-token:";
const TOKEN_BYTES = 32;
const FRAME_MAX_BYTES = 64 * 1024;
const TOKEN_TTL_MS = 30 * 60 * 1000;

export interface SealedExecutionContext {
  readonly userId: string;
  readonly executionId: string;
  readonly sessionType: string;
  readonly sandboxed: boolean;
}

export interface SealedSocketDeps {
  hostService: HostToolService;
  runtimeHolder: { current: AbtarsMemoryRuntime | null };
  /** Per-prompt activation. Returns false when no Main execution is active. */
  activeContext(token: string): SealedExecutionContext | null;
  activate(token: string, ctx: SealedExecutionContext): void;
  deactivate(token: string): void;
}

interface ToolCallFrame {
  type: "tool_call";
  name: string;
  arguments: Record<string, unknown>;
}

/** Server-side singleton registry shared by the ACP transport and the socket. */
export class SealedTokenRegistry {
  private readonly contexts = new Map<string, { ctx: SealedExecutionContext; expiresAt: number }>();

  issueToken(): string {
    return SEALED_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
  }

  activate(token: string, ctx: SealedExecutionContext): void {
    if (!token.startsWith(SEALED_TOKEN_PREFIX)) return;
    this.contexts.set(token, { ctx, expiresAt: Date.now() + TOKEN_TTL_MS });
  }

  deactivate(token: string): void {
    this.contexts.delete(token);
  }

  activeContext(token: string): SealedExecutionContext | null {
    const entry = this.contexts.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.contexts.delete(token);
      return null;
    }
    return entry.ctx;
  }

  revokeAll(): void {
    this.contexts.clear();
  }

  get size(): number {
    return this.contexts.size;
  }
}

export interface SealedSocketServer {
  readonly path: string;
  close(): Promise<void>;
}

/**
 * Start the authenticated tool socket at `path`. The socket file is created
 * 0600 and unlinked on close; any stale file at the path is removed first.
 */
export function startSealedToolSocket(
  path: string,
  registry: SealedTokenRegistry,
  deps: {
    hostService: HostToolService;
    runtimeHolder: { current: AbtarsMemoryRuntime | null };
    handles: SealedSecretHandles;
  },
): Promise<SealedSocketServer> {
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* stale socket ignored */ }
  }

  const openSockets = new Set<Socket>();

  const server = createServer((socket: Socket) => {
    let buffer = "";
    let token: string | null = null;
    let connectedContext: SealedExecutionContext | null = null;
    socket.setEncoding("utf-8");
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));

    const reply = (payload: unknown): void => {
      const line = JSON.stringify(payload) + "\n";
      if (socket.writable) socket.write(line);
    };

    const reject = (message: string): void => {
      reply({ ok: false, error: message });
      socket.destroy();
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > FRAME_MAX_BYTES * 4) {
        reject("frame_too_large");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (raw.trim() === "") return;

      let frame: unknown;
      try {
        frame = JSON.parse(raw) as unknown;
      } catch {
        reject("malformed_frame");
        return;
      }
      if (!frame || typeof frame !== "object") {
        reject("malformed_frame");
        return;
      }
      const record = frame as Record<string, unknown>;

      // Authenticate before parsing tool input.
      if (token === null) {
        if (record.type !== "hello" || typeof record.token !== "string") {
          reject("authentication_required");
          return;
        }
        token = record.token;
        connectedContext = registry.activeContext(token);
        if (!connectedContext) {
          reject("token_inactive_or_revoked");
          return;
        }
        reply({ ok: true, hello: "abtars-sealed-tools-v1" });
        return;
      }

      if (record.type !== "tool_call" || !record.name || typeof record.name !== "string") {
        reject("unsupported_frame");
        return;
      }
      const ctx = connectedContext;
      if (!ctx) {
        reject("token_inactive_or_revoked");
        return;
      }
      const call = frame as ToolCallFrame;
      const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
        ? call.arguments
        : {};

      void handleToolCall(call.name, args, ctx, deps)
        .then((result) => reply({ ok: true, result }))
        .catch((err) => {
          logWarn("sealed-tool-socket", `tool_call failed ${call.name}: ${err instanceof Error ? err.message : String(err)}`);
          reply({ ok: false, error: "tool_call_failed" });
        });
    });

    socket.on("error", () => { /* connection dropped */ });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      server.on("error", (err) => {
        logWarn("sealed-tool-socket", `socket error: ${err instanceof Error ? err.message : String(err)}`);
      });
      try {
        // The socket file inherits the process umask (0o077 → 0600); assert it.
        chmodSync(path, 0o600);
      } catch { /* best effort */ }
      resolve({
        path,
        close: () => new Promise<void>((done) => {
          for (const open of openSockets) {
            try { open.destroy(); } catch { /* already gone */ }
          }
          openSockets.clear();
          server.close(() => done());
          try {
            if (existsSync(path)) unlinkSync(path);
          } catch { /* already gone */ }
        }),
      });
    });
  });
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: SealedExecutionContext,
  deps: {
    hostService: HostToolService;
    runtimeHolder: { current: AbtarsMemoryRuntime | null };
    handles: SealedSecretHandles;
  },
): Promise<unknown> {
  const runtime = deps.runtimeHolder.current;
  if (name === "execute_bash") {
    const secretEnvRaw = args["secret_env"];
    const secretEnv = secretEnvRaw && typeof secretEnvRaw === "object" && !Array.isArray(secretEnvRaw)
      ? Object.fromEntries(Object.entries(secretEnvRaw as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]))
      : undefined;
    return deps.hostService.runBash(
      {
        command: typeof args["command"] === "string" ? args["command"] : "",
        secretEnv,
      },
      {
        userId: ctx.userId,
        executionId: ctx.executionId,
        authorizationMode: "interactive",
      },
    );
  }
  if (name === "secret_find") {
    if (!runtime || !runtime.supports("sealedSecrets")) {
      return JSON.stringify({ error: "sealed_secrets_unavailable", reason: "Sealed secret lookup is unavailable in this runtime." });
    }
    const query = typeof args["query"] === "string" ? args["query"].trim() : "";
    if (!query) return JSON.stringify({ error: "query is required" });
    const limit = Number.isSafeInteger(args["limit"]) ? Math.min(Math.max(args["limit"] as number, 1), 25) : 10;
    const refs = await runtime.findSealedSecrets({ userId: ctx.userId, query, limit } satisfies FindSealedSecretsInput);
    const results = refs.map((ref) => ({
      label: ref.label,
      handle: deps.handles.issue({
        executionId: ctx.executionId,
        userId: ctx.userId,
        memoryId: ref.memoryId,
        semanticRevision: ref.semanticRevision,
      }),
    }));
    return JSON.stringify({ ok: true, results });
  }
  return JSON.stringify({ error: `unknown sealed tool: ${name}` });
}
