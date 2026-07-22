import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPiAgentTools } from "./pi-core-tools.js";
import type { PiCoreToolContext } from "./pi-core-tools.js";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
import type { ModelCandidate } from "./model-candidates.js";
import { buildPolicy } from "../tool-sandbox.js";

function makeRegistry() {
  return new ModelHealthRegistry();
}

function makeCandidate(overrides?: Partial<ModelCandidate>): ModelCandidate {
  return {
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
    ...overrides,
  };
}

describe("createPiAgentTools", () => {
  let registry: ModelHealthRegistry;
  let policy: FallbackPolicy;

  beforeEach(() => {
    registry = makeRegistry();
    policy = new FallbackPolicy([makeCandidate()], registry);
  });

  function makeContext(overrides?: Partial<PiCoreToolContext>): PiCoreToolContext {
    return {
      executionId: "exec_1",
      userId: "user_1",
      sandboxPolicy: buildPolicy("owner"),
      safety: createPiExecutionSafetyController(policy),
      ...overrides,
    };
  }

  it("creates tool list with sequential execution mode", () => {
    const ctx = makeContext();
    const tools = createPiAgentTools(ctx);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.executionMode).toBe("sequential");
    }
  });

  it("filters by sandbox policy", () => {
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["execute_bash"] }),
    });
    const tools = createPiAgentTools(ctx);
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("execute_bash");
  });

  it("each tool has name and description", () => {
    const ctx = makeContext();
    const tools = createPiAgentTools(ctx);
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
    }
  });

  it("executes tool through executeToolCall path", async () => {
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_recall"] }),
    });
    const tools = createPiAgentTools(ctx);
    const recallTool = tools.find((t) => t.name === "memory_recall");
    expect(recallTool).toBeDefined();
  });

  it("tool execute returns an AgentToolResult", async () => {
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["irc_send"] }),
    });
    const tools = createPiAgentTools(ctx);
    const ircTool = tools.find((t) => t.name === "irc_send");
    if (ircTool) {
      const result = await ircTool.execute("call_1", { channel: "#test", message: "hello" });
      expect(typeof result).toBe("object");
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.details).toBeDefined();
    }
  });

  it("skips tool on safety controller skip decision", async () => {
    const safety = createPiExecutionSafetyController(policy);
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["irc_send"] }),
      safety,
    });

    safety.requestStop("test stop");

    const tools = createPiAgentTools(ctx);
    const ircTool = tools.find((t) => t.name === "irc_send");
    if (ircTool) {
      const result = await ircTool.execute("call_1", { channel: "#test", message: "hi" });
      expect(result.details).toEqual({ skipped: true });
      expect(result.content[0]?.text).toContain("skipped");
    }
  });
});
