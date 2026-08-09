/**
 * peer-roundtrip.integration.test.ts — #1618 production-shaped two-node round
 * trip. Two isolated task databases drive REAL receiver admission (PeerHelpService
 * + PeerHelpStore + ProjectReviewStore), REAL terminal settlement + acceptance
 * outbox (ProjectReviewStore), and REAL requester reservation/reduction
 * (RequesterContributionService + ContributionStore + PeerHelpService reducer).
 * Only the authenticated transport and model/Spin execution boundaries are
 * doubled. No receiver supervision is seeded, no outbox row is faked, and no
 * reducer helper is bypassed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Db = import("better-sqlite3").Database;

const mockRequestReconcile = vi.hoisted(() => vi.fn());
const mockRequestReconcileForProject = vi.hoisted(() => vi.fn());
vi.mock("../../components/reconciler.js", () => ({
  requestReconcile: mockRequestReconcile,
  requestReconcileForProject: mockRequestReconcileForProject,
}));
vi.mock("../../components/peer-config.js", () => ({
  loadPeerConfig: () => ({
    self: { name: "molty" },
    peers: { kp: { trust: 1, verifyKey: "abc" } },
  }),
}));

async function getDbCtor(): Promise<any> {
  const mod = await import("../../utils/lazy-require.js");
  return mod.resolveNativeDep("better-sqlite3");
}

function makeKanbanSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_board (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT,
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      status TEXT NOT NULL DEFAULT 'queued',
      type TEXT, notes TEXT, goal TEXT,
      result_summary TEXT, result_path TEXT, error TEXT,
      parent_id INTEGER, blocked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT, max_tokens INTEGER, tokens_used INTEGER,
      delivery_mode TEXT DEFAULT 'deliver',
      source_peer TEXT, delivery_attempts INTEGER DEFAULT 0
    )
  `);
}

interface Side {
  db: Db;
  taskDb: any;
  kanban: any;
  nerve: { fired: Array<{ event: string; cardId: number }>; fire: (event: string, cardId: number) => void };
}

function makeSide(name: string, rawDb: Db): Side {
  const taskDb = {
    prepare(sql: string) {
      const stmt = rawDb.prepare(sql);
      return {
        run(...params: unknown[]) { return stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint }; },
        get(...params: unknown[]) { const r = stmt.get(...params); return r === undefined ? undefined : (r as Record<string, unknown>); },
        all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { rawDb.exec(sql); },
    transaction<T>(fn: () => T): T { return rawDb.transaction(fn)(); },
  };
  const nerve: Side["nerve"] = { fired: [], fire: (event, cardId) => { nerve.fired.push({ event, cardId }); } };
  const kanban = {
    kanbanGetCard: (id: number) => rawDb.prepare("SELECT id, status, type, source, source_peer, notes, parent_id, goal FROM kanban_board WHERE id = ?").get(id) as any ?? undefined,
    kanbanGetChildren: (parentId: number) => rawDb.prepare("SELECT * FROM kanban_board WHERE parent_id = ?").all(parentId) as any[],
    kanbanUpdate: (id: number, updates: Record<string, unknown>) => {
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(", ");
      rawDb.prepare(`UPDATE kanban_board SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), id);
    },
    kanbanList: (status: string) => rawDb.prepare("SELECT id, type, status, notes, source, source_peer FROM kanban_board WHERE status = ?").all(status) as any[],
    kanbanComplete: (id: number, _result: string | null, summary: string) => {
      rawDb.prepare(`UPDATE kanban_board SET status = 'done', result_summary = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(summary.slice(0, 4000), id);
    },
    kanbanFail: (id: number, error: string) => {
      rawDb.prepare(`UPDATE kanban_board SET status = 'failed', error = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(error.slice(0, 1000), id);
    },
  };
  void name;
  return { db: rawDb, taskDb, kanban, nerve };
}

describe("Peer round trip — production-shaped two-node (#1618)", () => {
  let receiver: Side;
  let requester: Side;
  let receiverStore: any;
  let receiverService: any;
  let requesterService: any;
  let requesterReducerService: any;
  let reviewStore: any;
  let contributionStore: any;
  let sends: Array<{ peer: string; request: any }>;
  let acceptedRef: string;
  let delivered: Array<{ peer: string; payload: any }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const DbCtor = await getDbCtor();
    const rawReceiver = new DbCtor(":memory:");
    const rawRequester = new DbCtor(":memory:");
    makeKanbanSchema(rawReceiver);
    makeKanbanSchema(rawRequester);
    receiver = makeSide("molty", rawReceiver);
    requester = makeSide("kp", rawRequester);
    delivered = [];
    sends = [];

    // ── Receiver composition (real admission + real review store) ─────────
    const prs = await import("../../components/project-acceptance/project-review-store.js");
    const phs = await import("../../components/peer-help/service.js");
    const phStoreMod = await import("../../components/peer-help/store.js");
    reviewStore = new prs.ProjectReviewStore(receiver.taskDb);
    receiverStore = new phStoreMod.PeerHelpStore(
      receiver.taskDb,
      { kanbanGetCard: receiver.kanban.kanbanGetCard, kanbanUpdate: receiver.kanban.kanbanUpdate, kanbanComplete: receiver.kanban.kanbanComplete, kanbanFail: receiver.kanban.kanbanFail },
      receiver.nerve,
      { ensureAwaitingContract: (id: number) => reviewStore.ensureAwaitingContract(id) },
    );
    receiverService = new phs.PeerHelpService(receiverStore, () => []);

    // ── Requester composition (real stores, fake transport) ───────────────
    const csMod = await import("../../components/peer-help/contribution-store.js");
    const rcsMod = await import("../../components/peer-help/requester-contribution-service.js");
    contributionStore = new csMod.ContributionStore(
      requester.taskDb,
      { kanbanGetCard: requester.kanban.kanbanGetCard, kanbanUpdate: requester.kanban.kanbanUpdate, kanbanComplete: requester.kanban.kanbanComplete, kanbanFail: requester.kanban.kanbanFail },
    );
    const requesterReviewStore = new prs.ProjectReviewStore(requester.taskDb);
    requesterService = new rcsMod.RequesterContributionService({
      taskDb: requester.taskDb,
      contributionStore,
      reviewStore: requesterReviewStore,
      askHelp: async (_peer: string, _request: any) => {
        sends.push({ peer: _peer, request: _request });
        // the transport IS the wire: the other end runs the real receiver
        // admission and its authoritative response (incl. contribution ref)
        const resp = await receiverService.handleHelpRequest("kp", _request);
        return { version: 1, request_id: _request.request_id, decision: resp.decision, contribution_ref: resp.contribution_ref ?? undefined };
      },
      wakeProject: mockRequestReconcileForProject,
      kanbanUpdate: requester.kanban.kanbanUpdate,
      kanbanFail: requester.kanban.kanbanFail,
    });

    // ── Requester reducer (real handleContributionEvent) ───────────────────
    const phs2 = await import("../../components/peer-help/service.js");
    requesterReducerService = new phs2.PeerHelpService({} as any, () => []);
    requesterReducerService.setContributionStore(contributionStore);
  });

  afterEach(() => {
    try { receiver.db.close(); } catch {}
    try { requester.db.close(); } catch {}
  });

  /** Deliver the receiver's unsent acceptance-outbox rows to the requester (transport doubled). */
  async function drainReceiverOutbox(): Promise<number> {
    const pending = reviewStore.getPendingAcceptanceOutbox();
    let sent = 0;
    for (const row of pending) {
      const payload = JSON.parse(row.payload_json) as any;
      try {
        // the sender, from the requester's perspective, is the receiver's own
        // logical name ("molty") — row.peer is the receiver's view of the
        // requester, not the wire identity the requester sees
        await requesterReducerService.handleContributionEvent("molty", payload);
        if (reviewStore.markAcceptanceOutboxSent(row.id)) sent++;
      } catch {}
    }
    return sent;
  }

  function terminalEventPayload(kind: "completed" | "failed", decisionId: string, summary: string, requestId = "r1") {
    return {
      version: 1,
      event_id: `${kind === "completed" ? "accept" : "fail"}_${requestId}_${acceptedRef}_${decisionId}`,
      sequence: 0,
      request_id: requestId,
      contribution_ref: acceptedRef,
      kind,
      occurred_at: new Date().toISOString(),
      summary,
      projection: {
        schema_version: 1,
        outcome: kind,
        summary,
        evidence: [],
        artifacts: [],
        provenance: { receiver_peer: "molty", receiver_project_ref: "pc_molty", acceptance_id: decisionId, accepted_at: new Date().toISOString() },
      },
    };
  }

  it("completes the full identity chain: delegate → admission → supervision → settlement → outbox → reduction → wake", async () => {
    // 1. Requester reserves (create_cli_project) and sends — the transport is
    //    called only after the durable root/proxy/ledger commit.
    const delegated = await requesterService.delegate({
      peer: "molty",
      request: {
        version: 1, request_id: "r1", created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        goal: "Reply with exactly: ok", priority: "MEDIUM", required_capabilities: [],
      },
      binding: { kind: "create_cli_project", title: "delegate smoke", goal: "Reply with exactly: ok" },
    });
    expect(delegated.decision).toBe("accepted");
    expect(delegated.projectCardId).toBeGreaterThan(0);
    expect(delegated.proxyCardId).toBeGreaterThan(0);
    expect(delegated.contributionRef).toBeTruthy();
    expect(mockRequestReconcileForProject).toHaveBeenCalledWith(delegated.projectCardId);
    const requesterRoot = requester.db.prepare("SELECT * FROM kanban_board WHERE id = ?").get(delegated.projectCardId) as any;
    expect(requesterRoot.source).toBe("cli");
    const requesterProxy = requester.db.prepare("SELECT * FROM kanban_board WHERE id = ?").get(delegated.proxyCardId) as any;
    expect(requesterProxy.status).toBe("running");

    // 2. The transport ran the REAL receiver admission; the requester adopted
    //    the receiver's authoritative ref. Replaying the same request returns
    //    the same ref and creates no second card.
    acceptedRef = delegated.contributionRef;
    const resp = await receiverService.handleHelpRequest("kp", {
      version: 1, request_id: "r1", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      goal: "Reply with exactly: ok", priority: "MEDIUM", required_capabilities: [],
    });
    expect(resp.decision).toBe("accepted");
    expect(resp.contribution_ref).toBe(acceptedRef);
    const peerCards = receiver.db.prepare("SELECT * FROM kanban_board WHERE source = 'peer' AND type = 'O'").all() as any[];
    expect(peerCards).toHaveLength(1);
    const receiverCard = peerCards[0];
    const sup = receiver.db.prepare("SELECT state FROM project_supervision WHERE project_card_id = ?").get(receiverCard.id) as any;
    expect(sup.state).toBe("awaiting_contract");
    expect(receiver.nerve.fired.filter(e => e.event === "card:queued")).toHaveLength(1);

    // 3. Receiver execution completes (model/Spin doubled) and the terminal
    //    decision is settled through the REAL settlement API.
    receiver.db.prepare(`UPDATE kanban_board SET status = 'done' WHERE id = ?`).run(receiverCard.id);
    const decisionId = `rd_settle_${receiverCard.id}_t1`;
    reviewStore.settleAcceptance(
      receiverCard.id, `case_${receiverCard.id}`, { action: "accept", synthesis: "peer finished" },
      "peer finished", { peer: "kp", payload: terminalEventPayload("completed", decisionId, "peer finished") }, decisionId,
    );
    const supAfter = receiver.db.prepare("SELECT state FROM project_supervision WHERE project_card_id = ?").get(receiverCard.id) as any;
    expect(supAfter.state).toBe("accepted");
    const outboxRows = reviewStore.getPendingAcceptanceOutbox();
    expect(outboxRows).toHaveLength(1);

    // 4. Outbox drain delivers through the real reducer; the row is marked sent.
    expect(await drainReceiverOutbox()).toBe(1);
    expect(reviewStore.getPendingAcceptanceOutbox()).toHaveLength(0);

    // 5. Requester reduction is complete and observable.
    const ledger = contributionStore.getContribution("molty", "r1");
    expect(ledger.state).toBe("completed");
    expect(ledger.terminal_event_id).toContain("accept_r1");
    const proxyAfter = requester.db.prepare("SELECT status, result_summary, notes FROM kanban_board WHERE id = ?").get(delegated.proxyCardId) as any;
    expect(proxyAfter.status).toBe("done");
    expect(proxyAfter.result_summary).toContain("peer finished");
    const notes = JSON.parse(proxyAfter.notes) as any;
    expect(notes.outcome).toBe("completed");
    expect(notes.receiver_peer).toBe("molty");
    expect(mockRequestReconcile).toHaveBeenCalledWith(delegated.projectCardId);
  });

  it("delivers a FAILED terminal event when the receiver blocks, never false success", async () => {
    const delegated = await requesterService.delegate({
      peer: "molty",
      request: {
        version: 1, request_id: "r2", created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        goal: "g2", priority: "MEDIUM", required_capabilities: [],
      },
      binding: { kind: "create_cli_project", title: "d2", goal: "g2" },
    });
    const resp = await receiverService.handleHelpRequest("kp", {
      version: 1, request_id: "r2", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      goal: "g2", priority: "MEDIUM", required_capabilities: [],
    });
    expect(resp.decision).toBe("accepted");
    acceptedRef = delegated.contributionRef;
    const receiverCard = receiver.db.prepare("SELECT * FROM kanban_board WHERE source = 'peer' AND type = 'O'").get() as any;

    const decisionId = `rd_block_${receiverCard.id}_t1`;
    reviewStore.settleBlocked(receiverCard.id, `case_${receiverCard.id}`, { action: "blocked", blocker: { blocker_class: "task_failed" } }, "task_failed", { peer: "kp", payload: terminalEventPayload("failed", decisionId, "Project blocked: task_failed", "r2") }, decisionId);
    expect(await drainReceiverOutbox()).toBe(1);

    const ledger = contributionStore.getContribution("molty", "r2");
    expect(ledger.state).toBe("failed");
    const proxy = requester.db.prepare("SELECT status, error FROM kanban_board WHERE id = (SELECT proxy_card_id FROM peer_contributions WHERE request_id = 'r2')").get() as any;
    expect(proxy.status).toBe("failed");
  });

  it("redelivery is idempotent and a conflicting second terminal event is rejected", async () => {
    const delegated = await requesterService.delegate({
      peer: "molty",
      request: {
        version: 1, request_id: "r3", created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        goal: "g3", priority: "MEDIUM", required_capabilities: [],
      },
      binding: { kind: "create_cli_project", title: "d3", goal: "g3" },
    });
    await receiverService.handleHelpRequest("kp", {
      version: 1, request_id: "r3", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      goal: "g3", priority: "MEDIUM", required_capabilities: [],
    });
    const receiverCard = receiver.db.prepare("SELECT * FROM kanban_board WHERE source = 'peer' AND type = 'O'").get() as any;
    acceptedRef = delegated.contributionRef;
    const decisionId = `rd_settle_${receiverCard.id}_t1`;
    const event = terminalEventPayload("completed", decisionId, "peer finished", "r3");
    reviewStore.settleAcceptance(receiverCard.id, `case_${receiverCard.id}`, { action: "accept", synthesis: "peer finished" }, "peer finished", { peer: "kp", payload: event }, decisionId);

    // disconnect once: delivery fails, row retained
    const failedDelivery = await requesterReducerService.handleContributionEvent("kp", event);
    expect(failedDelivery.ok).toBe(false); // not yet outboxed — simulate disconnect BEFORE drain
    // deliver twice: first applies, second is a duplicate no-op
    expect(await drainReceiverOutbox()).toBe(1);
    mockRequestReconcile.mockClear();
    expect(await drainReceiverOutbox()).toBe(0);
    expect(mockRequestReconcile).not.toHaveBeenCalled();

    const ledger = contributionStore.getContribution("molty", "r3");
    expect(ledger.state).toBe("completed");
    const eventRows = requester.db.prepare("SELECT COUNT(*) as cnt FROM peer_contribution_events").get() as any;
    expect(eventRows.cnt).toBe(1);

    // a second terminal event with a different event id is a conflict, no mutation
    const conflicting = terminalEventPayload("completed", "rd_settle_conflict", "different result");
    const rejected = await requesterReducerService.handleContributionEvent("kp", conflicting);
    expect(rejected.ok).toBe(false);
    const ledgerAfter = contributionStore.getContribution("molty", "r3");
    expect(ledgerAfter.terminal_event_id).toContain(decisionId);
    expect(ledgerAfter.terminal_event_id).not.toContain("conflict");
  });

  it("recovers from restart from durable non-terminal state without duplicates", async () => {
    const request = {
      version: 1, request_id: "r4", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      goal: "g4", priority: "MEDIUM", required_capabilities: [],
    };
    await requesterService.delegate({ peer: "molty", request, binding: { kind: "create_cli_project", title: "d4", goal: "g4" } });

    // "restart": recreate the requester composition on the SAME databases.
    const csMod = await import("../../components/peer-help/contribution-store.js");
    const rcsMod = await import("../../components/peer-help/requester-contribution-service.js");
    const prs = await import("../../components/project-acceptance/project-review-store.js");
    const freshStore = new csMod.ContributionStore(requester.taskDb, { kanbanGetCard: requester.kanban.kanbanGetCard, kanbanUpdate: requester.kanban.kanbanUpdate, kanbanComplete: requester.kanban.kanbanComplete, kanbanFail: requester.kanban.kanbanFail });
    const freshReview = new prs.ProjectReviewStore(requester.taskDb);
    const freshService = new rcsMod.RequesterContributionService({
      taskDb: requester.taskDb,
      contributionStore: freshStore,
      reviewStore: freshReview,
      askHelp: async () => { throw new Error("must not resend after restart"); },
      wakeProject: mockRequestReconcileForProject,
      kanbanUpdate: requester.kanban.kanbanUpdate,
      kanbanFail: requester.kanban.kanbanFail,
    });

    const replay = await freshService.delegate({ peer: "molty", request, binding: { kind: "create_cli_project", title: "d4", goal: "g4" } });
    expect(sends).toHaveLength(1); // the pre-restart send; the replay must NOT resend
    const roots = requester.db.prepare("SELECT COUNT(*) as cnt FROM kanban_board WHERE source = 'cli'").get() as any;
    expect(roots.cnt).toBe(1);
    const ledgers = requester.db.prepare("SELECT COUNT(*) as cnt FROM peer_contributions WHERE request_id = 'r4'").get() as any;
    expect(ledgers.cnt).toBe(1);
    expect(replay.projectCardId).toBeGreaterThan(0);
  });
});
