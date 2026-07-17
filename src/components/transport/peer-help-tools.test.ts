import { describe, it, expect, beforeEach, vi } from "vitest";

const mockKanbanEnqueue = vi.fn(() => 42);
const mockKanbanUpdate = vi.fn();
const mockAskHelp = vi.fn();
const mockGetHelpStatus = vi.fn();
const mockWithdrawHelp = vi.fn();
const mockGetConnectedPeers = vi.fn();
const mockHasAllCapabilities = vi.fn();
const mockHasRoute = vi.fn();

vi.mock("../tasks/kanban-board.js", () => ({
  kanbanEnqueue: (...args: unknown[]) => mockKanbanEnqueue(...args),
  kanbanUpdate: (...args: unknown[]) => mockKanbanUpdate(...args),
}));

vi.mock("../peer-transport/index.js", () => ({
  getPeerTransport: () => ({
    askHelp: mockAskHelp,
    getHelpStatus: mockGetHelpStatus,
    withdrawHelp: mockWithdrawHelp,
  }),
}));

vi.mock("../peer-transport/peer-inventory.js", () => ({
  hasAllCapabilities: (...args: unknown[]) => mockHasAllCapabilities(...args),
}));

vi.mock("../peer-transport/peer-ws-broker.js", () => ({
  getPeerWsBroker: () => ({
    getConnectedPeers: (...args: unknown[]) => mockGetConnectedPeers(...args),
    hasRoute: (...args: unknown[]) => mockHasRoute(...args),
  }),
}));

vi.mock("./orc-tools.js", () => ({
  isActiveCardPeerSourced: () => false,
}));

let mod: typeof import("./peer-help-tools.js");

beforeEach(async () => {
  vi.clearAllMocks();
  mod = await import("./peer-help-tools.js");
});

describe("getPeerHelpTools", () => {
  it("returns three tools", () => {
    const tools = mod.getPeerHelpTools();
    expect(tools).toHaveLength(3);
    expect(tools[0]!.name).toBe("peer_ask_help");
    expect(tools[1]!.name).toBe("peer_help_status");
    expect(tools[2]!.name).toBe("peer_withdraw_help");
  });
});

describe("peer_ask_help", () => {
  it("rejects missing goal", async () => {
    const result = JSON.parse(await mod.peerAskHelpTool.execute({}));
    expect(result.error).toContain("goal");
  });

  it("rejects bad request_id", async () => {
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", request_id: "invalid chars !!!",
    }));
    expect(result.error).toContain("request_id");
  });

  // Relay-block tested in relay-block.test.ts

  it("returns error when no peer specified and none connected", async () => {
    mockGetConnectedPeers.mockReturnValue([]);
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something",
    }));
    expect(result.error).toContain("No connected peers");
  });

  it("returns error when peer unreachable", async () => {
    mockAskHelp.mockRejectedValue(new Error("peer unreachable"));
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", peer: "kp", request_id: "req-err",
    }));
    expect(result.error).toContain("peer_ask_help failed");
  });

  it("sends help request to specified peer", async () => {
    mockGetConnectedPeers.mockReturnValue(["kp"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-1", decision: "accepted", contribution_ref: "help_abc123",
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", peer: "kp", request_id: "req-1",
    }));
    expect(result.decision).toBe("accepted");
    expect(result.contribution_ref).toBe("help_abc123");
    expect(mockAskHelp).toHaveBeenCalled();
  });

  it("surfaces decline from peer", async () => {
    mockGetConnectedPeers.mockReturnValue(["kp"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-2", decision: "declined", reason_code: "policy_denied",
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", peer: "kp", request_id: "req-2",
    }));
    expect(result.decision).toBe("declined");
  });

  it("stops on accepted — no fallback", async () => {
    mockKanbanEnqueue.mockReturnValue(1);
    mockAskHelp.mockResolvedValueOnce({
      version: 1, request_id: "req-accept", decision: "accepted", contribution_ref: "help_abc",
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", peer: "kp", request_id: "req-accept",
    }));
    expect(result.decision).toBe("accepted");
    expect(mockAskHelp).toHaveBeenCalledTimes(1);
  });

  it("surfaces deferred and stops (no fan-out)", async () => {
    mockKanbanEnqueue.mockReturnValue(2);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-def", decision: "deferred", reason_code: "queue_full",
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", peer: "kp", request_id: "req-def",
    }));
    expect(result.decision).toBe("deferred");
    expect(mockAskHelp).toHaveBeenCalledTimes(1);
  });

  it("creates local contribution card keyed by (peer, request_id)", async () => {
    mockKanbanEnqueue.mockReturnValue(3);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-card", decision: "accepted", contribution_ref: "help_xyz",
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "analyze logs", peer: "kp", request_id: "req-card",
    }));
    expect(result.local_card_id).toBe(3);
    // Verify the card was enqueued with type "contribution" and correct metadata
    const enqueueCall = mockKanbanEnqueue.mock.calls[0];
    expect(enqueueCall[0]).toContain("[help:kp]");
    expect(enqueueCall[2]).toBe("req-card");
    expect(enqueueCall[3]?.type).toBe("contribution");
    expect(enqueueCall[3]?.sourcePeer).toBe("kp");
    // No remote ownership fields in notes
    expect(enqueueCall[3]?.notes).not.toContain("remote_task_id");
    expect(enqueueCall[3]?.notes).not.toContain("remote_session_id");
  });

  it("uses distinct request ID for each peer after decline", async () => {
    mockKanbanEnqueue.mockReturnValue(4);
    mockGetConnectedPeers.mockReturnValue(["peer1", "peer2"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp
      .mockResolvedValueOnce({ version: 1, request_id: "req-fallback", decision: "declined" })
      .mockResolvedValueOnce({ version: 1, request_id: "req-fallback-2", decision: "accepted", contribution_ref: "help_final" });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", requires: ["docker"], request_id: "req-fallback",
    }));
    expect(result.decision).toBe("accepted");
    // Two different request IDs should have been used
    const firstId = mockAskHelp.mock.calls[0]?.[1]?.request_id;
    const secondId = mockAskHelp.mock.calls[1]?.[1]?.request_id;
    expect(firstId).not.toBe(secondId);
  });
});

describe("peer_help_status", () => {
  it("rejects missing fields", async () => {
    const result = JSON.parse(await mod.peerHelpStatusTool.execute({}));
    expect(result.error).toContain("required");
  });

  it("queries help status", async () => {
    mockGetHelpStatus.mockResolvedValue({
      version: 1, request_id: "req-1", contribution_ref: "help_abc",
      state: "running", updated_at: new Date().toISOString(),
    });
    const result = JSON.parse(await mod.peerHelpStatusTool.execute({
      peer: "kp", request_id: "req-1", contribution_ref: "help_abc",
    }));
    expect(result.state).toBe("running");
  });
});

describe("peer_withdraw_help", () => {
  it("rejects missing fields", async () => {
    const result = JSON.parse(await mod.peerWithdrawHelpTool.execute({}));
    expect(result.error).toContain("required");
  });

  it("withdraws help request", async () => {
    mockWithdrawHelp.mockResolvedValue({ acknowledged: true, owner_action: "noted" });
    const result = JSON.parse(await mod.peerWithdrawHelpTool.execute({
      peer: "kp", request_id: "req-1", contribution_ref: "help_abc",
    }));
    expect(result.acknowledged).toBe(true);
  });
});
