import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPiAgentTools } from "./pi-core-tools.js";
import type { PiCoreToolContext } from "./pi-core-tools.js";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
import type { ModelCandidate } from "./model-candidates.js";
import { buildPolicy } from "../tool-sandbox.js";
import { PiCoreToolExecutionError } from "./tool-failure-diagnostic.js";
import type { ToolFailureDiagnosticV1 } from "./tool-failure-diagnostic.js";
import { createClientRuntime } from "../memory-runtime.js";
import type { MemoryToolDependenciesHolder } from "../memory-store-quota.js";
import type { SessionType } from "../spin-types.js";

// #1677: the review-tool rejection envelope carries a `reason` code. Only the
// registry's execution boundary is overridden here (a canned Orc rejection);
// every other tool still routes through the real registry execution path.
vi.mock("./tool-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-registry.js")>();
  return {
    ...actual,
    executeToolCall: vi.fn(async (name: string, params: Record<string, unknown>, context: unknown) => {
      if (name === "review_project") {
        return JSON.stringify({ error: "Project generation mismatch: expected 1, got 2", reason: "project_generation_mismatch" });
      }
      return (actual.executeToolCall as (name: string, params: Record<string, unknown>, context: unknown) => Promise<string>)(name, params, context);
    }),
  };
});

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
  let depsHolder: MemoryToolDependenciesHolder;

  beforeEach(() => {
    registry = makeRegistry();
    policy = new FallbackPolicy([makeCandidate()], registry);
    depsHolder = { current: null };
  });

  afterEach(() => {
    depsHolder.current = null;
  });

  function makeContext(overrides?: Partial<PiCoreToolContext>): PiCoreToolContext {
    return {
      executionId: "exec_1",
      userId: "user_1",
      sandboxPolicy: buildPolicy("owner"),
      safety: createPiExecutionSafetyController(policy),
      memoryToolDeps: depsHolder,
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
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["secret_get"] }),
    });
    const tools = createPiAgentTools(ctx);
    const tool = tools.find((t) => t.name === "secret_get");
    if (tool) {
      const result = await tool.execute("call_1", { name: "missing" });
      expect(typeof result).toBe("object");
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.details).toBeDefined();
    }
  });

  it("calls onToolFailure when tool returns a failure result", async () => {
    const onToolFailure = vi.fn();
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["secret_get"] }),
      onToolFailure,
    });
    const tools = createPiAgentTools(ctx);
    const tool = tools.find((t) => t.name === "secret_get");
    if (tool) {
      await tool.execute("call_1", { name: "missing" });
      expect(onToolFailure).toHaveBeenCalledTimes(1);
      expect(onToolFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "unknown", tool: "secret_get" }),
      );
    }
  });

  it("#1677 delivers the typed Orc rejection reason to onToolFailure, never unknown", async () => {
    const onToolFailure = vi.fn();
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner"),
      onToolFailure,
    });
    const tools = createPiAgentTools(ctx);
    const tool = tools.find((t) => t.name === "review_project");
    expect(tool).toBeDefined();
    if (tool) {
      await tool.execute("call_1", {});
      expect(onToolFailure).toHaveBeenCalledTimes(1);
      expect(onToolFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "project_generation_mismatch", tool: "review_project" }),
      );
      const diag = onToolFailure.mock.calls[0]![0] as ToolFailureDiagnosticV1;
      expect(diag.stderr_excerpt).toContain("Project generation mismatch: expected 1, got 2");
      expect(diag.command_preview).toBeUndefined();
    }
  });

  it("treats repeated unavailable private writes as completed non-failures", async () => {
    const instantStore = vi.fn();
    const client = {
      capabilities: {
        version: 1,
        methods: ["private.instantStore"],
        domains: ["private"],
        features: { private_write: "false" },
      },
      privateMemory: { instantStore },
    } as unknown as import("abmind").AbmindClient;
    depsHolder.current = { runtime: createClientRuntime(client), quota: null as never };

    const onToolFailure = vi.fn();
    const onToolSuccess = vi.fn();
    const tools = createPiAgentTools(makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_store"] }),
      onToolFailure,
      onToolSuccess,
      sessionType: "A",
    }));
    const storeTool = tools.find(tool => tool.name === "memory_store");
    expect(storeTool).toBeDefined();

    for (const [index, translated] of ["one", "two", "three"].entries()) {
      const result = await storeTool!.execute(`call_${index}`, { translated, type: "fact" });
      expect(result.content[0]?.text).toContain('"retryable":false');
    }

    expect(instantStore).not.toHaveBeenCalled();
    expect(onToolFailure).not.toHaveBeenCalled();
    expect(onToolSuccess).toHaveBeenCalledTimes(3);
  });

  // #1552 R1: memory_store is visible to Main (A) and Dreamy (D) only.
  it.each([
    ["B", "Browse"], ["C", "Code"], ["T", "Task"], ["P", "Peer"], ["S", "System"],
    ["O", "Orc"], ["W", "Worker"], ["H", "Healer"], ["K", "Skill"],
  ] as const)("hides memory_store from %s sessions while A and D see it", (type) => {
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_store"] }),
      sessionType: type as SessionType,
    });
    const tools = createPiAgentTools(ctx);
    expect(tools.find(tool => tool.name === "memory_store")).toBeUndefined();
    const aCtx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_store"] }),
      sessionType: "A",
    });
    expect(createPiAgentTools(aCtx).find(tool => tool.name === "memory_store")).toBeDefined();
    const dCtx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_store"] }),
      sessionType: "D",
    });
    expect(createPiAgentTools(dCtx).find(tool => tool.name === "memory_store")).toBeDefined();
  });

  it("hides memory_store when the session type is missing entirely", () => {
    const tools = createPiAgentTools(makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_store"] }),
      sessionType: undefined,
    }));
    expect(tools.find(tool => tool.name === "memory_store")).toBeUndefined();
  });

  it("throws PiCoreToolExecutionError on exact_repeat from beforeTool", async () => {
    const onToolFailure = vi.fn();
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["secret_get"] }),
      onToolFailure,
    });
    const tools = createPiAgentTools(ctx);
    const tool = tools.find((t) => t.name === "secret_get");
    if (tool) {
      await tool.execute("call_1", { name: "dup" });
      await tool.execute("call_2", { name: "dup" });
      await expect(tool.execute("call_3", { name: "dup" }))
        .rejects.toThrow(PiCoreToolExecutionError);
      expect(onToolFailure).toHaveBeenCalledTimes(3);
    }
  });

  it("throws PiCoreToolExecutionError after repeated tool failure", async () => {
    const onToolFailure = vi.fn();
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["send_document"] }),
      onToolFailure,
    });
    const tools = createPiAgentTools(ctx);
    const tool = tools.find((t) => t.name === "send_document");
    if (tool) {
      // Use different args to avoid exact_repeat; afterTool failure detection
      // classifies each error response as a failure, triggering repeated_failure on the 3rd.
      await tool.execute("call_1", { path: "/tmp/one.md" });
      await tool.execute("call_2", { path: "/tmp/two.md" });
      await expect(tool.execute("call_3", { path: "/tmp/three.md" }))
        .rejects.toThrow(PiCoreToolExecutionError);
      expect(onToolFailure).toHaveBeenCalledTimes(3);
    }
  });

  it("skips tool on safety controller skip decision", async () => {
    const safety = createPiExecutionSafetyController(policy);
    const ctx = makeContext({
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["secret_get"] }),
      safety,
    });

    safety.requestStop("test stop");

    const tools = createPiAgentTools(ctx);
    const tool = tools.find((t) => t.name === "secret_get");
    if (tool) {
      const result = await tool.execute("call_1", { name: "hi" });
      expect(result.details).toEqual({ skipped: true });
      expect(result.content[0]?.text).toContain("skipped");
    }
  });

  // #1663: unattended scheduled executions must not see or reach the
  // platform delivery tool. Presentation hiding is a model-behavior aid; the
  // registry execution boundary is the authority (tool-registry.test.ts).
  describe("#1663 send_document availability for unattended scheduled executions", () => {
    const ownerWithSend = () => buildPolicy("owner", { allowedTools: ["send_document", "review_project"] });

    it("hides send_document from an unattended one-shot T execution", () => {
      const tools = createPiAgentTools(makeContext({
        sandboxPolicy: ownerWithSend(),
        sessionType: "T",
        authorizationMode: "unattended-task",
      }));
      expect(tools.find(t => t.name === "send_document")).toBeUndefined();
    });

    it("hides send_document from an unattended scheduled Orc but keeps review_project", () => {
      const tools = createPiAgentTools(makeContext({
        sandboxPolicy: ownerWithSend(),
        sessionType: "O",
        authorizationMode: "unattended-task",
      }));
      expect(tools.find(t => t.name === "send_document")).toBeUndefined();
      expect(tools.find(t => t.name === "review_project")).toBeDefined();
    });

    it("hides send_document from an unattended scheduled Worker W execution", () => {
      const tools = createPiAgentTools(makeContext({
        sandboxPolicy: ownerWithSend(),
        sessionType: "W",
        authorizationMode: "unattended-task",
      }));
      expect(tools.find(t => t.name === "send_document")).toBeUndefined();
    });

    it("hides send_document when scheduled provenance is unverified", () => {
      const tools = createPiAgentTools(makeContext({
        sandboxPolicy: ownerWithSend(),
        sessionType: "T",
        authorizationMode: "unverified",
      }));
      expect(tools.find(t => t.name === "send_document")).toBeUndefined();
    });

    it("keeps send_document for an interactive execution with the same sandbox", () => {
      const tools = createPiAgentTools(makeContext({
        sandboxPolicy: ownerWithSend(),
        sessionType: "T",
        authorizationMode: "interactive",
      }));
      expect(tools.find(t => t.name === "send_document")).toBeDefined();
    });

    it("keeps send_document when the trusted authorization mode is absent (interactive compatibility)", () => {
      const tools = createPiAgentTools(makeContext({
        sandboxPolicy: ownerWithSend(),
        sessionType: "T",
        authorizationMode: undefined,
      }));
      expect(tools.find(t => t.name === "send_document")).toBeDefined();
    });

    it("ignores a forged authorizationMode tool argument — the trusted context wins", async () => {
      const ctx = makeContext({
        sandboxPolicy: ownerWithSend(),
        sessionType: "T",
        authorizationMode: "unattended-task",
      });
      const tools = createPiAgentTools(ctx);
      // The tool is not even presented; proving a forged argument cannot
      // re-introduce it would need the execution boundary, which is covered
      // in tool-registry.test.ts. Here we prove the schema is absent.
      expect(tools.find(t => t.name === "send_document")).toBeUndefined();
    });
  });
});
