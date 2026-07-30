import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../guardrails.js", () => ({
  checkCommand: () => null,
  classifyCommand: () => "allow",
}));
import { isBridgeSpawnCommand, getToolDefinitions, getToolSchemas, executeToolCall, setMemoryRuntime } from "./tool-registry.js";
import { createClientRuntime } from "../memory-runtime.js";
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

// #1266/#1507: when no memory runtime is wired, memory_* tools return
// clear non-retryable results rather than shelling out to a CLI on PATH.
describe("memory tools with no runtime wired (#1266 / #1507)", () => {
  beforeEach(() => {
    setMemoryRuntime(null);
  });

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
    const result = await tool!.execute({ translated: "x", type: "fact" });
    const parsed = JSON.parse(result);
    expect(parsed.code).toBe("private_write_unavailable");
    expect(parsed.retryable).toBe(false);
    expect(parsed.stored).toBe(false);
  });

  it("memory_edit returns private_write_unavailable, no RPC", async () => {
    const tool = getToolDefinitions().find(t => t.name === "memory_edit");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ memory_id: "1" });
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

// #1507: production-boundary regression — capability-aware memory writes
describe("memory tools with runtime wired (#1507)", () => {
  afterEach(() => {
    setMemoryRuntime(null);
    setUserRegistryOverride(null);
  });

  describe("private_write=false", () => {
    const client = mockAbmindClient({
      methods: [
        "private.recall", "private.recordMessage", "private.instantStore", "private.edit",
        "private.rebuildFts", "private.recordFeedback", "private.getCoreKnowledge", "private.getRuntimeStatus",
      ],
      features: { private_read: "true", private_write: "false" },
    });

    function makeTestUserRegistry() {
      return {
        users: [{ userId: "master-1", role: "master" as const, maxClass: 1, tools: [], platforms: {} }],
        byPlatformId: new Map(),
        byUserId: new Map([["master-1", { userId: "master-1", role: "master" as const, maxClass: 1, tools: [], platforms: {} }]]),
      };
    }

    beforeEach(() => {
      vi.clearAllMocks();
      setUserRegistryOverride(makeTestUserRegistry());
      const rt = createClientRuntime(client);
      setMemoryRuntime(rt);
    });

    it("memory_store returns private_write_unavailable, no RPC", async () => {
      const result = await executeToolCall("memory_store", { translated: "user likes apples", type: "preference", classification: "1" });
      const parsed = JSON.parse(result);
      expect(parsed.code).toBe("private_write_unavailable");
      expect(parsed.retryable).toBe(false);
      expect(parsed.stored).toBe(false);
      expect(client.privateMemory.instantStore).not.toHaveBeenCalled();
    });

    it("three distinct memory_store calls all return unavailable and consume no cap", async () => {
      for (const content of ["user likes apples", "user hates oranges", "user prefers tea"]) {
        const result = await executeToolCall("memory_store", { translated: content, type: "fact" });
        const parsed = JSON.parse(result);
        expect(parsed.code).toBe("private_write_unavailable");
      }
      expect(client.privateMemory.instantStore).not.toHaveBeenCalled();
    });

    it("memory_edit returns private_write_unavailable, no RPC", async () => {
      const result = await executeToolCall("memory_edit", { memory_id: "1", translated: "updated" });
      const parsed = JSON.parse(result);
      expect(parsed.code).toBe("private_write_unavailable");
      expect(parsed.retryable).toBe(false);
      expect(client.privateMemory.editMemory).not.toHaveBeenCalled();
    });

    it("memory_recall still dispatches", async () => {
      const result = await executeToolCall("memory_recall", { query: "apples" });
      const parsed = JSON.parse(result);
      expect(parsed.hits).toBeDefined();
      expect(client.privateMemory.recall).toHaveBeenCalledTimes(1);
    });

    it("recordMessage still works (automatic capture unaffected)", async () => {
      const rt = createClientRuntime(client);
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

    function makeTestUserRegistry() {
      return {
        users: [{ userId: "master-1", role: "master" as const, maxClass: 1, tools: [], platforms: {} }],
        byPlatformId: new Map(),
        byUserId: new Map([["master-1", { userId: "master-1", role: "master" as const, maxClass: 1, tools: [], platforms: {} }]]),
      };
    }

    beforeEach(() => {
      vi.clearAllMocks();
      setUserRegistryOverride(makeTestUserRegistry());
      const rt = createClientRuntime(client);
      setMemoryRuntime(rt);
    });

    it("memory_store dispatches normally", async () => {
      const result = await executeToolCall("memory_store", { translated: "user likes apples", type: "preference" });
      const parsed = JSON.parse(result);
      expect(parsed.stored).toBe(true);
      expect(client.privateMemory.instantStore).toHaveBeenCalledTimes(1);
    });

    it("memory_edit dispatches normally", async () => {
      const result = await executeToolCall("memory_edit", { memory_id: "1", expected_revision: "1", translated: "updated" });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(client.privateMemory.editMemory).toHaveBeenCalledTimes(1);
    });

    it("genuine store error still produces generic error result", async () => {
      client.privateMemory.instantStore = vi.fn().mockRejectedValue(new Error("disk full"));
      const result = await executeToolCall("memory_store", { translated: "test", type: "fact" });
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/disk full/);
    });

    it("genuine edit error still produces generic error result", async () => {
      client.privateMemory.editMemory = vi.fn().mockRejectedValue(new Error("not found"));
      const result = await executeToolCall("memory_edit", { memory_id: "999", expected_revision: "1" });
      const parsed = JSON.parse(result);
      expect(parsed.error).toMatch(/not found/);
    });

    it("FTS corruption rebuild/retry occurs when rebuildFts is advertised", async () => {
      const storeSpy = vi.fn()
        .mockRejectedValueOnce(new Error("fts5: disk I/O error"))
        .mockResolvedValueOnce({ stored: true, memoriesCount: 1 });
      client.privateMemory.instantStore = storeSpy;
      client.privateMemory.rebuildFtsIndexes = vi.fn().mockResolvedValue({ rebuilt: ["memories"] });

      const result = await executeToolCall("memory_store", { translated: "test", type: "fact" });
      const parsed = JSON.parse(result);
      expect(parsed.stored).toBe(true);
      expect(client.privateMemory.rebuildFtsIndexes).toHaveBeenCalledTimes(1);
      expect(client.privateMemory.instantStore).toHaveBeenCalledTimes(2);
    });
  });
});
