/**
 * #1660 mandatory cross-adapter acceptance: sealed secret storage, discovery
 * and host execution through the PiCore adapter (in-process) and the ACP
 * adapter (authenticated local tool socket, which is what the bundled
 * `abtars-sealed-mcp` stdio proxy forwards to).
 *
 * The fixture is real where it matters: a real temporary abmind database and
 * daemon, a real local endpoint/client, a real child bash process, and the
 * real shared HostToolService. External provider/model output is the only
 * deterministic fixture. The synthetic value defeats static regex redaction
 * and contains whitespace, quotes and shell metacharacters.
 *
 * This test is mandatory acceptance and cannot be replaced by source
 * assertions or a live smoke.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import type { Database } from "better-sqlite3";
import { MemoryManager, MEMORY_CONFIG_DEFAULTS, type MemoryConfig } from "abmind";
import { AbmindService } from "abmind";
import { LocalEndpointServer } from "abmind";
import { LocalTransport } from "abmind";
import { AbmindClient } from "abmind";
import { createClientRuntime, type AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import { HostToolService } from "../../components/host-tool-service.js";
import { SealedSecretHandles } from "../../components/sealed-secret-handles.js";
import { executeToolCall, getSealedSecretHandles, setHostToolService } from "../../components/transport/tool-registry.js";
import type { MemoryToolDependenciesHolder } from "../../components/memory-store-quota.js";
import {
  SealedTokenRegistry,
  startSealedToolSocket,
  type SealedExecutionContext,
  type SealedSocketServer,
} from "../../components/sealed-tool-socket.js";

// Deliberately not credential-shaped for any static regex: contains
// whitespace, quotes, $, $(...) and a semicolon.
const SYNTHETIC_VALUE = `s3cr3t-ĺiteral "with quotes" and $HOME; $(echo pwn) 'single'`;
const LABEL = "OpenRouter API key (acceptance fixture)";

const PERMISSIVE_POLICY = { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true };

// tool-registry computes its audit path at module load; capture it here at
// module scope (before beforeAll overrides ABTARS_HOME).
const AUDIT_PATH = join(process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "", ".abtars"), "logs", "audit.jsonl");

describe("#1660 cross-adapter sealed acceptance", () => {
  let tmpDir: string;
  let homeDir: string;
  let manager: MemoryManager;
  let db: Database;
  let service: AbmindService;
  let endpoint: LocalEndpointServer;
  let client: AbmindClient;
  let runtime: AbtarsMemoryRuntime;
  let holder: MemoryToolDependenciesHolder;
  let handles: SealedSecretHandles;
  let hostService: HostToolService;
  let socketServer: SealedSocketServer;
  let registry: SealedTokenRegistry;
  let socketPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "abtars-sealed-acceptance-"));
    homeDir = join(tmpDir, "home");
    process.env["ABTARS_HOME"] = homeDir;
    process.env["ABMIND_KEY_FILE"] = join(tmpDir, "secret", "abmind.key");
    process.env.ABMIND_USER_ID = "local-user";

    const config: MemoryConfig = { ...MEMORY_CONFIG_DEFAULTS, memoryDir: join(tmpDir, "memory") };
    manager = new MemoryManager(config);
    await manager.initialize();
    db = (manager as unknown as { db: Database | null }).db!;

    service = new AbmindService({
      serverInstanceId: "acceptance", mode: "daemon", manager,
      operational: null, requestLedgerDb: db,
    });
    const sock = join(tmpDir, "memory.sock");
    endpoint = new LocalEndpointServer({ socketPath: sock, service, principalMapping: "self" });
    await endpoint.start();

    client = new AbmindClient(new LocalTransport(sock));
    await client.negotiate();
    runtime = createClientRuntime(client);
    expect(runtime.supports("sealedSecrets")).toBe(true);
    expect(runtime.supports("instantStore")).toBe(true);

    // Seed one sealed row through the REAL storage path.
    const seeded = await runtime.instantStore({
      userId: "local-user",
      contentEn: "",
      contentOriginal: SYNTHETIC_VALUE,
      memoryType: "secret",
      emotionScore: 0,
      confidence: 3,
      classification: 3,
      sealedLabel: LABEL,
    });
    expect(seeded.stored).toBe(true);

    // Wire the shared host service + handle store (as boot does): secret_find
    // issues handles from the registry singleton; the service must resolve
    // against the SAME store.
    handles = getSealedSecretHandles();
    hostService = new HostToolService({
      handles,
      actionGate: null,
      resolveHandle: async (binding) => {
        const resolved = await runtime.resolveSealedSecret({
          userId: binding.userId,
          memoryId: binding.memoryId,
          expectedRevision: binding.semanticRevision,
        });
        if (!resolved.ok) return null;
        return { memoryId: binding.memoryId, semanticRevision: resolved.semanticRevision, value: resolved.value };
      },
    });
    setHostToolService(hostService);

    holder = { current: { runtime, quota: undefined as never } };

    // ACP adapter boundary: authenticated local tool socket.
    registry = new SealedTokenRegistry();
    socketPath = join(tmpDir, "sealed.sock");
    socketServer = await startSealedToolSocket(socketPath, registry, {
      hostService,
      runtimeHolder: { current: runtime },
      handles,
    });
  });

  afterAll(async () => {
    await socketServer.close();
    setHostToolService(null);
    await endpoint.stop?.().catch(() => {});
    client.close().catch(() => {});
    manager.close();
    delete process.env["ABTARS_HOME"];
    delete process.env["ABMIND_KEY_FILE"];
    delete process.env.ABMIND_USER_ID;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function acpConnect(): Promise<{ socket: Socket; readFrame: () => Promise<Record<string, unknown>> }> {
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

  async function acpToolCall(token: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { socket, readFrame } = await acpConnect();
    socket.write(JSON.stringify({ type: "hello", token }) + "\n");
    const hello = await readFrame();
    if (hello.ok !== true) {
      socket.destroy();
      return hello;
    }
    const response = readFrame();
    socket.write(JSON.stringify({ type: "tool_call", name, arguments: args }) + "\n");
    const frame = await response;
    socket.destroy();
    return frame;
  }

  function executePiTool(name: string, args: Record<string, unknown>, opts?: { sessionType?: string; executionId?: string; userId?: string }): Promise<string> {
    return executeToolCall(name, args, {
      userId: opts?.userId ?? "local-user",
      executionId: opts?.executionId ?? "exec-pi-1",
      sessionType: (opts?.sessionType ?? "A") as never,
      sandboxPolicy: PERMISSIVE_POLICY,
      memoryToolDeps: holder,
      authorizationMode: "interactive",
    });
  }

  it("PiCore: secret_find returns label + opaque handle only; value never surfaces", async () => {
    const result = await executePiTool("secret_find", { query: "OpenRouter", limit: 10 });
    const parsed = JSON.parse(result) as { ok: boolean; results: Array<{ label: string; handle: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0]!.label).toBe(LABEL);
    expect(parsed.results[0]!.handle).toMatch(/^secret:/);
    expect(result).not.toContain(SYNTHETIC_VALUE);
    expect(result).not.toContain("memoryId");
  });

  it("PiCore: secret_find fails closed for non-Main session types", async () => {
    const result = await executePiTool("secret_find", { query: "OpenRouter" }, { sessionType: "D" });
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBe("secret_find_not_allowed");
  });

  it("PiCore: execute_bash delivers exact bytes to the child and scrubs echoes from every capture", async () => {
    const find = JSON.parse(await executePiTool("secret_find", { query: "OpenRouter" })) as { results: Array<{ handle: string }> };
    const handle = find.results[0]!.handle;

    const out = await executePiTool("execute_bash", {
      command: `printf '%s' "$ABTARS_SECRET_TOKEN"; printf '%s' "$ABTARS_SECRET_TOKEN" >&2`,
      secret_env: { ABTARS_SECRET_TOKEN: handle },
    });
    const parsed = JSON.parse(out) as { stdout: string; stderr: string; exit_code: number };
    expect(parsed.exit_code).toBe(0);
    // Exact bytes arrived and were scrubbed: the value appears nowhere.
    expect(parsed.stdout).toBe("[REDACTED]");
    expect(parsed.stderr).toBe("[REDACTED]");
    expect(out).not.toContain(SYNTHETIC_VALUE);
    expect(out).not.toContain(handle);
  });

  it("PiCore: forged and wrong-execution handles spawn nothing", async () => {
    const find = JSON.parse(await executePiTool("secret_find", { query: "OpenRouter" })) as { results: Array<{ handle: string }> };
    const handle = find.results[0]!.handle;

    const forged = await executePiTool("execute_bash", {
      command: "echo $ABTARS_SECRET_TOKEN",
      secret_env: { ABTARS_SECRET_TOKEN: "secret:forged" },
    });
    expect(JSON.parse(forged)).toMatchObject({ error: "sealed_handle_invalid" });

    const wrongExec = await executePiTool("execute_bash", {
      command: "echo $ABTARS_SECRET_TOKEN",
      secret_env: { ABTARS_SECRET_TOKEN: handle },
    }, { executionId: "exec-other" });
    expect(JSON.parse(wrongExec)).toMatchObject({ error: "sealed_handle_invalid" });
  });

  it("ACP: the socket adapter serves the same host service with token-bound context", async () => {
    const ctx: SealedExecutionContext = { userId: "local-user", executionId: "exec-acp-1", sessionType: "A", sandboxed: true };
    const token = registry.issueToken();
    registry.activate(token, ctx);

    const find = await acpToolCall(token, "secret_find", { query: "OpenRouter" });
    expect(find.ok).toBe(true);
    const findResult = JSON.parse(find.result as string) as { ok: boolean; results: Array<{ label: string; handle: string }> };
    expect(findResult.ok).toBe(true);
    expect(findResult.results[0]!.label).toBe(LABEL);
    const handle = findResult.results[0]!.handle;

    const call = await acpToolCall(token, "execute_bash", {
      command: `printf '%s' "$ABTARS_SECRET_TOKEN"`,
      secret_env: { ABTARS_SECRET_TOKEN: handle },
    });
    expect(call.ok).toBe(true);
    const callResult = JSON.parse(call.result as string) as { stdout: string; exit_code: number };
    expect(callResult.exit_code).toBe(0);
    expect(callResult.stdout).toBe("[REDACTED]");
    expect(JSON.stringify(call)).not.toContain(SYNTHETIC_VALUE);
  });

  it("ACP: inactive/revoked tokens are rejected identically", async () => {
    const inactive = await acpToolCall(registry.issueToken(), "secret_find", { query: "OpenRouter" });
    expect(inactive.ok).toBe(false);
    expect(inactive.error).toBe("token_inactive_or_revoked");

    const token = registry.issueToken();
    registry.activate(token, { userId: "local-user", executionId: "e", sessionType: "A", sandboxed: true });
    registry.deactivate(token);
    const revoked = await acpToolCall(token, "secret_find", { query: "OpenRouter" });
    expect(revoked.ok).toBe(false);
    expect(revoked.error).toBe("token_inactive_or_revoked");
  });

  it("tool audit captures variable names only — neither value nor handle", async () => {
    const find = JSON.parse(await executePiTool("secret_find", { query: "OpenRouter" })) as { results: Array<{ handle: string }> };
    const handle = find.results[0]!.handle;
    await executePiTool("execute_bash", {
      command: "echo $ABTARS_SECRET_TOKEN",
      secret_env: { ABTARS_SECRET_TOKEN: handle },
    });

    const audit = readFileSync(AUDIT_PATH, "utf-8");
    expect(audit).not.toContain(SYNTHETIC_VALUE);
    expect(audit).not.toContain(handle);
    expect(audit).toContain("[SEALED_HANDLE]");
  });

  it("resolution fails closed and indistinguishably for forged/stale inputs", async () => {
    // The resolver's failures are indistinguishable (wrong owner, stale
    // revision, expired, version-0) — a forged peer frame or a stale handle
    // can never learn whether another owner's row exists.
    const wrongRevision = await runtime.resolveSealedSecret({ userId: "local-user", memoryId: 1, expectedRevision: 999 });
    expect(wrongRevision).toEqual({ ok: false, code: "sealed_resolution_failed" });
    const wrongOwner = await runtime.resolveSealedSecret({ userId: "someone-else", memoryId: 1, expectedRevision: 1 });
    expect(wrongOwner).toEqual({ ok: false, code: "sealed_resolution_failed" });
    const nonexistent = await runtime.resolveSealedSecret({ userId: "local-user", memoryId: 424242, expectedRevision: 1 });
    expect(nonexistent).toEqual({ ok: false, code: "sealed_resolution_failed" });
  });

  void getSealedSecretHandles;
});
