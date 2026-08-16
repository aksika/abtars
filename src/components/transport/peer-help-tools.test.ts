import { describe, it, expect, beforeEach, vi } from "vitest";

const mockKanbanEnqueue = vi.fn(() => 42);
const mockKanbanUpdate = vi.fn();
const mockKanbanFail = vi.fn();
const mockKanbanGetCard = vi.fn(() => undefined);
const mockAskHelp = vi.fn();
const mockGetHelpStatus = vi.fn();
const mockWithdrawHelp = vi.fn();
const mockGetConnectedPeers = vi.fn();
const mockHasAllCapabilities = vi.fn();
const mockGetPeerInventory = vi.fn();
const mockHasRoute = vi.fn();
const mockReserveProxy = vi.fn(() => ({ status: "new", contributionRef: "help_local", proxyCardId: 42 }));
const mockAdoptContributionRef = vi.fn(() => true);
const mockTransitionToAccepted = vi.fn(() => true);
const mockTransitionToNonStarted = vi.fn(() => true);
const mockDetachProxy = vi.fn(() => true);

const mockDb: any = { prepare: () => ({ run: () => ({ changes: 1 }), get: () => undefined, all: () => [] }), exec: () => {}, transaction: (fn: any) => fn() };
vi.mock("../tasks/kanban-board.js", () => ({
  kanbanEnqueue: (...args: unknown[]) => mockKanbanEnqueue(...args),
  kanbanUpdate: (...args: unknown[]) => mockKanbanUpdate(...args),
  kanbanFail: (...args: unknown[]) => mockKanbanFail(...args),
  kanbanRunning: vi.fn(),
  kanbanGetCard: (...args: unknown[]) => mockKanbanGetCard(...args),
  requireTaskDatabase: () => mockDb,
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
  getPeerInventory: (...args: unknown[]) => mockGetPeerInventory(...args),
}));

vi.mock("../peer-help/contribution-store.js", () => ({
  ContributionStore: vi.fn().mockImplementation(function () {
    return {
    reserveProxy: mockReserveProxy,
    adoptContributionRef: mockAdoptContributionRef,
    transitionToAccepted: mockTransitionToAccepted,
    transitionToNonStarted: mockTransitionToNonStarted,
    detachProxy: mockDetachProxy,
    };
  }),
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

vi.mock("./peer-resolver.js", () => ({
  resolvePeerName: (peer: string) => ({ ok: true, peer }),
}));

let mod: typeof import("./peer-help-tools.js");

beforeEach(async () => {
  vi.clearAllMocks();
  // mockReset removes stale mockImplementationOnce queues that would leak
  // across tests (e.g. an unconsumed rejected Once from a freeze test).
  mockAskHelp.mockReset();
  mockGetPeerInventory.mockReturnValue(undefined);
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

  it("allows an explicit peer without inventory to reach receiver admission", async () => {
    mockGetPeerInventory.mockReturnValue(undefined);
    mockHasAllCapabilities.mockReturnValue(false);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-explicit-no-inventory", decision: "accepted", contribution_ref: "help_explicit",
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", peer: "kp", requires: ["pi-executor"], request_id: "req-explicit-no-inventory",
    }));
    expect(result.decision).toBe("accepted");
    expect(mockAskHelp).toHaveBeenCalledTimes(1);
  });

  it("sends exactly once to an explicit peer whose inventory contradicts requirements, surfacing the receiver decline", async () => {
    mockGetPeerInventory.mockReturnValue({ peer: "kp", capabilities: ["docker"] });
    mockHasAllCapabilities.mockReturnValue(false);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-explicit-missing-cap", decision: "declined", reason_code: "policy_denied", proves_non_creation: true,
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", peer: "kp", requires: ["pi-executor"], request_id: "req-explicit-missing-cap",
    }));
    expect(result.decision).toBe("declined");
    expect(result.reason_code).toBe("policy_denied");
    expect(mockAskHelp).toHaveBeenCalledTimes(1);
    expect(mockAskHelp.mock.calls[0]?.[0]).toBe("kp");
  });

  it("surfaces decline from peer", async () => {
    mockGetConnectedPeers.mockReturnValue(["kp"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-2", decision: "declined", reason_code: "policy_denied", proves_non_creation: true,
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

  it("reports bounded exhaustion when every auto-selected candidate declines with proof", async () => {
    mockGetConnectedPeers.mockReturnValue(["kp"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-last", decision: "declined", reason_code: "policy_denied", proves_non_creation: true,
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", requires: ["docker"], request_id: "req-last",
    }));
    expect(result.outcome).toBe("exhausted");
    expect(result.error).toContain("Attempted");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ peer: "kp", outcome: "declined", code: "policy_denied" });
    expect(mockKanbanFail).toHaveBeenCalledWith(42, "peer help declined");
  });

  it("freezes on an unproven decline (no proves_non_creation) — no candidate advancement", async () => {
    mockGetConnectedPeers.mockReturnValue(["peer1", "peer2"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-np", decision: "declined", reason_code: "pi_execution_failed",
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", requires: ["docker"], request_id: "req-np",
    }));
    expect(result.outcome).toBe("unknown");
    expect(result.peer).toBe("peer1");
    expect(result.request_id).toBe("req-np");
    expect(mockAskHelp).toHaveBeenCalledTimes(1);
    expect(mockKanbanFail).not.toHaveBeenCalled();
  });

  it("creates a project-linked non-dispatchable contribution proxy", async () => {
    mockAskHelp.mockResolvedValue({
      version: 1, request_id: "req-card", decision: "accepted", contribution_ref: "help_xyz",
    });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "analyze logs", peer: "kp", request_id: "req-card",
    }));
    expect(result.local_card_id).toBe(42);
    expect(mockReserveProxy).toHaveBeenCalledWith(expect.objectContaining({
      peer: "kp", requestId: "req-card", proxyCardId: undefined,
      sourcePeer: "kp", projectCardId: null,
    }));
  });

  it("uses distinct request ID for each peer after decline", async () => {
    mockKanbanEnqueue.mockReturnValue(4);
    mockGetConnectedPeers.mockReturnValue(["peer1", "peer2"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp
      .mockResolvedValueOnce({ version: 1, request_id: "req-fallback", decision: "declined", proves_non_creation: true })
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

  it("tries fallback peers in deterministic name order", async () => {
    mockKanbanEnqueue.mockReturnValue(5);
    mockGetConnectedPeers.mockReturnValue(["zeta", "alpha", "beta"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp
      .mockResolvedValueOnce({ version: 1, request_id: "req-order", decision: "declined", proves_non_creation: true })
      .mockResolvedValueOnce({ version: 1, request_id: "req-order-2", decision: "accepted", contribution_ref: "help_ordered" });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", requires: ["docker"], request_id: "req-order",
    }));
    expect(result.decision).toBe("accepted");
    expect(mockAskHelp.mock.calls[0]?.[0]).toBe("alpha");
    expect(mockAskHelp.mock.calls[1]?.[0]).toBe("beta");
  });

  it("keeps the reused proxy recoverable when fallback transport is ambiguous", async () => {
    mockGetConnectedPeers.mockReturnValue(["peer1", "peer2"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp
      .mockResolvedValueOnce({ version: 1, request_id: "req-unknown", decision: "declined" })
      .mockRejectedValueOnce(new Error("connection lost"));
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", requires: ["docker"], request_id: "req-unknown",
    }));
    expect(result.outcome).toBe("unknown");
    expect(mockKanbanFail).not.toHaveBeenCalled();
  });

  it("records attempt history on the single delegation card across candidates", async () => {
    mockGetConnectedPeers.mockReturnValue(["alpha", "beta"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp
      .mockResolvedValueOnce({ version: 1, request_id: "req-hist", decision: "declined", reason_code: "executor_not_ready", proves_non_creation: true })
      .mockResolvedValueOnce({ version: 1, request_id: "req-hist-2", decision: "accepted", contribution_ref: "help_hist" });
    mockKanbanGetCard.mockReturnValue({ id: 42, notes: JSON.stringify({ peer: "alpha", request_id: "req-hist", outcome: "declined" }) });
    await mod.peerAskHelpTool.execute({
      goal: "do something", requires: ["docker"], request_id: "req-hist",
    });
    const lastNotes = mockKanbanUpdate.mock.calls.at(-1)?.[1] as { notes?: string };
    const notes = JSON.parse(lastNotes.notes ?? "{}");
    expect(notes.attempts).toHaveLength(2);
    expect(notes.attempts[0]).toMatchObject({ peer: "alpha", outcome: "declined", code: "executor_not_ready" });
    expect(notes.attempts[1]).toMatchObject({ peer: "beta", outcome: "accepted" });
  });

  it("binds to the deferring candidate after a proven decline — no further candidate", async () => {
    mockGetConnectedPeers.mockReturnValue(["alpha", "beta"]);
    mockHasAllCapabilities.mockReturnValue(true);
    mockAskHelp
      .mockResolvedValueOnce({ version: 1, request_id: "req-bind", decision: "declined", reason_code: "executor_not_ready", proves_non_creation: true })
      .mockResolvedValueOnce({ version: 1, request_id: "req-bind-2", decision: "deferred", reason_code: "queue_full" });
    const result = JSON.parse(await mod.peerAskHelpTool.execute({
      goal: "do something", requires: ["docker"], request_id: "req-bind",
    }));
    expect(result.decision).toBe("deferred");
    expect(result.peer).toBe("beta");
    expect(result.request_id).not.toBe("req-bind");
    expect(mockAskHelp).toHaveBeenCalledTimes(2);
    expect(mockKanbanFail).not.toHaveBeenCalled();
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
