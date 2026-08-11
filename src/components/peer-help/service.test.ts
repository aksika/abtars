import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
const mockPiLedgerReserve = vi.hoisted(() => vi.fn());
const mockRequestReconcile = vi.hoisted(() => vi.fn());

vi.mock("../reconciler.js", () => ({
  requestReconcile: mockRequestReconcile,
}));

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

vi.mock("../pi-request-ledger.js", () => ({
  reserveRequest: mockPiLedgerReserve,
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

  it("reconciles an already-created PiRun with a complete help response", async () => {
    const { svc, store } = await makeService();
    mockReserve.mockReturnValue({ status: "in_flight" });
    mockPiLedgerReserve.mockReturnValue({
      ok: true,
      entry: {
        state: "completed",
        responseJson: JSON.stringify({ task_id: 42, run_id: "run-1", generation: 1, session_id: "session-1" }),
      },
    });

    const resp = await svc.handleHelpRequest("kp", validRequest({
      target: { executor: "pi", workspace_alias: "devbox" },
    }));

    expect(resp).toMatchObject({
      decision: "accepted",
      remote_card_id: 42,
      remote_run_id: "run-1",
      remote_generation: 1,
      remote_session_id: "session-1",
    });
    expect(resp.contribution_ref).toMatch(/^help_[0-9a-f]{16}$/);
    expect(mockAcceptPi).toHaveBeenCalledWith(
      expect.objectContaining({ originPeer: "kp", requestId: "req1" }),
      "run-1",
      expect.objectContaining({ contribution_ref: resp.contribution_ref }),
    );
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

describe("PeerHelpService — terminal reduction wakes (#1618)", () => {
  let contributionStore: any;
  let svc: import("./service.js").PeerHelpService;
  let db: import("better-sqlite3").Database;

  beforeEach(async () => {
    const { resolveNativeDep } = await import("../../utils/lazy-require.js") as typeof import("../../utils/lazy-require.js");
    const Database = resolveNativeDep("better-sqlite3");
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS kanban_board (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        priority TEXT NOT NULL DEFAULT 'MEDIUM',
        status TEXT NOT NULL DEFAULT 'queued',
        type TEXT,
        goal TEXT,
        notes TEXT,
        parent_id INTEGER,
        delivery_mode TEXT DEFAULT 'deliver',
        source_peer TEXT,
        result_summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const wrapper = {
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return {
          run: (...p: unknown[]) => stmt.run(...p),
          get: (...p: unknown[]) => stmt.get(...p) as Record<string, unknown> | undefined,
          all: (...p: unknown[]) => stmt.all(...p) as Record<string, unknown>[],
        };
      },
      exec: (sql: string) => db.exec(sql),
      transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    };
    const { ContributionStore } = await import("./contribution-store.js");
    const proxyUpdates: string[] = [];
    contributionStore = new ContributionStore(wrapper as any, {
      kanbanGetCard: (id: number) => db.prepare("SELECT id, status, result_summary, error FROM kanban_board WHERE id = ?").get(id) as any,
      kanbanUpdate: (id: number, updates: Record<string, unknown>) => {
        const sets = Object.keys(updates).map(k => `${k} = ?`).join(", ");
        db.prepare(`UPDATE kanban_board SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
        proxyUpdates.push(`update:${id}`);
      },
      kanbanComplete: (id: number, _r: string | null, summary: string) => {
        db.prepare(`UPDATE kanban_board SET status = 'done', result_summary = ? WHERE id = ?`).run(summary, id);
        proxyUpdates.push(`complete:${id}`);
      },
      kanbanFail: (id: number, error: string) => {
        db.prepare(`UPDATE kanban_board SET status = 'failed', error = ? WHERE id = ?`).run(error, id);
        proxyUpdates.push(`fail:${id}`);
      },
    });
    const { PeerHelpService } = await import("./service.js");
    svc = new PeerHelpService({} as any, () => []);
    svc.setContributionStore(contributionStore);
    mockRequestReconcile.mockClear();
  });

  afterEach(() => {
    db.close();
  });

  function terminalEvent(ref: string, overrides: Record<string, unknown> = {}) {
    return {
      version: 1 as const,
      event_id: "evt_term_1",
      sequence: 1,
      request_id: "r1",
      contribution_ref: ref,
      kind: "completed" as const,
      occurred_at: new Date().toISOString(),
      summary: "peer finished",
      projection: {
        schema_version: 1,
        outcome: "completed",
        summary: "peer finished",
        evidence: [],
        artifacts: [],
        provenance: { receiver_peer: "kp", receiver_project_ref: "pc_1", acceptance_id: "rd_1", accepted_at: new Date().toISOString() },
      },
      ...overrides,
    };
  }

  it("applies the terminal event and wakes the linked parent exactly once", async () => {
    contributionStore.reserveProxy({
      peer: "kp", requestId: "r1", requestHash: "h1", projectCardId: 77, proxyCardId: 5,
      title: "t", goal: "g", priority: "MEDIUM", sourcePeer: "kp", notes: {},
    });
    const row = contributionStore.getContribution("kp", "r1");
    contributionStore.transitionToAccepted("kp", "r1");

    const result = await svc.handleContributionEvent("kp", terminalEvent(row!.contribution_ref));
    expect(result.ok).toBe(true);
    expect(mockRequestReconcile).toHaveBeenCalledTimes(1);
    expect(mockRequestReconcile).toHaveBeenCalledWith(77);
    expect(contributionStore.getContribution("kp", "r1")!.state).toBe("completed");
  });

  it("does not wake the parent on duplicate replay", async () => {
    contributionStore.reserveProxy({
      peer: "kp", requestId: "r1", requestHash: "h1", projectCardId: 77, proxyCardId: 5,
      title: "t", goal: "g", priority: "MEDIUM", sourcePeer: "kp", notes: {},
    });
    const row = contributionStore.getContribution("kp", "r1");
    contributionStore.transitionToAccepted("kp", "r1");
    const evt = terminalEvent(row!.contribution_ref);

    expect((await svc.handleContributionEvent("kp", evt)).ok).toBe(true);
    expect((await svc.handleContributionEvent("kp", evt)).ok).toBe(true);
    expect(mockRequestReconcile).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting second terminal event without mutation or wake", async () => {
    contributionStore.reserveProxy({
      peer: "kp", requestId: "r1", requestHash: "h1", projectCardId: 77, proxyCardId: 5,
      title: "t", goal: "g", priority: "MEDIUM", sourcePeer: "kp", notes: {},
    });
    const row = contributionStore.getContribution("kp", "r1");
    contributionStore.transitionToAccepted("kp", "r1");

    expect((await svc.handleContributionEvent("kp", terminalEvent(row!.contribution_ref))).ok).toBe(true);
    const conflicting = terminalEvent(row!.contribution_ref, { event_id: "evt_term_2", sequence: 2 });
    expect((await svc.handleContributionEvent("kp", conflicting)).ok).toBe(false);
    expect(mockRequestReconcile).toHaveBeenCalledTimes(1);
    const events = db.prepare("SELECT COUNT(*) as cnt FROM peer_contribution_events").get() as any;
    expect(events.cnt).toBe(1);
  });

  it("rejects an event whose provenance names a different receiver", async () => {
    contributionStore.reserveProxy({
      peer: "kp", requestId: "r1", requestHash: "h1", projectCardId: 77, proxyCardId: 5,
      title: "t", goal: "g", priority: "MEDIUM", sourcePeer: "kp", notes: {},
    });
    const row = contributionStore.getContribution("kp", "r1");
    contributionStore.transitionToAccepted("kp", "r1");

    const foreign = terminalEvent(row!.contribution_ref, {
      projection: {
        schema_version: 1, outcome: "completed", summary: "x", evidence: [], artifacts: [],
        provenance: { receiver_peer: "other", receiver_project_ref: "pc_9", acceptance_id: "rd_9", accepted_at: new Date().toISOString() },
      },
    });
    expect((await svc.handleContributionEvent("kp", foreign)).ok).toBe(false);
    expect(mockRequestReconcile).not.toHaveBeenCalled();
    expect(contributionStore.getContribution("kp", "r1")!.state).toBe("accepted");
  });
});
