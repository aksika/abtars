/**
 * #1659 integration acceptance: the real built abmind local composition behind
 * the bridge tools.
 *
 * A real MemoryManager + AbmindService + LocalEndpointServer + LocalTransport
 * + AbmindClient feed createClientRuntime, and memory_store / memory_edit tool
 * executions project the structured failure contract end-to-end: bridge tool
 * JSON keeps code/requestId/action/stage/retryable, and the tool-failure
 * diagnostic maps them to the memory_* reason family — never `unknown`.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { AbmindClient } from "abmind";
import { MemoryManager } from "abmind";
import { AbmindService } from "abmind";
import { LocalEndpointServer } from "abmind";
import { LocalTransport } from "abmind";
import { createClientRuntime, type AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import { executeToolCall } from "../../components/transport/tool-registry.js";
import { parseToolResultToDiagnostic } from "../../components/transport/tool-failure-diagnostic.js";
import { MemoryStoreQuota } from "../../components/memory-store-quota.js";
import type { MemoryToolDependenciesHolder } from "../../components/memory-store-quota.js";
import { setUserRegistryOverride } from "../../components/user-registry.js";
import type { MemoryConfig, InstantStoreParams } from "abmind";
import { MEMORY_CONFIG_DEFAULTS } from "abmind";

describe("#1659 memory mutation recovery integration", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  let db: BetterSqlite3Database;
  let service: AbmindService;
  let endpoint: LocalEndpointServer;
  let transport: LocalTransport;
  let client: AbmindClient;
  let runtime: AbtarsMemoryRuntime;
  let quota: MemoryStoreQuota;
  let holder: MemoryToolDependenciesHolder;
  let savedOwner: string | undefined;

  beforeAll(async () => {
    // #1658/#1660: abmind's Master-only gate resolves the primary owner from
    // ABMIND_USER_ID; this suite stores as local-user, so pin it explicitly
    // instead of inheriting whatever the host manifest resolves.
    savedOwner = process.env["ABMIND_USER_ID"];
    process.env["ABMIND_USER_ID"] = "local-user";
    tmpDir = mkdtempSync(join(tmpdir(), "abtars-mutation-integration-"));
    const config: MemoryConfig = { ...MEMORY_CONFIG_DEFAULTS, memoryDir: join(tmpDir, "memory") };
    manager = new MemoryManager(config);
    await manager.initialize();
    const rawDb = (manager as unknown as { db: BetterSqlite3Database | null }).db;
    if (rawDb === null) throw new Error("manager database not initialized");
    db = rawDb;

    service = new AbmindService({
      serverInstanceId: "integration", mode: "daemon", manager,
      operational: null, requestLedgerDb: db,
    });
    const socketPath = join(tmpDir, "memory.sock");
    endpoint = new LocalEndpointServer({ socketPath, service, principalMapping: "self" });
    await endpoint.start();

    transport = new LocalTransport(socketPath);
    client = new AbmindClient(transport);
    await client.negotiate();
    runtime = createClientRuntime(client);

    quota = new MemoryStoreQuota({ dbPath: join(tmpDir, "quota.db"), limit: 20 });
    holder = { current: { runtime, quota } };
    setUserRegistryOverride({
      users: [{ userId: "local-user", role: "master", maxClass: 1, tools: [], platforms: {} }],
      byPlatformId: new Map(),
      byUserId: new Map([["local-user", { userId: "local-user", role: "master", maxClass: 1, tools: [], platforms: {} }]]),
    });
  });

  afterAll(async () => {
    setUserRegistryOverride(null);
    await client.close();
    await endpoint.stop();
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedOwner === undefined) delete process.env["ABMIND_USER_ID"];
    else process.env["ABMIND_USER_ID"] = savedOwner;
  });

  function storeContext() {
    return { userId: "local-user", sessionType: "A" as const, memoryToolDeps: holder };
  }

  it("memory_store stores a memory through the real composition", async () => {
    const result = JSON.parse(await executeToolCall(
      "memory_store",
      { translated: `Integration store ${Date.now()}`, type: "fact" },
      storeContext(),
    ));
    expect(result.stored).toBe(true);
    expect(result.memoryId).toBeGreaterThan(0);
    expect(result.semanticRevision).toBe(1);
  });

  it("invalid input projects a structured validation failure through tool JSON and diagnostic", async () => {
    const result = JSON.parse(await executeToolCall(
      "memory_store",
      { translated: "", type: "fact" },
      storeContext(),
    ));
    expect(result.stored).toBe(false);
    expect(result).toMatchObject({
      code: "memory_validation",
      retryable: false,
      action: "fix_input",
      stage: "pre_dispatch",
    });
    expect(typeof result.message).toBe("string");
    expect(typeof result.requestId).toBe("string");

    const diagnostic = parseToolResultToDiagnostic(JSON.stringify(result), "exec-1", "memory_store");
    expect(diagnostic).not.toBeNull();
    expect(diagnostic!.reason).toBe("memory_validation");
    expect(diagnostic!.memory_failure).toMatchObject({
      code: "memory_validation", retryable: false, action: "fix_input", stage: "pre_dispatch",
    });
  });

  it("a stale revision edit projects memory_conflict with re_recall", async () => {
    const stored = JSON.parse(await executeToolCall(
      "memory_store",
      { translated: `Conflict target ${Date.now()}`, type: "fact" },
      storeContext(),
    )) as { memoryId: number; semanticRevision: number };

    const firstEdit = JSON.parse(await executeToolCall(
      "memory_edit",
      { memory_id: String(stored.memoryId), expected_revision: String(stored.semanticRevision), translated: "edited once" },
      storeContext(),
    ));
    expect(firstEdit.ok).toBe(true);

    const staleEdit = JSON.parse(await executeToolCall(
      "memory_edit",
      { memory_id: String(stored.memoryId), expected_revision: String(stored.semanticRevision), translated: "stale edit" },
      storeContext(),
    ));
    expect(staleEdit.ok).toBe(false);
    expect(staleEdit).toMatchObject({
      code: "memory_conflict",
      retryable: false,
      action: "re_recall",
      stage: "pre_dispatch",
    });
    expect(typeof staleEdit.requestId).toBe("string");
  });

  it("a response-lost committed store is recovered by exact-key replay through the real client", async () => {
    const { AbmindClientError } = await import("abmind");
    // Real replay path: same key twice on the real ledger executes once.
    const key = `integration-replay-${Date.now()}`;
    const payload: InstantStoreParams = {
      userId: "local-user",
      contentEn: `Replay probe ${Date.now()}`,
      contentOriginal: `Replay probe ${Date.now()}`,
      memoryType: "fact",
      emotionScore: 0,
      confidence: 3,
      classification: 1,
    };
    const first = await client.privateMemory.instantStore(payload, key);
    const second = await client.privateMemory.instantStore(payload, key);
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(true);
    if (first.stored && second.stored) {
      expect(second.memoryId).toBe(first.memoryId);
    }
    const rows = db.prepare("SELECT COUNT(*) AS n FROM extracted_memories WHERE content_en = ?").get(payload.contentEn) as { n: number };
    expect(rows.n).toBe(1);

    // A replay of an already-completed key is indistinguishable from success;
    // a changed payload under the same key must fail closed as a conflict.
    const changed = await client.privateMemory.instantStore(
      { ...payload, contentEn: `${payload.contentEn} changed` },
      key,
    ).then(() => null, (e: unknown) => e);
    expect(changed).toBeInstanceOf(AbmindClientError);
    const conflict = changed as import("abmind").AbmindClientError;
    expect(conflict.code).toBe("idempotency_conflict");
    expect(conflict.action).toBe("stop");
  });
});
