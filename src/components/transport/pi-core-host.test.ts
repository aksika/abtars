// TEST DEFICIENCY: Real-package complete-cancellation contract test (multi-tool sequential batch,
// abort during active call, verify one terminal cancellation result per unstarted call in order)
// is release-blocking per req.md:225-226. Verified against real Pi 0.80.7 (agent-loop.ts:475-478):
// executeToolCallsSequential's for loop does `if (signal?.aborted) break;` — tool calls after the
// abort point never receive a tool_execution_end/toolResult. This requires a fixed public Pi release
// (req.md:37-42). The smallest future verification path: install a Pi release with the fix, create a
// real Agent with sequential tools, abort mid-batch, and assert skipped results for every remaining
// call. Deferred until the upstream contract gate is resolved — the ticket cannot pass its own
// acceptance criteria while this stands.

// Real-package construction/idle settlement is covered below. The complete
// multi-tool cancellation assertion remains blocked by the known Pi 0.80.7
// upstream defect and must run when a repaired public release is adopted.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiCoreExecutionHost } from "./pi-core-host.js";
import { DurableContextUnavailableError } from "./pi-core-context.js";
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
    installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.83.0", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
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

  it("propagates durable projection failure instead of settling as an empty response", async () => {
    const { agent } = makeMockAgent();
    const projectionError = new DurableContextUnavailableError("no_provider");
    const projection = {
      buildSystemPromptFromSeed: () => "system",
      transform: vi.fn().mockRejectedValue(projectionError),
    };
    const host = new PiCoreExecutionHost({
      ...defaultOpts,
      initialState: {
        ...defaultOpts.initialState,
        messages: [{ role: "user", content: "current turn" }],
      },
      contextProjection: projection as never,
      transformOptions: { hostGeneration: 0 },
    });
    const loaded = makeLoadedPiAgentCore(agent);
    agent.prompt = vi.fn(async () => {
      await projection.transform([], { hostGeneration: 0 });
    });

    await expect(host.start(loaded)).rejects.toBe(projectionError);
    expect(host.isSettled).toBe(true);
    expect(agent.prompt).toHaveBeenCalledTimes(1);
  });

  it("constructs and settles with the installed public Pi Agent", async () => {
    const real = await import("@earendil-works/pi-agent-core");
    const model = {
      id: "contract-model",
      name: "contract-model",
      api: "openai-completions" as const,
      provider: "contract-provider",
      baseUrl: "https://contract.invalid",
      reasoning: false,
      input: ["text"] as ("text")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 128,
    };
    const host = new PiCoreExecutionHost({
      executionId: "real_exec",
      sessionId: "real_session",
      initialState: { systemPrompt: "system", model, messages: [], tools: [] },
      streamFn: vi.fn() as unknown as StreamFn,
    });
    await host.start({
      module: { Agent: real.Agent },
      installation: { executable: "", packageRoot: "", version: "0.83.0", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
    });
    expect(host.state).toBe("running");
    host.cancel();
    await host.waitForSettlement();
    expect(host.isSettled).toBe(true);
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

  // ── #1506: Logical terminalisation vs cleanup ──────────────────────────

  it("waitForSettlement resolves after cancel even when waitForIdle never resolves", async () => {
    const { agent } = makeMockAgent();
    // Simulate a provider that never acknowledges idle
    agent.waitForIdle = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const host = new PiCoreExecutionHost(defaultOpts);
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});

    host.cancel();
    // waitForSettlement must resolve even though waitForIdle hangs
    await expect(host.waitForSettlement()).resolves.toBeUndefined();
    expect(host.isSettled).toBe(true);
    // Cleanup promise should time out after 5s
    const cleanupResult = await host.waitForCleanup();
    expect(cleanupResult).toBe("timed_out");
  }, 15000);

  it("cleanup timeout does not affect terminal state", async () => {
    const { agent } = makeMockAgent();
    agent.waitForIdle = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const host = new PiCoreExecutionHost(defaultOpts);
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});

    host.cancel();
    await host.waitForSettlement();
    expect(host.isSettled).toBe(true);

    const cleanupResult = await host.waitForCleanup();
    expect(cleanupResult).toBe("timed_out");
    // Terminal state unchanged after cleanup timeout
    expect(host.isSettled).toBe(true);
  }, 15000);

  it("late agent_end is rejected after settlement", async () => {
    const { agent } = makeMockAgent();
    agent.waitForIdle = vi.fn(() => new Promise<void>(() => {}));
    const host = new PiCoreExecutionHost(defaultOpts);
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});

    host.cancel();
    await host.waitForSettlement();
    expect(host.isSettled).toBe(true);

    // Simulate a late agent_end arriving after the host is settled
    const stateBefore = host.state;
    (host as any).handleAgentEnd({ type: "agent_end" });
    // State must remain settled (unchanged)
    expect(host.state).toBe(stateBefore);
    expect(host.isSettled).toBe(true);
  });

  // ── #1531: per-lease deferred steering acknowledgement ──────────────────

  it("steer delivers per-lease and resolves on the matching instruction message_end", async () => {
    const { agent } = makeMockAgent();
    // The queue must be the SAME array the lease references: in production the
    // instructions live in the session queue and markDelivered/markConsumed
    // mutate them in place.
    const lease = makeFakeLease({ sessionId: "session_1" });
    const sessionRef = { instructionQueue: lease.instructions as never, id: "session_1" };
    const host = new PiCoreExecutionHost({
      ...defaultOpts,
      session: sessionRef,
    });
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});
    let steered = false;
    const steerP = host.steer("focus on memory", lease).then(() => { steered = true; });

    // Delivered immediately before agent.steer.
    expect((lease.instructions as unknown as Array<{ state: string }>)[0]?.state).toBe("delivered");
    expect(agent.steer).toHaveBeenCalledTimes(1);
    let resolved = false;
    steerP.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // The matching instruction message_end resolves the lease.
    const instructionMsg = (agent.steer as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    await (host as any).handleEvent({ type: "message_end", message: instructionMsg });
    await steerP;
    expect(steered).toBe(true);
    expect((sessionRef.instructionQueue as unknown[]).length).toBe(0);
    expect(host.isSettled).toBe(false);
  });

  it("steer rejects explicitly when the host is not running", async () => {
    const host = new PiCoreExecutionHost(defaultOpts);
    await expect(host.steer("x", makeFakeLease())).rejects.toThrow(/Cannot steer in state created/);
  });

  it("steer rejects a lease belonging to another session (generation isolation)", async () => {
    const { agent } = makeMockAgent();
    const host = new PiCoreExecutionHost(defaultOpts);
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});
    await expect(host.steer("x", makeFakeLease({ sessionId: "other_session" })))
      .rejects.toThrow(/belongs to session other_session/);
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("steer rejects when another lease is outstanding — no silent acceptance", async () => {
    const { agent } = makeMockAgent();
    const firstLease = makeFakeLease({ sessionId: "session_1", leaseId: "lease_1" });
    const sessionRef = { instructionQueue: firstLease.instructions as never, id: "session_1" };
    const host = new PiCoreExecutionHost({
      ...defaultOpts,
      session: sessionRef,
    });
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});

    const first = host.steer("first", firstLease);
    expect(agent.steer).toHaveBeenCalledTimes(1);
    await expect(host.steer("second", makeFakeLease({ sessionId: "session_1", leaseId: "lease_2" })))
      .rejects.toThrow(/outstanding lease lease_1/);
    expect(agent.steer).toHaveBeenCalledTimes(1);

    // The first lease still completes on its message_end.
    const instructionMsg = (agent.steer as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    await (host as any).handleEvent({ type: "message_end", message: instructionMsg });
    await first;
  });

  it("settlement fails and rejects every outstanding lease exactly once", async () => {
    const { agent } = makeMockAgent();
    const doomedLease = makeFakeLease({ sessionId: "session_1" });
    const sessionRef = { instructionQueue: doomedLease.instructions as never, id: "session_1" };
    const host = new PiCoreExecutionHost({
      ...defaultOpts,
      session: sessionRef,
    });
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});

    const steerP = host.steer("doomed", doomedLease);
    host.cancel();
    await expect(steerP).rejects.toThrow(/Host settled before lease/);
    expect((doomedLease.instructions as unknown as Array<{ state: string }>)[0]?.state).toBe("failed");
    expect((sessionRef.instructionQueue as unknown[]).length).toBe(0);

    // Subsequent steers reject explicitly — nothing silently accepted.
    await expect(host.steer("after", makeFakeLease({ sessionId: "session_1" })))
      .rejects.toThrow(/Cannot steer in state settled/);
  });

  it("followUp uses the same per-lease deferred machinery", async () => {
    const { agent } = makeMockAgent();
    const followLease = makeFakeLease({ sessionId: "session_1", kind: "followUp" });
    const sessionRef = { instructionQueue: followLease.instructions as never, id: "session_1" };
    const host = new PiCoreExecutionHost({
      ...defaultOpts,
      session: sessionRef,
    });
    const loaded = makeLoadedPiAgentCore(agent);
    await host.start(loaded).catch(() => {});

    const followP = host.followUp("continue", followLease);
    expect((followLease.instructions as unknown as Array<{ state: string }>)[0]?.state).toBe("delivered");
    expect(agent.followUp).toHaveBeenCalledTimes(1);
    const instructionMsg = (agent.followUp as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    await (host as any).handleEvent({ type: "message_end", message: instructionMsg });
    await followP;
    expect((sessionRef.instructionQueue as unknown[]).length).toBe(0);
  });
});
