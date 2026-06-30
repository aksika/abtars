import { describe, it, expect, beforeEach, vi } from "vitest";
import { isBridgeSpawnCommand, getToolDefinitions, getToolSchemas, executeToolCall, setMemoryBackend } from "./tool-registry.js";

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
});

// #1266: when no in-process memory backend is wired, the memory_* tools
// must return a clear error rather than silently shelling out to a CLI
// on PATH we don't trust.
describe("memory tools with no backend wired (#1266)", () => {
  beforeEach(() => {
    setMemoryBackend(null);
  });

  it("memory_recall returns backend-not-initialized error, no shell-out", async () => {
    const tool = getToolDefinitions().find(t => t.name === "memory_recall");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ query: "anything" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/memory backend not initialized/);
  });

  it("memory_store returns backend-not-initialized error, no shell-out", async () => {
    const tool = getToolDefinitions().find(t => t.name === "memory_store");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ translated: "x", type: "fact" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/memory backend not initialized/);
  });

  it("memory_edit returns backend-not-initialized error, no shell-out", async () => {
    const tool = getToolDefinitions().find(t => t.name === "memory_edit");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ memory_id: "1" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/memory backend not initialized/);
  });

  it("executeToolCall routes to the same null-backend path", async () => {
    const result = await executeToolCall("memory_recall", { query: "x" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/memory backend not initialized/);
  });
});
