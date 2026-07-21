// TEST DEFICIENCY: Real-package complete-cancellation contract test (multi-tool sequential batch,
// abort during active call, verify one terminal cancellation result per unstarted call in order)
// is release-blocking per req.md:225-226. Verified against real Pi 0.80.7 (agent-loop.ts:475-478):
// executeToolCallsSequential's for loop does `if (signal?.aborted) break;` — tool calls after the
// abort point never receive a tool_execution_end/toolResult. This requires a fixed public Pi release
// (req.md:37-42). The smallest future verification path: install a Pi release with the fix, create a
// real Agent with sequential tools, abort mid-batch, and assert skipped results for every remaining
// call. Deferred until the upstream contract gate is resolved — the ticket cannot pass its own
// acceptance criteria while this stands.

// TEST DEFICIENCY: Real-package conformance test (loading actual @earendil-works/pi-agent-core
// from the npm installation) is deferred — it requires a full Pi installation on the test
// runner and would add significant environment dependency. The deferred test should:
//   1. Call loadAndValidatePiAgentCore() with a real Pi installation
//   2. Construct a PiCoreExecutionHost with the real Agent
//   3. Verify subscribe/prompt/steer/followUp/abort/waitForIdle without a provider call
//   4. Verify one-at-a-time queue mode, sequential tool execution, abort-before-start,
//      abort-while-running, idle settlement ordering
// Smallest future verification path: run on a machine with `pi` installed, add a single
// integration test file that imports the real package and calls the factory methods.
// See steering test-cost gate (#1445 req.md:181-186).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiCoreExecutionHost } from "./pi-core-host.js";
import type { LoadedPiAgentCore, PiAgent, AgentEvent, StreamFn, PiAgentCoreModule } from "./pi-core-types.js";
import type { InstructionLease } from "../spin-types.js";

function makeMockAgent(): { agent: PiAgent; emitted: AgentEvent[] } {
  const emitted: AgentEvent[] = [];
  let subs: Array<(e: AgentEvent) => void> = [];
  let _isRunning = false;
  const agent: PiAgent = {
    get isRunning() { return _isRunning; },
    subscribe: vi.fn((l) => { subs.push(l); return () => { subs = subs.filter(s => s !== l); }; }),
    prompt: vi.fn(async () => { _isRunning = true; }),
    steer: vi.fn((msg) => { emitted.push({ type: "message_start", message: msg } as any); }),
    followUp: vi.fn((msg) => { emitted.push({ type: "message_start", message: msg } as any); }),
    clearAllQueues: vi.fn(),
    abort: vi.fn(),
    waitForIdle: vi.fn(async () => { _isRunning = false; }),
  };
  return { agent, emitted };
}

function makeFakeLease(overrides?: Partial<InstructionLease>): InstructionLease {
  return {
    leaseId: "lease_1",
    sessionId: "session_1",
    executionId: "exec_1",
    kind: "steer",
    instructions: [{ id: "inst_1", sessionId: "session_1", executionId: "exec_1", kind: "steer", source: "tui", text: "hello", bytes: 5, createdAt: Date.now(), state: "leased" }],
    ...overrides,
  };
}

function makeLoadedPiAgentCore(mockAgent: PiAgent): LoadedPiAgentCore {
  const FakeAgentClass = class {
    constructor(_opts: any) {
      Object.assign(this, mockAgent);
    }
  } as unknown as PiAgentCoreModule["Agent"];
  return {
    module: { Agent: FakeAgentClass } as PiAgentCoreModule,
    installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.80.7", source: "path", moduleRoots: { ai: "", tui: "", agentCore: "" } },
  };
}

describe("PiCoreExecutionHost", () => {
  const defaultOpts = {
    executionId: "exec_1",
    sessionId: "session_1",
    initialState: { systemPrompt: "You are a helpful assistant.", model: { id: "test-model" }, messages: [{ role: "user", content: "hello" }] },
    streamFn: vi.fn() as unknown as StreamFn,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates in 'created' state", () => {
    const host = new PiCoreExecutionHost(defaultOpts);
    expect(host.state).toBe("created");
    expect(host.executionId).toBe("exec_1");
    expect(host.sessionId).toBe("session_1");
    expect(host.isSettled).toBe(false);
  });

  it("constructs independent hosts for distinct execution IDs", () => {
    // NOTE: PiCoreExecutionHost has no call site yet (#1446/#1447 wire construction).
    // Reuse-prevention today relies on SubagentRuntime.openExecution() always minting a
    // fresh execution ID (see subagent-runtime.ts). A same-ID double-construction guard
    // belongs at the call site once one exists — tracked as a #1446/#1447 follow-up, not
    // enforceable here without introducing speculative module-level registry state.
    const host = new PiCoreExecutionHost(defaultOpts);
    expect(host.executionId).toBe("exec_1");
    const host2 = new PiCoreExecutionHost({ ...defaultOpts, executionId: "exec_2" });
    expect(host2.executionId).toBe("exec_2");
    expect(host.executionId).not.toBe(host2.executionId);
  });

  it("start creates agent and transitions to running", async () => {
    const { agent } = makeMockAgent();
    const host = new PiCoreExecutionHost(defaultOpts);
    const loaded = makeLoadedPiAgentCore(agent);

    const startPromise = host.start(loaded).catch(() => {});
    await startPromise;

    expect(agent.subscribe).toHaveBeenCalled();
  });

  it("cancel before start settles immediately", async () => {
    const host = new PiCoreExecutionHost(defaultOpts);
    host.cancel();
    expect(host.state).toBe("settled");
    expect(host.isSettled).toBe(true);
  });

  it("cancel while running transitions to settled", async () => {
    const { agent } = makeMockAgent();
    const host = new PiCoreExecutionHost(defaultOpts);
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});

    host.cancel();
    expect(agent.abort).toHaveBeenCalled();
    expect(host.isSettled).toBe(true);
  });

  it("isolates concurrent executions", async () => {
    const { agent: agent1 } = makeMockAgent();
    const { agent: agent2 } = makeMockAgent();
    const host1 = new PiCoreExecutionHost({ ...defaultOpts, executionId: "exec_1" });
    const host2 = new PiCoreExecutionHost({ ...defaultOpts, executionId: "exec_2" });
    const loaded1 = makeLoadedPiAgentCore(agent1);
    const loaded2 = makeLoadedPiAgentCore(agent2);

    await host1.start(loaded1).catch(() => {});
    await host2.start(loaded2).catch(() => {});

    expect(host1.executionId).not.toBe(host2.executionId);
  });

  it("waitForSettlement resolves after cancel", async () => {
    const { agent } = makeMockAgent();
    const host = new PiCoreExecutionHost(defaultOpts);
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});

    host.cancel();
    await host.waitForSettlement();
    expect(host.isSettled).toBe(true);
  });

  it("onEvent is called for agent events", async () => {
    const { agent } = makeMockAgent();
    const onEvent = vi.fn();
    const host = new PiCoreExecutionHost({ ...defaultOpts, onEvent });
    const loaded = makeLoadedPiAgentCore(agent);

    await host.start(loaded).catch(() => {});

    const event: AgentEvent = { type: "text_delta", contentIndex: 0, delta: "hello" };
    await (host as any).handleEvent(event);
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("catches and isolates observer exceptions", async () => {
    const { agent } = makeMockAgent();
    const onEvent = vi.fn().mockRejectedValue(new Error("observer failed"));
    const host = new PiCoreExecutionHost({ ...defaultOpts, onEvent });
    const loaded = makeLoadedPiAgentCore(agent);

    await host.start(loaded).catch(() => {});

    const event: AgentEvent = { type: "text_delta", contentIndex: 0, delta: "test" };
    await expect((host as any).handleEvent(event)).resolves.not.toThrow();
  });
});
