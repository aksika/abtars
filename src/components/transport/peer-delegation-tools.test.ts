/**
 * peer-delegation-tools.test.ts — #1357 Pi delegation routing tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockKanbanEnqueue = vi.fn();
const mockKanbanFindRemoteDelegation = vi.fn();
const mockKanbanUpdate = vi.fn();
const mockDelegateTask = vi.fn();
const mockCheckTask = vi.fn();
const mockTerminateTask = vi.fn();
const mockFindCapablePeer = vi.fn();
const mockGetPeerTable = vi.fn();
const mockIsActiveCardPeerSourced = vi.fn();

vi.mock("../tasks/kanban-board.js", () => ({
  kanbanEnqueue: (...args: unknown[]) => mockKanbanEnqueue(...args),
  kanbanFindRemoteDelegation: (...args: unknown[]) => mockKanbanFindRemoteDelegation(...args),
  kanbanUpdate: (...args: unknown[]) => mockKanbanUpdate(...args),
}));

vi.mock("../peer-transport/index.js", () => ({
  getPeerTransport: () => ({
    delegateTask: mockDelegateTask,
    checkTask: mockCheckTask,
    terminateTask: mockTerminateTask,
  }),
}));

vi.mock("../peer-transport/gossip.js", () => ({
  findCapablePeer: (...args: unknown[]) => mockFindCapablePeer(...args),
  getPeerTable: (...args: unknown[]) => mockGetPeerTable(...args),
}));

vi.mock("../spin.js", () => ({
  spin: { createHollowSession: vi.fn() },
}));

vi.mock("../master-user.js", () => ({
  getMasterUserId: () => "master-user",
}));

vi.mock("./orc-tools.js", () => ({
  isActiveCardPeerSourced: () => mockIsActiveCardPeerSourced(),
}));

let mod: typeof import("./peer-delegation-tools.js");

beforeEach(async () => {
  vi.resetModules();
  mockKanbanEnqueue.mockReset().mockReturnValue(42);
  mockKanbanFindRemoteDelegation.mockReset().mockReturnValue(undefined);
  mockKanbanUpdate.mockReset();
  mockDelegateTask.mockReset();
  mockCheckTask.mockReset();
  mockTerminateTask.mockReset();
  mockFindCapablePeer.mockReset();
  mockGetPeerTable.mockReset();
  mockIsActiveCardPeerSourced.mockReset().mockResolvedValue(false);
  mod = await import("./peer-delegation-tools.js");
});

describe("peer_delegate — #1357 Pi delegation", () => {
  it("rejects missing workspace_alias when executor='pi'", async () => {
    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "fix the bug", executor: "pi",
    }));
    expect(result.error).toContain("workspace_alias");
  });

  it("rejects invalid workspace_alias format", async () => {
    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "fix the bug", executor: "pi", workspace_alias: "INVALID_UPPERCASE",
    }));
    expect(result.error).toContain("Invalid workspace_alias");
  });

  it("rejects artifacts with Pi delegation", async () => {
    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "fix the bug", executor: "pi", workspace_alias: "my-workspace",
      artifacts: JSON.stringify([{ name: "f.ts", content: "code" }]),
    }));
    expect(result.error).toContain("not supported");
  });

  it("routes to peer with pi-executor capabilities when executor='pi'", async () => {
    mockDelegateTask.mockResolvedValue({
      taskId: 100, remoteSessionId: "sess-1", executor: "pi",
    });
    mockFindCapablePeer.mockReturnValue({ name: "remote-pi", load: 0.3 });

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "fix the bug", executor: "pi", workspace_alias: "my-ws",
    }));

    expect(result.ok).toBe(true);
    expect(result.executor).toBe("pi");
    expect(result.peer).toBe("remote-pi");
    // Should have looked up pi-executor + workspace:my-ws capability
    expect(mockFindCapablePeer).toHaveBeenCalledWith(
      expect.arrayContaining(["pi-executor", "workspace:my-ws"]),
    );
    // Should have delegated with target
    expect(mockDelegateTask).toHaveBeenCalledWith(
      "remote-pi", "fix the bug",
      expect.objectContaining({
        target: expect.objectContaining({ executor: "pi", workspace_alias: "my-ws" }),
      }),
    );
    // Should have stored pi metadata in kanban notes
    const notesArg = mockKanbanEnqueue.mock.calls[0]?.[3]?.notes;
    expect(notesArg).toBeDefined();
    const notes = JSON.parse(notesArg);
    expect(notes.executor).toBe("pi");
    expect(notes.workspace_alias).toBe("my-ws");
  });

  it("parses model JSON when provided", async () => {
    mockDelegateTask.mockResolvedValue({
      taskId: 101, remoteSessionId: "sess-2", runId: "run-1", generation: 1, executor: "pi",
    });
    mockGetPeerTable.mockReturnValue([
      { name: "pi-host", alive: true, load: 0.5, capabilities: ["pi-executor", "workspace:my-ws"] },
    ]);

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "refactor auth", executor: "pi", workspace_alias: "my-ws",
      peer: "pi-host",
      model: JSON.stringify({ provider: "openai", model_id: "gpt-4", thinking: "high" }),
    }));

    expect(result.ok).toBe(true);
    expect(mockDelegateTask).toHaveBeenCalledWith(
      "pi-host", "refactor auth",
      expect.objectContaining({
        target: expect.objectContaining({
          executor: "pi", workspace_alias: "my-ws",
          model: { provider: "openai", model_id: "gpt-4", thinking: "high" },
        }),
      }),
    );
  });

  it("rejects invalid model JSON", async () => {
    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "refactor auth", executor: "pi", workspace_alias: "my-ws",
      model: "not-json",
    }));
    expect(result.error).toContain("model must be valid JSON");
  });

  it("sets delivery policy when provided", async () => {
    mockDelegateTask.mockResolvedValue({
      taskId: 102, remoteSessionId: "sess-3", executor: "pi",
    });
    mockGetPeerTable.mockReturnValue([
      { name: "pi-host", alive: true, load: 0.5, capabilities: ["pi-executor", "workspace:my-ws"] },
    ]);

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "push fix", executor: "pi", workspace_alias: "my-ws",
      peer: "pi-host", delivery: "commit_push",
    }));

    expect(result.ok).toBe(true);
    expect(mockDelegateTask).toHaveBeenCalledWith(
      "pi-host", "push fix",
      expect.objectContaining({
        target: expect.objectContaining({ delivery: "commit_push" }),
      }),
    );
  });

  it("accepts valid custom requestId", async () => {
    mockDelegateTask.mockResolvedValue({
      taskId: 103, remoteSessionId: "sess-4", executor: "pi",
    });
    mockGetPeerTable.mockReturnValue([
      { name: "pi-host", alive: true, load: 0.5, capabilities: ["pi-executor", "workspace:my-ws"] },
    ]);

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "fix", executor: "pi", workspace_alias: "my-ws",
      peer: "pi-host", request_id: "my-custom-id-42",
    }));

    expect(result.ok).toBe(true);
    expect(mockDelegateTask).toHaveBeenCalledWith(
      "pi-host", "fix",
      expect.objectContaining({ requestId: "my-custom-id-42" }),
    );
  });

  it("rejects invalid requestId characters", async () => {
    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "fix", executor: "pi", workspace_alias: "my-ws",
      request_id: "bad id with spaces!",
    }));
    expect(result.error).toContain("request_id must match");
  });

  it("returns duplicate when existing delegation with same requestId", async () => {
    mockKanbanFindRemoteDelegation.mockReturnValue({
      id: 1, title: "[remote:pi-host] fix", source: "peer", type: "remote",
      source_id: "dup-req", source_peer: "pi-host",
      status: "queued",
      notes: JSON.stringify({
        peer: "pi-host", goal: "fix", executor: "pi", workspace_alias: "my-ws",
        request_id: "dup-req", remote_task_id: 200,
        remote_session_id: "sess-200", remote_run_id: "run-200",
      }),
    });

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "fix", executor: "pi", workspace_alias: "my-ws",
      request_id: "dup-req",
    }));

    expect(result.duplicate).toBe(true);
    expect(result.remote_task_id).toBe(200);
    expect(result.local_card_id).toBe(1);
    // Should NOT have called delegateTask again
    expect(mockDelegateTask).not.toHaveBeenCalled();
  });

  it("detects requestId conflict with different payload", async () => {
    mockKanbanFindRemoteDelegation.mockReturnValue({
      id: 1, title: "[remote:pi-host] fix", source: "peer", type: "remote",
      source_id: "conflict-req", source_peer: "pi-host",
      notes: JSON.stringify({
        peer: "pi-host", goal: "different goal", executor: "pi", workspace_alias: "other-ws",
        request_id: "conflict-req",
      }),
    });

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "fix", executor: "pi", workspace_alias: "my-ws",
      request_id: "conflict-req",
    }));

    expect(result.reason).toBe("request_id_conflict");
    expect(mockDelegateTask).not.toHaveBeenCalled();
  });
});

describe("peer_delegate — relay blocked", () => {
  it("refuses when active card is peer-sourced", async () => {
    mockIsActiveCardPeerSourced.mockResolvedValue(true);

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "do x", peer: "other",
    }));

    expect(result.reason).toBe("peer_relay_blocked");
    expect(mockDelegateTask).not.toHaveBeenCalled();
  });
});

describe("peer_delegate — peer selection", () => {
  it("auto-selects peer by capabilities when requires given", async () => {
    mockDelegateTask.mockResolvedValue({
      taskId: 200, remoteSessionId: "sess-5", executor: "agent",
    });
    mockFindCapablePeer.mockReturnValue({ name: "capable-peer", load: 0.2 });

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "do task", requires: JSON.stringify(["gpu", "docker"]),
    }));

    expect(result.ok).toBe(true);
    expect(result.peer).toBe("capable-peer");
    expect(mockFindCapablePeer).toHaveBeenCalledWith(["docker", "gpu"]);
  });

  it("returns error when no capable peer found", async () => {
    mockFindCapablePeer.mockReturnValue(null);

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "do task", requires: JSON.stringify(["gpu"]),
    }));

    expect(result.error).toContain("No alive peer");
  });

  it("auto-selects least-loaded peer when no requires given", async () => {
    mockDelegateTask.mockResolvedValue({
      taskId: 201, remoteSessionId: "sess-6", executor: "agent",
    });
    mockGetPeerTable.mockReturnValue([
      { name: "loaded", load: 0.9 },
      { name: "idle", load: 0.1 },
      { name: "mid", load: 0.5 },
    ]);

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "do task",
    }));

    expect(result.ok).toBe(true);
    expect(result.peer).toBe("idle");
  });

  it("validates explicit peer capabilities", async () => {
    mockDelegateTask.mockResolvedValue({
      taskId: 202, remoteSessionId: "sess-7", executor: "agent",
    });
    mockGetPeerTable.mockReturnValue([{
      name: "limited-peer", alive: true, load: 0.3,
      capabilities: ["basic"],
    }]);

    const result = JSON.parse(await mod.peerDelegateTool.execute({
      goal: "do task", peer: "limited-peer",
      requires: JSON.stringify(["gpu"]),
    }));

    expect(result.error).toContain("lacks capabilities");
    expect(mockDelegateTask).not.toHaveBeenCalled();
  });
});

describe("peer_check / peer_terminate", () => {
  it("peer_check returns error for missing peer", async () => {
    const result = JSON.parse(await mod.peerCheckTool.execute({ peer: "", task_id: "1" }));
    expect(result.error).toContain("peer and task_id are required");
  });

  it("peer_check returns error for missing task_id", async () => {
    const result = JSON.parse(await mod.peerCheckTool.execute({ peer: "p", task_id: "nan" }));
    expect(result.error).toContain("peer and task_id are required");
  });

  it("peer_check delegates to transport.checkTask", async () => {
    mockCheckTask.mockResolvedValue({ taskId: 5, status: "done", result: "ok" });

    const result = JSON.parse(await mod.peerCheckTool.execute({ peer: "p", task_id: "5" }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(mockCheckTask).toHaveBeenCalledWith("p", 5);
  });

  it("peer_terminate delegates to transport.terminateTask", async () => {
    mockTerminateTask.mockResolvedValue(undefined);

    const result = JSON.parse(await mod.peerTerminateTool.execute({ peer: "p", task_id: "5" }));
    expect(result.ok).toBe(true);
    expect(result.terminated).toBe(true);
    expect(mockTerminateTask).toHaveBeenCalledWith("p", 5);
  });
});

describe("getPeerDelegationTools", () => {
  it("returns three tools", () => {
    const tools = mod.getPeerDelegationTools();
    expect(tools).toHaveLength(3);
    expect(tools[0]!.name).toBe("peer_delegate");
    expect(tools[1]!.name).toBe("peer_check");
    expect(tools[2]!.name).toBe("peer_terminate");
  });
});
