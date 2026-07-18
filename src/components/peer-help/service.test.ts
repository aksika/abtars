import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PeerHelpRequestV1 } from "./contract.js";

const mockReserve = vi.hoisted(() => vi.fn());
const mockAcceptGeneric = vi.hoisted(() => vi.fn());
const mockAcceptPi = vi.hoisted(() => vi.fn());
const mockCompleteDecision = vi.hoisted(() => vi.fn());
const mockMarkUnknown = vi.hoisted(() => vi.fn());
const mockRecordWithdrawal = vi.hoisted(() => vi.fn());
const mockGetPublicStatus = vi.hoisted(() => vi.fn());
const mockRecordContributionEvent = vi.hoisted(() => vi.fn());
const mockKanbanList = vi.hoisted(() => vi.fn(() => []));

vi.mock("../peer-config.js", () => ({
  loadPeerConfig: () => ({
    self: { name: "localhost" },
    peers: {
      kp: { trust: 1, verifyKey: "abc" },
      untrusted: { trust: 0, verifyKey: "def" },
    },
  }),
}));

vi.mock("../tasks/kanban-board.js", () => ({
  kanbanList: mockKanbanList,
}));

function mockStore() {
  return {
    reserve: mockReserve,
    acceptGeneric: mockAcceptGeneric,
    acceptPi: mockAcceptPi,
    completeDecision: mockCompleteDecision,
    markUnknown: mockMarkUnknown,
    recordWithdrawal: mockRecordWithdrawal,
    getPublicStatus: mockGetPublicStatus,
    recordContributionEvent: mockRecordContributionEvent,
  };
}

function validRequest(overrides?: Partial<PeerHelpRequestV1>): PeerHelpRequestV1 {
  return {
    version: 1,
    request_id: "req1",
    created_at: "2026-07-17T12:00:00Z",
    expires_at: "2126-07-17T12:05:00Z",
    goal: "do something",
    required_capabilities: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

async function makeService() {
  const { PeerHelpService } = await import("./service.js");
  const store = mockStore() as any;
  const svc = new PeerHelpService(store, () => ["bash", "docker", "pi-executor", "workspace:devbox"]);
  return { svc, store };
}

describe("PeerHelpService — handleHelpRequest", () => {
  it("declines malformed request without reserving", async () => {
    const { svc, store } = await makeService();
    const resp = await svc.handleHelpRequest("kp", { version: 1, request_id: "bad" });
    expect(resp.decision).toBe("declined");
    expect(resp.reason_code).toBe("malformed");
    expect(store.reserve).not.toHaveBeenCalled();
  });

  it("declines trust-0 peer (ignored → declined)", async () => {
    const { svc } = await makeService();
    mockReserve.mockReturnValue({ status: "new" });
    mockKanbanList.mockReturnValue([]);
    const resp = await svc.handleHelpRequest("untrusted", validRequest());
    expect(resp.decision).toBe("declined");
  });

  it("declines expired request (expires_at before now)", async () => {
    const { svc } = await makeService();
    mockReserve.mockReturnValue({ status: "new" });
    mockKanbanList.mockReturnValue([]);
    const resp = await svc.handleHelpRequest("kp", validRequest({
      created_at: "2020-01-01T00:00:00Z",
      expires_at: "2020-01-01T00:05:00Z",
    }));
    expect(resp.decision).toBe("declined");
    expect(resp.reason_code).toBe("policy_denied");
  });

  it("declines when missing required capability", async () => {
    const { svc } = await makeService();
    mockReserve.mockReturnValue({ status: "new" });
    mockKanbanList.mockReturnValue([]);
    const resp = await svc.handleHelpRequest("kp", validRequest({
      required_capabilities: ["nonexistent-capability"],
    }));
    expect(resp.decision).toBe("declined");
    expect(resp.reason_code).toBe("policy_denied");
  });

  it("declines pi target when pi-executor capability absent", async () => {
    const { PeerHelpService } = await import("./service.js");
    const store = mockStore() as any;
    const svc = new PeerHelpService(store, () => ["bash"]);
    mockReserve.mockReturnValue({ status: "new" });
    mockKanbanList.mockReturnValue([]);

    const resp = await svc.handleHelpRequest("kp", validRequest({
      target: { executor: "pi", workspace_alias: "devbox" },
    }));
    expect(resp.decision).toBe("declined");
  });

  it("defers when activePeerProjects >= MAX", async () => {
    const { svc } = await makeService();
    mockReserve.mockReturnValue({ status: "new" });
    mockKanbanList.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: i, type: "O", status: "running",
        notes: JSON.stringify({ origin_peer: "kp", help_decision: "accepted" }),
      })),
    );
    const resp = await svc.handleHelpRequest("kp", validRequest());
    expect(resp.decision).toBe("deferred");
    expect(resp.reason_code).toBe("queue_full");
  });

  it("accepts valid request within bounds", async () => {
    const { svc } = await makeService();
    mockReserve.mockReturnValue({ status: "new" });
    mockKanbanList.mockReturnValue([]);
    mockAcceptGeneric.mockReturnValue({ contribution_ref: "help_abc", local_card_id: 42 });

    const resp = await svc.handleHelpRequest("kp", validRequest());
    expect(resp.decision).toBe("accepted");
    expect(resp.contribution_ref).toMatch(/^help_[0-9a-f]{16}$/);
  });

  it("returns stored response on replay (same hash)", async () => {
    const { svc } = await makeService();
    mockReserve.mockReturnValue({
      status: "replay",
      response: { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_abc" },
    });
    const resp = await svc.handleHelpRequest("kp", validRequest());
    expect(resp.decision).toBe("accepted");
    expect(mockAcceptGeneric).not.toHaveBeenCalled();
  });

  it("returns declined on conflicting reuse", async () => {
    const { svc } = await makeService();
    mockReserve.mockReturnValue({ status: "conflict" });
    const resp = await svc.handleHelpRequest("kp", validRequest());
    expect(resp.decision).toBe("declined");
    expect(resp.reason_code).toBe("conflict");
  });

  it("defers in-flight delivery to prevent duplicate work", async () => {
    const { svc } = await makeService();
    mockReserve.mockReturnValue({ status: "in_flight" });
    const resp = await svc.handleHelpRequest("kp", validRequest());
    expect(resp.decision).toBe("deferred");
  });
});

describe("PeerHelpService — handleHelpWithdraw", () => {
  it("records withdrawal and returns acknowledged", async () => {
    const { svc } = await makeService();
    mockRecordWithdrawal.mockReturnValue({ status: "noted" });
    const resp = await svc.handleHelpWithdraw("kp", {
      version: 1, request_id: "req1", contribution_ref: "help_abc",
    });
    expect(resp.acknowledged).toBe(true);
    expect(mockRecordWithdrawal).toHaveBeenCalledWith("kp", "req1", "help_abc");
  });
});
