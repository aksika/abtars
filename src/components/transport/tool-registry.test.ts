import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../guardrails.js", () => ({
  checkCommand: () => null,
  classifyCommand: () => "allow",
}));
import { isBridgeSpawnCommand, getToolDefinitions, getToolSchemas, executeToolCall, getToolDescriptor } from "./tool-registry.js";
import { createClientRuntime } from "../memory-runtime.js";
import { MemoryStoreQuota } from "../memory-store-quota.js";
import { resolveNativeDep } from "../../utils/lazy-require.js";
import type { MemoryToolDependenciesHolder } from "../memory-store-quota.js";
import { setUserRegistryOverride } from "../user-registry.js";

function mockAbmindClient(caps: { methods: string[]; features: Record<string, string> }) {
  const { AbmindClient } = {} as any;
  const client = {
    capabilities: { version: 1, methods: caps.methods, domains: ["system", "private"], features: caps.features },
    privateMemory: {
      recordMessage: vi.fn().mockResolvedValue({ id: 42 }),
      recall: vi.fn().mockResolvedValue({ results: [] }),
      instantStore: vi.fn().mockResolvedValue({ stored: true, memoriesCount: 1 }),
      editMemory: vi.fn().mockResolvedValue({ ok: true }),
      rebuildFtsIndexes: vi.fn().mockResolvedValue({ rebuilt: [] }),
      assembleSessionContext: vi.fn().mockResolvedValue({ wakeUp: "", recall: "", coreKnowledge: "", soulBundle: { soul: "", profile: "", notes: "", memoryTools: "", coreFacts: "" } }),
      getRecentConversation: vi.fn().mockResolvedValue([]),
      getRuntimeStatus: vi.fn().mockResolvedValue(null),
      getCoreKnowledge: vi.fn().mockResolvedValue(""),
      recordFeedback: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockResolvedValue({ vectors: [], model: "" }),
    },
  } as unknown as import("abmind").AbmindClient;
  return client;
}

describe("isBridgeSpawnCommand", () => {
  it.each([
    "node current/dist/main.js --all --web --agent",
    "node /Users/akos/.abtars/current/dist/main.js",
    "nohup node dist/main.js &",
    "~/.abtars/abtars.sh --all --web",
    "bash /Users/user/.abtars/watchdog.sh --all",
    "./watchdog.sh",
    "launchctl load ~/Library/LaunchAgents/com.abtars.my-agent.plist",
    "launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.abtars.watchdog.plist",
    "launchctl kickstart -k gui/501/com.abtars.watchdog",
    "launchctl start com.abtars.watchdog",
  ])("blocks bridge-spawn command: %s", (cmd) => {
    expect(isBridgeSpawnCommand(cmd)).toBe(true);
  });

  it.each([
    "ls ~/.abtars/",
    "cat bridge.lock",
    "ps aux | grep node",
    "tail -f logs/bridge.log",
    "launchctl list | grep abtars",
    "launchctl unload ~/Library/LaunchAgents/com.abtars.my-agent.plist",
    "launchctl print gui/501/com.abtars.watchdog",
    "git log --oneline",
    "echo main is the branch",
  ])("allows safe command: %s", (cmd) => {
    expect(isBridgeSpawnCommand(cmd)).toBe(false);
  });
});

describe("getToolDefinitions", () => {
  it("returns a non-empty array of tools", () => {
    const tools = getToolDefinitions();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("every tool has name, description, parameters, and execute", () => {
    for (const tool of getToolDefinitions()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("includes core tools (bash, memory_store, memory_recall)", () => {
    const names = getToolDefinitions().map(t => t.name);
    expect(names).toContain("execute_bash");
    expect(names).toContain("memory_store");
    expect(names).toContain("memory_recall");
  });
});

describe("getToolDescriptor (#1535 preflight registry boundary)", () => {
  it("returns a descriptor for every registered tool", () => {
    for (const tool of getToolDefinitions()) {
      expect(getToolDescriptor(tool.name)).toBe(tool);
    }
  });

  it("returns undefined for an unregistered tool", () => {
    expect(getToolDescriptor("web_browse")).toBeUndefined();
    expect(getToolDescriptor("does_not_exist")).toBeUndefined();
  });
});

describe("getToolSchemas", () => {
  it("returns OpenAI-compatible function schemas", () => {
    const schemas = getToolSchemas();
    expect(schemas.length).toBeGreaterThan(0);
    for (const s of schemas) {
      expect(s.type).toBe("function");
      expect(s.function.name).toBeTruthy();
      expect(s.function.description).toBeTruthy();
      expect(s.function.parameters).toBeDefined();
    }
  });

  it("schema count matches tool definitions count", () => {
    expect(getToolSchemas().length).toBe(getToolDefinitions().length);
  });
});

describe("executeToolCall", () => {
  it("returns error JSON for unknown tool", async () => {
    const result = await executeToolCall("nonexistent_tool", {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Unknown tool");
  });

  it("runs bash inside an explicit task scope without mutating the parent environment (#1502 Task 10)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "abtars-task-scope-"));
    const before = process.env["WORKSPACE"];
    try {
      delete process.env["WORKSPACE"];
      const result = await executeToolCall("execute_bash", {
        command: "printf '%s\\n%s\\n' \"$PWD\" \"$WORKSPACE\"",
      }, {
        userId: "test",
        executionScope: { cwd, env: Object.freeze({ WORKSPACE: cwd }) },
      });
      const parsed = JSON.parse(result) as { exit_code: number; stdout: string };
      expect(parsed.exit_code).toBe(0);
      expect(parsed.stdout.trim().split("\n")).toEqual([cwd, cwd]);
      expect(process.env["WORKSPACE"]).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env["WORKSPACE"];
      else process.env["WORKSPACE"] = before;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("shell syntax pre-validation (#1595)", () => {
  it("rejects a malformed trailing 2>& without executing, with a correction hint and untouched audit fields", async () => {
    const result = await executeToolCall("execute_bash", { command: "tail -f /var/log/x 2>&" }, { userId: "test" });
    const parsed = JSON.parse(result) as {
      error?: string; exit_code?: number; syntax_hint?: string;
      command_fingerprint?: string; command_preview?: string; stderr?: string;
    };
    expect(parsed.error).toBe("shell_syntax_error");
    expect(parsed.exit_code).toBe(2);
    expect(parsed.syntax_hint).toContain("2>&1");
    expect(parsed.command_preview).toBe("tail -f /var/log/x 2>&");
    expect(parsed.command_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.stderr).toContain("syntax error");
  });

  it("does not run side effects from a syntactically invalid command", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "abtars-syntax-side-effect-"));
    const marker = join(cwd, "must-not-exist");
    try {
      const result = await executeToolCall("execute_bash", {
        command: `printf touched > ${JSON.stringify(marker)} 2>&`,
      }, { userId: "test", executionScope: { cwd, env: Object.freeze({}) } });
      expect(JSON.parse(result)).toMatchObject({ error: "shell_syntax_error" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects other malformed syntax with a structured error and no execution side effect", async () => {
    const result = await executeToolCall("execute_bash", { command: "echo 'unterminated" }, { userId: "test" });
    const parsed = JSON.parse(result) as { error?: string };
    expect(parsed.error).toBe("shell_syntax_error");
  });

  it("does not emit the 2>&1 hint for truncations that are not stderr redirects", async () => {
    const result = await executeToolCall("execute_bash", { command: "echo hi >" }, { userId: "test" });
    const parsed = JSON.parse(result) as { error?: string; syntax_hint?: string };
    expect(parsed.error).toBe("shell_syntax_error");
    expect(parsed.syntax_hint).toBeUndefined();
  });

  it("does not guess a correction for the out-of-scope 1>& family", async () => {
    const result = await executeToolCall("execute_bash", { command: "echo hi 1>&" }, { userId: "test" });
    const parsed = JSON.parse(result) as { error?: string; syntax_hint?: string };
    expect(parsed.error).toBe("shell_syntax_error");
    expect(parsed.syntax_hint).toBeUndefined();
  });

  it("still executes valid redirects unchanged (2>&1, 2>&2, 2>&-)", async () => {
    for (const suffix of ["2>&1", "2>&2", "2>&-"]) {
      const result = await executeToolCall("execute_bash", { command: `echo ok ${suffix} >/dev/null` }, { userId: "test" });
      const parsed = JSON.parse(result) as { error?: string; exit_code?: number };
      expect(parsed.error).toBeUndefined();
      expect(parsed.exit_code).toBe(0);
    }
  });

  it("does not rewrite quoted or heredoc content", async () => {
    const result = await executeToolCall("execute_bash", { command: "cat << 'EOF'\n2>& is literal text here\nEOF" }, { userId: "test" });
    const parsed = JSON.parse(result) as { exit_code?: number; stdout?: string };
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout).toContain("2>& is literal text here");
  });

  it("does not rewrite commands whose syntax is valid even with redirects mid-command", async () => {
    const result = await executeToolCall("execute_bash", { command: "echo a > /tmp/x 2>&1; echo done" }, { userId: "test" });
    const parsed = JSON.parse(result) as { exit_code?: number; stdout?: string };
    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout).toContain("done");
  });
});

// #1266/#1507: when no memory runtime is wired, memory_* tools return
// clear non-retryable results rather than shelling out to a CLI on PATH.
// #1552: a Main execution with a null dependency holder fails closed.
describe("memory tools with no runtime wired (#1266 / #1507)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function storeContext(): { userId: string; sessionType: "A"; memoryToolDeps: MemoryToolDependenciesHolder } {
    return { userId: "u1", sessionType: "A", memoryToolDeps: { current: null } };
  }

  it("memory_recall returns backend-not-initialized error, no shell-out", async () => {
    const tool = getToolDefinitions().find(t => t.name === "memory_recall");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ query: "anything" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/memory backend not initialized/);
  });

  it("memory_store returns private_write_unavailable, no RPC", async () => {
    const tool = getToolDefinitions().find(t => t.name === "memory_store");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ translated: "x", type: "fact" }, storeContext());
    const parsed = JSON.parse(result);
    expect(parsed.code).toBe("private_write_unavailable");
    expect(parsed.retryable).toBe(false);
    expect(parsed.stored).toBe(false);
  });

  it("memory_edit returns private_write_unavailable, no RPC", async () => {
    const tool = getToolDefinitions().find(t => t.name === "memory_edit");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ memory_id: "1" }, storeContext());
    const parsed = JSON.parse(result);
    expect(parsed.code).toBe("private_write_unavailable");
    expect(parsed.retryable).toBe(false);
  });

  it("executeToolCall routes to the same null-runtime path", async () => {
    const result = await executeToolCall("memory_recall", { query: "x" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/memory backend not initialized/);
  });
});

// #1507: production-boundary regression — capability-aware memory writes.
// #1552: Main (A) stores run through the durable quota; runtime + quota are
// read from the execution context's late-bound holder, never module globals.
describe("memory tools with runtime wired (#1507)", () => {
  let quotaDir: string;
  let quota: MemoryStoreQuota;
  let holder: MemoryToolDependenciesHolder;

  beforeEach(() => {
    vi.clearAllMocks();
    quotaDir = mkdtempSync(join(tmpdir(), "abtars-tool-quota-"));
    quota = new MemoryStoreQuota({ dbPath: join(quotaDir, "quota.db") });
    holder = { current: null as unknown as NonNullable<MemoryToolDependenciesHolder["current"]> };
  });

  afterEach(() => {
    quota.close();
    rmSync(quotaDir, { recursive: true, force: true });
    holder.current = null;
    setUserRegistryOverride(null);
  });

  function wire(client: unknown): void {
    holder.current = { runtime: createClientRuntime(client as never), quota };
  }

  function storeContext(): { userId: string; sessionType: "A"; memoryToolDeps: MemoryToolDependenciesHolder } {
    return { userId: "master-1", sessionType: "A", memoryToolDeps: holder };
  }

  function makeTestUserRegistry() {
    return {
      users: [{ userId: "master-1", role: "master" as const, maxClass: 1, tools: [], platforms: {} }],
      byPlatformId: new Map(),
      byUserId: new Map([["master-1", { userId: "master-1", role: "master" as const, maxClass: 1, tools: [], platforms: {} }]]),
    };
  }

  function countQuotaRows(): number {
    const Database = resolveNativeDep("better-sqlite3") as new (p: string) => {
      prepare(sql: string): { run(...params: unknown[]): { changes: number }; get<T = Record<string, unknown>>(...params: unknown[]): T | undefined; close(): void };
      close(): void;
    };
    const db = new Database(join(quotaDir, "quota.db"));
    try {
      return db.prepare("SELECT COUNT(*) AS n FROM memory_store_quota_reservations").get().n as number;
    } finally {
      db.close();
    }
  }

  describe("private_write=false", () => {
    const client = mockAbmindClient({
      methods: [
        "private.recall", "private.recordMessage", "private.instantStore", "private.edit",
        "private.rebuildFts", "private.recordFeedback", "private.getCoreKnowledge", "private.getRuntimeStatus",
      ],
      features: { private_read: "true", private_write: "false" },
    });

    beforeEach(() => {
      setUserRegistryOverride(makeTestUserRegistry());
      wire(client);
    });

    it("memory_store returns private_write_unavailable, no RPC", async () => {
      const result = await executeToolCall("memory_store", { translated: "user likes apples", type: "preference", classification: "1" }, storeContext());
      const parsed = JSON.parse(result);
      expect(parsed.code).toBe("private_write_unavailable");
      expect(parsed.retryable).toBe(false);
      expect(parsed.stored).toBe(false);
      expect(client.privateMemory.instantStore).not.toHaveBeenCalled();
    });

    it("three distinct memory_store calls all return unavailable and consume no quota", async () => {
      for (const content of ["user likes apples", "user hates oranges", "user prefers tea"]) {
        const result = await executeToolCall("memory_store", { translated: content, type: "fact" }, storeContext());
        const parsed = JSON.parse(result);
        expect(parsed.code).toBe("private_write_unavailable");
      }
      expect(client.privateMemory.instantStore).not.toHaveBeenCalled();
      expect(countQuotaRows()).toBe(0);
    });

    it("memory_edit returns private_write_unavailable, no RPC", async () => {
      const result = await executeToolCall("memory_edit", { memory_id: "1", translated: "updated" }, storeContext());
      const parsed = JSON.parse(result);
      expect(parsed.code).toBe("private_write_unavailable");
      expect(parsed.retryable).toBe(false);
      expect(client.privateMemory.editMemory).not.toHaveBeenCalled();
    });

    it("memory_recall still dispatches", async () => {
      const result = await executeToolCall("memory_recall", { query: "apples" }, storeContext());
      const parsed = JSON.parse(result);
      expect(parsed.hits).toBeDefined();
      expect(client.privateMemory.recall).toHaveBeenCalledTimes(1);
    });

    it("recordMessage still works (automatic capture unaffected)", async () => {
      const rt = createClientRuntime(client as never);
      const result = await rt.recordMessage({ userId: "u1", sessionId: "s1", role: "user", content: "hi", timestamp: Date.now() }, "k");
      expect(result.id).toBe(42);
      expect(client.privateMemory.recordMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("private_write=true", () => {
    const client = mockAbmindClient({
      methods: [
        "private.recall", "private.recordMessage", "private.instantStore", "private.edit",
        "private.rebuildFts", "private.recordFeedback", "private.getCoreKnowledge", "private.getRuntimeStatus",
      ],
      features: { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" },
    });

    beforeEach(() => {
      setUserRegistryOverride(makeTestUserRegistry());
      wire(client);
    });

    it("memory_store dispatches normally", async () => {
      const result = await executeToolCall("memory_store", { translated: "user likes apples", type: "preference" }, storeContext());
      const parsed = JSON.parse(result);
      expect(parsed.stored).toBe(true);
      expect(client.privateMemory.instantStore).toHaveBeenCalledTimes(1);
    });

    it("memory_edit dispatches normally", async () => {
      const result = await executeToolCall("memory_edit", { memory_id: "1", expected_revision: "1", translated: "updated" }, storeContext());
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(client.privateMemory.editMemory).toHaveBeenCalledTimes(1);
    });

    it("genuine store error still produces generic error result", async () => {
      client.privateMemory.instantStore = vi.fn().mockRejectedValue(new Error("disk full"));
      const result = await executeToolCall("memory_store", { translated: "test", type: "fact" }, storeContext());
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/disk full/);
    });

    it("genuine edit error still produces generic error result", async () => {
      client.privateMemory.editMemory = vi.fn().mockRejectedValue(new Error("not found"));
      const result = await executeToolCall("memory_edit", { memory_id: "999", expected_revision: "1" }, storeContext());
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/not found/);
    });
  });

  describe("memory_store quota (#1552)", () => {
    let client: ReturnType<typeof mockAbmindClient>;

    beforeEach(() => {
      vi.clearAllMocks();
      setUserRegistryOverride(makeTestUserRegistry());
      client = mockAbmindClient({
        methods: [
          "private.recall", "private.recordMessage", "private.instantStore", "private.edit",
          "private.rebuildFts", "private.recordFeedback", "private.getCoreKnowledge", "private.getRuntimeStatus",
        ],
        features: { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" },
      });
      wire(client);
    });

    it("A: 20 stored successes commit; the 21st is rejected with quota_exceeded", async () => {
      for (let i = 0; i < 20; i++) {
        const result = await executeToolCall("memory_store", { translated: `fact ${i}`, type: "fact" }, storeContext());
        expect(JSON.parse(result).stored).toBe(true);
      }
      const limited = JSON.parse(await executeToolCall("memory_store", { translated: "overflow", type: "fact" }, storeContext()));
      expect(limited.stored).toBe(false);
      expect(limited.code).toBe("memory_store_quota_exceeded");
      expect(limited.retryable).toBe(false);
      expect(limited.limit).toBe(20);
      expect(limited.used).toBe(20);
      expect(typeof limited.retry_after).toBe("string");
      expect(limited.retry_after).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(client.privateMemory.instantStore).toHaveBeenCalledTimes(20);
      expect(countQuotaRows()).toBe(20);
    });

    it("A: a stored:false result releases the reservation so it does not count", async () => {
      client.privateMemory.instantStore = vi.fn()
        .mockResolvedValueOnce({ stored: false, error: "rejected by backend" })
        .mockResolvedValueOnce({ stored: true, memoriesCount: 1 });
      const first = JSON.parse(await executeToolCall("memory_store", { translated: "rejected", type: "fact" }, storeContext()));
      expect(first.stored).toBe(false);
      expect(countQuotaRows()).toBe(0);
      const second = JSON.parse(await executeToolCall("memory_store", { translated: "ok", type: "fact" }, storeContext()));
      expect(second.stored).toBe(true);
      expect(countQuotaRows()).toBe(1);
    });

    it("A: a known thrown failure after retry handling releases the reservation", async () => {
      client.privateMemory.instantStore = vi.fn().mockRejectedValue(new Error("disk full"));
      const result = JSON.parse(await executeToolCall("memory_store", { translated: "boom", type: "fact" }, storeContext()));
      expect(result.error).toMatch(/disk full/);
      expect(countQuotaRows()).toBe(0);
    });

    it("A: FTS corruption rebuild/retry stays inside one reservation and commits once", async () => {
      client.privateMemory.instantStore = vi.fn()
        .mockRejectedValueOnce(new Error("fts5: disk I/O error"))
        .mockResolvedValueOnce({ stored: true, memoriesCount: 1 });
      client.privateMemory.rebuildFtsIndexes = vi.fn().mockResolvedValue({ rebuilt: ["memories"] });
      const result = JSON.parse(await executeToolCall("memory_store", { translated: "test", type: "fact" }, storeContext()));
      expect(result.stored).toBe(true);
      expect(client.privateMemory.rebuildFtsIndexes).toHaveBeenCalledTimes(1);
      expect(client.privateMemory.instantStore).toHaveBeenCalledTimes(2);
      expect(countQuotaRows()).toBe(1);
    });

    it("D: more than 20 successful stores create zero quota rows", async () => {
      const dCtx = { ...storeContext(), sessionType: "D" as const };
      for (let i = 0; i < 25; i++) {
        const result = await executeToolCall("memory_store", { translated: `dreamy fact ${i}`, type: "fact" }, dCtx);
        expect(JSON.parse(result).stored).toBe(true);
      }
      expect(client.privateMemory.instantStore).toHaveBeenCalledTimes(25);
      expect(countQuotaRows()).toBe(0);
    });

    it("every non-A/D session type and a missing type is denied at execution time, no RPC", async () => {
      for (const type of ["B", "C", "T", "P", "S", "O", "W", "H", "K", undefined]) {
        const result = await executeToolCall("memory_store", { translated: "x", type: "fact" }, { userId: "master-1", sessionType: type as never, memoryToolDeps: holder });
        const parsed = JSON.parse(result);
        expect(parsed.code).toBe("memory_store_not_allowed");
        expect(parsed.retryable).toBe(false);
      }
      expect(client.privateMemory.instantStore).not.toHaveBeenCalled();
    });

    it("two Main transports for one user share the quota; a second user is independent", async () => {
      for (let i = 0; i < 10; i++) {
        await executeToolCall("memory_store", { translated: `t1 ${i}`, type: "fact" }, storeContext());
      }
      for (let i = 0; i < 10; i++) {
        await executeToolCall("memory_store", { translated: `t2 ${i}`, type: "fact" }, { userId: "master-1", sessionType: "A", memoryToolDeps: holder });
      }
      const third = JSON.parse(await executeToolCall("memory_store", { translated: "third", type: "fact" }, storeContext()));
      expect(third.code).toBe("memory_store_quota_exceeded");
      // A different user starts at zero.
      const other = JSON.parse(await executeToolCall("memory_store", { translated: "other user", type: "fact" }, { userId: "other-user", sessionType: "A", memoryToolDeps: holder }));
      expect(other.stored).toBe(true);
    });

    it("a quota database open failure fails closed with quota_unavailable, no RPC", async () => {
      const blocker = join(quotaDir, "blocker-file");
      writeFileSync(blocker, "not a directory");
      holder.current = { runtime: createClientRuntime(client as never), quota: new MemoryStoreQuota({ dbPath: join(blocker, "q.db") }) };
      const result = JSON.parse(await executeToolCall("memory_store", { translated: "x", type: "fact" }, storeContext()));
      expect(result.stored).toBe(false);
      expect(result.code).toBe("memory_store_quota_unavailable");
      expect(result.retryable).toBe(false);
      expect(client.privateMemory.instantStore).not.toHaveBeenCalled();
    });

    it("holder swap: usage survives reopen and new executions use only the new runtime", async () => {
      const clientA = mockAbmindClient({
        methods: ["private.instantStore"],
        features: { private_write: "true", private_mutation_contract: "revision-v1" },
      });
      holder.current = { runtime: createClientRuntime(clientA as never), quota };
      const first = JSON.parse(await executeToolCall("memory_store", { translated: "a", type: "fact" }, storeContext()));
      expect(first.stored).toBe(true);
      expect(countQuotaRows()).toBe(1);

      // In-process restart: clear the holder, close the prior quota, reopen
      // the same durable DB with a fresh runtime.
      holder.current = null;
      quota.close();
      quota = new MemoryStoreQuota({ dbPath: join(quotaDir, "quota.db") });
      holder.current = { runtime: createClientRuntime(client as never), quota };

      for (let i = 0; i < 19; i++) {
        const result = await executeToolCall("memory_store", { translated: `b ${i}`, type: "fact" }, storeContext());
        expect(JSON.parse(result).stored).toBe(true);
      }
      const limited = JSON.parse(await executeToolCall("memory_store", { translated: "overflow", type: "fact" }, storeContext()));
      expect(limited.code).toBe("memory_store_quota_exceeded");
      expect(clientA.privateMemory.instantStore).toHaveBeenCalledTimes(1);
      expect(client.privateMemory.instantStore).toHaveBeenCalledTimes(19);
      expect(countQuotaRows()).toBe(20);
    });

    it("a null holder returns private_write_unavailable, never a stale runtime", async () => {
      holder.current = null;
      const result = JSON.parse(await executeToolCall("memory_store", { translated: "x", type: "fact" }, storeContext()));
      expect(result.code).toBe("private_write_unavailable");
      expect(client.privateMemory.instantStore).not.toHaveBeenCalled();
    });
  });
});

