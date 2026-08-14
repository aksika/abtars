import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SealedTokenRegistry,
  startSealedToolSocket,
  type SealedExecutionContext,
  type SealedSocketServer,
} from "./sealed-tool-socket.js";
import { HostToolService } from "./host-tool-service.js";
import { SealedSecretHandles } from "./sealed-secret-handles.js";
import type { AbtarsMemoryRuntime } from "./memory-runtime.js";

function fakeRuntime(): AbtarsMemoryRuntime {
  const base = {
    state: "ready",
    capabilities: new Set(["sealedSecrets"] as never),
    routeSnapshot: { version: 1, state: "ready", generation: 0, retryEligible: 0, terminalUnknown: 0 },
    supports: (cap: string) => cap === "sealedSecrets",
    findSealedSecrets: async (input: { userId: string; query: string; limit?: number }) => [
      { memoryId: 7, semanticRevision: 1, label: `label-${input.query}`, memoryType: "secret", createdAt: 1000 },
    ],
    resolveSealedSecret: async () => ({ ok: true, value: "fixture-value", semanticRevision: 1 }),
  } as never;
  return base as AbtarsMemoryRuntime;
}

describe("#1660 sealed tool socket", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: SealedSocketServer;
  let registry: SealedTokenRegistry;
  let handles: SealedSecretHandles;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-sealed-sock-"));
    socketPath = join(tmpDir, "sealed-tools.sock");
    registry = new SealedTokenRegistry();
    handles = new SealedSecretHandles();
    const hostService = new HostToolService({
      handles,
      actionGate: null,
      resolveHandle: async () => ({ memoryId: 7, semanticRevision: 1, value: "fixture-value" }),
    });
    server = await startSealedToolSocket(socketPath, registry, {
      hostService,
      runtimeHolder: { current: fakeRuntime() },
      handles,
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function open(): Promise<{ socket: Socket; readFrame: () => Promise<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let buffer = "";
      socket.setEncoding("utf-8");
      const waiters: Array<(frame: Record<string, unknown>) => void> = [];
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0 && waiters.length > 0) {
          const raw = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          waiters.shift()!(JSON.parse(raw) as Record<string, unknown>);
          nl = buffer.indexOf("\n");
        }
      });
      const readFrame = (): Promise<Record<string, unknown>> => new Promise((done) => waiters.push(done));
      socket.once("error", reject);
      socket.once("connect", () => resolve({ socket, readFrame }));
    });
  }

  async function connectWith(token: string | null): Promise<Record<string, unknown>> {
    const { socket, readFrame } = await open();
    socket.write(JSON.stringify(token === null ? { type: "hello" } : { type: "hello", token }) + "\n");
    return readFrame();
  }

  it("authenticates an active token and serves tool calls with the token's execution context", async () => {
    const ctx: SealedExecutionContext = { userId: "u1", executionId: "exec-1", sessionType: "A", sandboxed: true };
    const token = registry.issueToken();
    registry.activate(token, ctx);

    const hello = await connectWith(token);
    expect(hello).toEqual({ ok: true, hello: "abtars-sealed-tools-v1" });

    const { socket, readFrame } = await open();
    socket.write(JSON.stringify({ type: "hello", token }) + "\n");
    await readFrame(); // hello ack
    socket.write(JSON.stringify({ type: "tool_call", name: "secret_find", arguments: { query: "github", limit: 5 } }) + "\n");
    const response = await readFrame();
    expect(response.ok).toBe(true);
    const result = JSON.parse(response.result as string) as { ok: boolean; results: Array<{ label: string; handle: string }> };
    expect(result.ok).toBe(true);
    expect(result.results[0]!.label).toBe("label-github");
    expect(result.results[0]!.handle).toMatch(/^secret:/);
    socket.destroy();
  });

  it("rejects inactive, revoked and missing tokens identically", async () => {
    const inactive = await connectWith(registry.issueToken());
    expect(inactive.ok).toBe(false);
    expect(inactive.error).toBe("token_inactive_or_revoked");

    const token = registry.issueToken();
    registry.activate(token, { userId: "u1", executionId: "e", sessionType: "A", sandboxed: true });
    registry.deactivate(token);
    const revoked = await connectWith(token);
    expect(revoked.ok).toBe(false);
    expect(revoked.error).toBe("token_inactive_or_revoked");

    const missing = await connectWith(null);
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("authentication_required");
  });

  it("requires authentication before parsing tool input", async () => {
    const { socket, readFrame } = await open();
    socket.write(JSON.stringify({ type: "tool_call", name: "secret_find", arguments: { query: "x" } }) + "\n");
    const response = await readFrame();
    expect(response.ok).toBe(false);
    expect(response.error).toBe("authentication_required");
    socket.destroy();
  });

  it("context cleanup: a deactivated token cannot serve a second connection", async () => {
    const token = registry.issueToken();
    registry.activate(token, { userId: "u1", executionId: "e", sessionType: "A", sandboxed: true });
    registry.deactivate(token);

    const hello = await connectWith(token);
    expect(hello.ok).toBe(false);
    expect(hello.error).toBe("token_inactive_or_revoked");
  });

  it("re-checks token activity on an already-authenticated socket", async () => {
    const token = registry.issueToken();
    registry.activate(token, { userId: "u1", executionId: "e", sessionType: "A", sandboxed: true });
    const { socket, readFrame } = await open();
    socket.write(JSON.stringify({ type: "hello", token }) + "\n");
    await readFrame();
    registry.deactivate(token);
    socket.write(JSON.stringify({ type: "tool_call", name: "secret_find", arguments: { query: "x" } }) + "\n");
    const rejected = await readFrame();
    expect(rejected).toEqual({ ok: false, error: "token_inactive_or_revoked" });
    socket.destroy();
  });

  it("handles execute_bash through the shared host service with handle resolution", async () => {
    const ctx: SealedExecutionContext = { userId: "u1", executionId: "exec-2", sessionType: "A", sandboxed: true };
    const token = registry.issueToken();
    registry.activate(token, ctx);

    // Mint a handle bound to the same execution via a secret_find result.
    const secretToken = handles.issue({ executionId: "exec-2", userId: "u1", memoryId: 7, semanticRevision: 1 });

    const { socket, readFrame } = await open();
    socket.write(JSON.stringify({ type: "hello", token }) + "\n");
    await readFrame();
    socket.write(JSON.stringify({
      type: "tool_call",
      name: "execute_bash",
      arguments: { command: "printf '%s' \"$ABTARS_SECRET_TOKEN\"", secret_env: { ABTARS_SECRET_TOKEN: secretToken } },
    }) + "\n");
    const response = await readFrame();
    expect(response.ok).toBe(true);
    const result = JSON.parse(response.result as string) as { stdout: string; exit_code: number };
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("[REDACTED]");
    socket.destroy();
  });
});
