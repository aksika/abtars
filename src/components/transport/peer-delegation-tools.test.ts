import { describe, it, expect, beforeEach, vi } from "vitest";

const mockKanbanEnqueue = vi.fn(() => 42);
const mockKanbanUpdate = vi.fn();
const mockAskHelp = vi.fn();
const mockGetHelpStatus = vi.fn();
const mockWithdrawHelp = vi.fn();
const mockGetConnectedPeers = vi.fn();
const mockHasAllCapabilities = vi.fn();

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
