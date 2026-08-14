/**
 * abtars-sealed-mcp — minimal stdio MCP proxy for the sealed host tools
 * (#1660).
 *
 * The ACP agent process spawns this binary from its `mcpServers` config. This
 * proxy implements only MCP initialize, tools/list and tools/call for
 * `secret_find` and `execute_bash`. It NEVER resolves a secret or executes a
 * command itself: it authenticates over a 0600 local Unix socket
 * (ABTARS_SEALED_SOCKET) with a session token (ABTARS_SEALED_TOKEN), forwards
 * bounded calls to the in-process host tool service, and returns the
 * already-scrubbed results.
 *
 * The token is agent-visible by design (ACP hands it to the child it spawns)
 * but single-session and revoked on session/transport close.
 */

import { connect } from "node:net";
import { createInterface } from "node:readline";

const SOCKET_PATH = process.env["ABTARS_SEALED_SOCKET"];
const TOKEN = process.env["ABTARS_SEALED_TOKEN"];
const FRAME_MAX_BYTES = 64 * 1024;

const TOOLS = [
  {
    name: "secret_find",
    description: "Find stored credentials by label and return opaque execution-scoped handles. Pass each handle as an ABTARS_SECRET_* value in execute_bash's secret_env.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Label or keyword to search" },
        limit: { type: "integer", description: "Maximum results (1-25)" },
      },
      required: ["query"],
    },
  },
  {
    name: "execute_bash",
    description: "Execute a bash command with optional secret_env ABTARS_SECRET_* variables (values are sealed handles). Outputs are scrubbed.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        secret_env: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["command"],
    },
  },
];

if (!SOCKET_PATH || !TOKEN) {
  // eslint-disable-next-line no-console
  console.error("abtars-sealed-mcp: ABTARS_SEALED_SOCKET and ABTARS_SEALED_TOKEN are required");
  process.exit(1);
}

const socket = connect(SOCKET_PATH);
let authenticated = false;
const rl = createInterface({ input: process.stdin });

function sendRaw(line: string): void {
  process.stdout.write(line + "\n");
}

function respond(id: unknown, result: unknown): void {
  sendRaw(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function respondError(id: unknown, code: number, message: string): void {
  sendRaw(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

socket.setEncoding("utf-8");
let socketBuffer = "";
let authResolver: ((ok: boolean) => void) | null = null;
socket.on("data", (chunk: string) => {
  socketBuffer += chunk;
  if (socketBuffer.length > FRAME_MAX_BYTES * 4) {
    socket.destroy();
    process.exit(1);
  }
  let newline = socketBuffer.indexOf("\n");
  while (newline >= 0) {
    const raw = socketBuffer.slice(0, newline);
    socketBuffer = socketBuffer.slice(newline + 1);
    newline = socketBuffer.indexOf("\n");
    if (raw.trim() === "") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const record = payload as Record<string, unknown>;
    if (!authenticated) {
      // Only hello acks are legal before authentication.
      const resolver = authResolver;
      if (resolver && record.ok === true && record.hello !== undefined) {
        authResolver = null;
        authenticated = true;
        resolver(true);
      } else if (resolver && (record.ok === false || record.error !== undefined)) {
        authResolver = null;
        resolver(false);
      }
      continue;
    }
    const pending = pendingCalls.shift();
    if (!pending) return;
    if (record.ok === true && typeof record["result"] === "string") {
      respond(pending.id, { content: [{ type: "text", text: record["result"] }], isError: false });
    } else if (record.ok === true && record["result"] !== undefined) {
      respond(pending.id, { content: [{ type: "text", text: JSON.stringify(record["result"]) }], isError: false });
    } else {
      respondError(pending.id, -32000, typeof record["error"] === "string" ? record["error"] : "sealed_tool_call_failed");
    }
  }
});

socket.on("error", () => {
  process.exit(1);
});

const pendingCalls: Array<{ id: unknown }> = [];

function forwardToolCall(id: unknown, name: string, args: Record<string, unknown>): void {
  pendingCalls.push({ id });
  socket.write(JSON.stringify({ type: "tool_call", name, arguments: args }) + "\n");
}

/** Authenticate once; the hello ack is consumed by the single data handler.
 *  Concurrent callers share the same in-flight authentication. */
let authPromise: Promise<boolean> | null = null;
function authenticate(): Promise<boolean> {
  if (authenticated) return Promise.resolve(true);
  if (authPromise) return authPromise;
  authPromise = new Promise<boolean>((resolve) => {
    authResolver = resolve;
    socket.write(JSON.stringify({ type: "hello", token: TOKEN }) + "\n");
    setTimeout(() => {
      if (authResolver) {
        authResolver = null;
        resolve(false);
      }
    }, 5000);
  }).finally(() => {
    authPromise = null;
  });
  return authPromise;
}
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const method = request["method"];
  const id = request["id"];
  const params = (request["params"] ?? {}) as Record<string, unknown>;

  void (async () => {
    if (!authenticated) {
      const ok = await authenticate();
      if (!ok) {
        respondError(id, -32000, "sealed session token rejected or inactive");
        return;
      }
    }

    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "abtars-sealed-mcp", version: "1" },
        });
        return;
      case "notifications/initialized":
        return;
      case "tools/list":
        respond(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const call = params as { name?: unknown; arguments?: unknown };
        const name = typeof call.name === "string" ? call.name : "";
        const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
          ? call.arguments as Record<string, unknown>
          : {};
        if (name !== "secret_find" && name !== "execute_bash") {
          respondError(id, -32601, `unknown tool: ${name}`);
          return;
        }
        forwardToolCall(id, name, args);
        return;
      }
      default:
        respondError(id, -32601, `method not found: ${String(method)}`);
    }
  })().catch((err) => {
    respondError(id, -32000, err instanceof Error ? err.message : String(err));
  });
});
