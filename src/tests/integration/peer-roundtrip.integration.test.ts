/**
 * peer-roundtrip.integration.test.ts — #1618 production-shaped two-node round
 * trip. Two isolated task databases drive REAL receiver admission (PeerHelpService
 * + PeerHelpStore + runner-backed admitReceiverProject), REAL runner settlement
 * + delivery execution (WorkflowRunner + WorkflowStore on the task DB), and
 * REAL requester reservation/reduction (RequesterContributionService +
 * ContributionStore + PeerHelpService reducer). Only the authenticated
 * transport, model planning/review turns, and destination transport sends are
 * doubled. No receiver supervision is seeded, no delivery receipt is faked,
 * and no reducer helper is bypassed.
 *
 * #1792: the receiver runs on the sanctioned singleton composition (mocked
 * home, like orc-workflow.e2e) because runner terminal projections read the
 * task database through the production singleton path; the requester stays on
 * an isolated :memory: database so the two-node isolation property holds.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Db = import("better-sqlite3").Database;

const mockRequestReconcileForProject = vi.hoisted(() => vi.fn());
vi.mock("../../components/reconciler.js", () => ({
  // #1792: the reconciler wake facade is deleted — only the requester
  // delegation wake port survives, injected explicitly per composition.
  requestReconcileForProject: mockRequestReconcileForProject,
}));
vi.mock("../../components/peer-config.js", () => ({
  loadPeerConfig: () => ({
    self: { name: "molty" },
    peers: {
      kp: { trust: 1, verifyKey: "abc" },
      other: { trust: 1, verifyKey: "ghi" },
    },
  }),
}));

// #1631: real production board schema + transition CAS, so the fixture can
// never drift from the production DDL again.
import { ensureKanbanBoardSchema } from "../../components/tasks/kanban-board.js";
import type { PeerHelpRequestV1 } from "../../components/peer-help/contract.js";

async function getDbCtor(): Promise<any> {
  const mod = await import("../../utils/lazy-require.js");
  return mod.resolveNativeDep("better-sqlite3");
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
    kanbanEnqueue: () => undefined as number | undefined,
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
  let receiverRunner: any;
  let contributionStore: any;
  let sends: Array<{ peer: string; request: any }>;
  let acceptedRef: string;
  let delivered: Array<{ peer: string; payload: any }>;
  // Fresh-registry production modules bound to the mocked home (receiver side).
  let M: Record<string, any> = {};
  let TEST_HOME = "";

  beforeAll(async () => {
    vi.resetModules();
    TEST_HOME = join(tmpdir(), `peer-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const [runnerMod, storeMod, kanbanMod, prsMod, phStoreMod, phSvcMod, csMod, rcsMod, nerveMod] = await Promise.all([
      import("../../components/orc-project/orc-workflow-runner.js"),
      import("../../components/orc-project/orc-workflow-store.js"),
      import("../../components/tasks/kanban-board.js"),
      import("../../components/project-acceptance/project-review-store.js"),
      import("../../components/peer-help/store.js"),
      import("../../components/peer-help/service.js"),
      import("../../components/peer-help/contribution-store.js"),
      import("../../components/peer-help/requester-contribution-service.js"),
      import("../../components/nerve.js"),
    ]);
    M = { runnerMod, storeMod, kanbanMod, prsMod, phStoreMod, phSvcMod, csMod, rcsMod, nerveMod };
  });

  afterAll(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const DbCtor = await getDbCtor();
    const rawRequester = new DbCtor(":memory:");
    // #1631: the shared production schema helper — the hand-copied fixture
    // had drifted (missing next_retry_at broke settlement) and can never
    // drift again.
    ensureKanbanBoardSchema(rawRequester);
    requester = makeSide("kp", rawRequester);
    delivered = [];
    sends = [];

    // ── Receiver composition on the singleton task DB (mocked home) ───────
    // Runner terminal projections read cards through the production singleton
    // path, so the receiver's runner, review store, kanban fns, and admission
    // ledger all share the singleton — exactly the deployed composition.
    const receiverDb = M.kanbanMod.requireTaskDatabase();
    // Fresh-table isolation per test (same home, wiped tables — e2e pattern).
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs", "kanban_board", "kanban_card_transitions", "project_supervision", "project_contracts", "project_acceptance_outbox", "peer_help_requests"]) {
      try { receiverDb.exec(`DELETE FROM ${t}`); } catch {}
    }
    const receiverNerve: Side["nerve"] = { fired: [], fire: (event, cardId) => { receiverNerve.fired.push({ event, cardId }); } };
    receiver = {
      db: receiverDb,
      taskDb: receiverDb,
      kanban: {
        kanbanGetCard: M.kanbanMod.kanbanGetCard,
        kanbanGetChildren: M.kanbanMod.kanbanGetChildren,
        kanbanUpdate: M.kanbanMod.kanbanUpdate,
        kanbanList: M.kanbanMod.kanbanList,
        kanbanEnqueue: M.kanbanMod.kanbanEnqueue,
        kanbanComplete: M.kanbanMod.kanbanComplete,
        kanbanFail: M.kanbanMod.kanbanFail,
      },
      nerve: receiverNerve,
    };
    reviewStore = new M.prsMod.ProjectReviewStore();
    // #1792: receiver admission runs through the workflow runner on the
    // receiver database (same composition as production wiring in store.test.ts).
    const peerRunner = new M.runnerMod.WorkflowRunner(new M.storeMod.WorkflowStore());
    receiverRunner = peerRunner;
    receiverStore = new M.phStoreMod.PeerHelpStore(
      receiverDb,
      { kanbanGetCard: receiver.kanban.kanbanGetCard, kanbanUpdate: receiver.kanban.kanbanUpdate, kanbanComplete: receiver.kanban.kanbanComplete, kanbanFail: receiver.kanban.kanbanFail, kanbanEnqueue: receiver.kanban.kanbanEnqueue, kanbanList: receiver.kanban.kanbanList },
      receiver.nerve,
      {
        admitReceiverProject: (cardId: number, sourcePeer: string, sourceId: string) => {
          const admitted = peerRunner.admitSupervised({ rootCardId: cardId, source: "peer", sourcePeer, sourceId });
          if (admitted.kind === "conflict") throw new Error(`receiver admission failed: ${admitted.reason}`);
        },
      },
    );
    receiverService = new M.phSvcMod.PeerHelpService(receiverStore, () => []);

    // ── Requester composition (real stores, fake transport) ───────────────
    contributionStore = new M.csMod.ContributionStore(
      requester.taskDb,
      { kanbanGetCard: requester.kanban.kanbanGetCard, kanbanUpdate: requester.kanban.kanbanUpdate, kanbanComplete: requester.kanban.kanbanComplete, kanbanFail: requester.kanban.kanbanFail },
    );
    requesterService = new M.rcsMod.RequesterContributionService({
      taskDb: requester.taskDb,
      contributionStore,
      askHelp: async (_peer: string, _request: any) => {
        sends.push({ peer: _peer, request: _request });
        // the transport IS the wire: the other end runs the real receiver
        // admission and its authoritative response (incl. contribution ref
        // and proves_non_creation on declines), forwarded unchanged
        return receiverService.handleHelpRequest("kp", _request);
      },
      wakeProject: mockRequestReconcileForProject,
      kanbanUpdate: requester.kanban.kanbanUpdate,
      kanbanFail: requester.kanban.kanbanFail,
    });

    // ── Requester reducer (real handleContributionEvent) ───────────────────
    requesterReducerService = new M.phSvcMod.PeerHelpService({} as any, () => []);
    requesterReducerService.setContributionStore(contributionStore);
  });

  afterEach(() => {
    try { (requester.db as Db).close(); } catch {}
  });

  // ── #1792 runner-composition helpers ──────────────────────────────────
  // The receiver's supervised execution runs through the real WorkflowRunner
  // (admitted at acceptGeneric time via admitReceiverProject). Model
  // planning/review turns and the destination transport are scripted: the
  // delivery sender captures the terminal contribution event the production
  // peer transport would carry, and the test hands it to the real requester
  // reducer — the same transport-doubling seam the old outbox drain provided.

  /** Minimal receiver plan: one work node judged by one review node. */
  function receiverPlan() {
    return {
      requiredOutputs: ["result"],
      nodes: [
        { label: "work", kind: "work", instructions: "do the delegated work", capability: "general", outputs: ["result"], acceptance: ["done"], dependsOn: [] },
        { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["work"] },
      ],
    };
  }

  function scriptedPorts(dispatched?: string[]) {
    return {
      executor: {
        name: "roundtrip-exec",
        dispatch: (cmd: { nodeId: string }) => { dispatched?.push(cmd.nodeId); },
      },
      reviewer: { name: "roundtrip-reviewer", startReview: (_cmd: unknown, _brief: unknown) => {} },
      planner: { name: "roundtrip-planner", startPlanning: (_cmd: unknown, _input: unknown) => {} },
    };
  }

  /** Drive an admitted peer run's work node to succeeded. Returns node ids. */
  function succeedReceiverWork(runId: string, attemptId: string): string[] {
    const acc = receiverRunner.acceptPlan(runId, receiverPlan());
    const dispatched: string[] = [];
    const ports = scriptedPorts(dispatched);
    expect(receiverRunner.drain(10, ports)).toBeGreaterThanOrEqual(1);
    expect(dispatched).toContain(acc.nodeIds[0]);
    receiverRunner.attemptSucceeded(runId, acc.nodeIds[0] as string, attemptId, "{}");
    receiverRunner.drain(10, ports);
    return acc.nodeIds as string[];
  }

  /** Delivery sender fake: captures the send and returns a receipt. The
   * caller forwards the captured terminal event to the requester reducer. */
  function capturingSender(captured: Array<{ idempotenceKey: string }>) {
    return {
      name: "roundtrip-transport",
      send: (doc: { idempotenceKey: string }) => {
        captured.push({ idempotenceKey: doc.idempotenceKey });
        return `receipt:${doc.idempotenceKey}`;
      },
    };
  }

  /** Hand a terminal contribution event to the real requester reducer. */
  async function reduceTerminalEvent(payload: unknown): Promise<boolean> {
    const result = await requesterReducerService.handleContributionEvent("molty", payload);
    return result.ok === true;
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

  it("completes the full identity chain: delegate → admission → runner settlement → delivery → reduction → wake", async () => {
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
    // #1792: admission owns a runner run from birth (same transaction as the
    // card insert) — a peer root that is supervised, never awaiting a claim.
    const admittedRun = receiverRunner.store.findRunByCard(receiverCard.id);
    expect(admittedRun).toBeTruthy();
    expect(admittedRun.rootKind).toBe("peer");
    expect(receiver.nerve.fired.filter(e => e.event === "card:queued")).toHaveLength(1);

    // 3. Receiver execution completes through the REAL runner (model planning
    // and review turns scripted; worker dispatch recorded). The terminal
    // projection — not a direct store settlement — owns the card transition
    // (#1792: cards are projections of run state).
    // #1680: while the peer executes, the requester's durable contribution
    // predicate owns the root (contribution_wait) — no Orc continuation may
    // claim it.
    const { hasLiveContributionForProject } = M.csMod as typeof import("../../components/peer-help/contribution-store.js");
    expect(hasLiveContributionForProject(requester.taskDb as never, delegated.projectCardId)).toBe(true);
    const nodeIds = succeedReceiverWork(admittedRun.runId, "att-recv-r1");
    expect(receiverRunner.submitVerdict(admittedRun.runId, nodeIds[1] as string, { verdict: "accept" })).toBe("accepted");
    // Accepted content is not proof of delivery: the run waits for ack.
    expect(receiverRunner.store.getRun(admittedRun.runId)?.state).not.toBe("succeeded");

    // 4. Delivery executes against the faked destination transport: the sender
    // captures the send (receipt = ack) and the test hands the receiver's
    // terminal contribution event to the real requester reducer — the same
    // transport-doubling seam the old acceptance-outbox drain provided.
    const captured: Array<{ idempotenceKey: string }> = [];
    expect(receiverRunner.executeDelivery(admittedRun.runId, nodeIds[1] as string, capturingSender(captured))).toBe("acknowledged");
    expect(captured).toHaveLength(1);
    expect(receiverRunner.store.getRun(admittedRun.runId)?.state).toBe("succeeded");
    expect(reviewStore.getSupervision(receiverCard.id)?.state).toBe("accepted");
    expect((receiver.db.prepare("SELECT status FROM kanban_board WHERE id = ?").get(receiverCard.id) as any).status).toBe("done");
    // A second delivery attempt is rejected on the terminal run — exactly once.
    expect(() => receiverRunner.executeDelivery(admittedRun.runId, nodeIds[1] as string, capturingSender(captured))).toThrow(/terminal.*late result rejected/);
    expect(captured).toHaveLength(1);

    const decisionId = `rd_runner_${receiverCard.id}_t1`;
    // #1792: the reducer wakes via nerve (the reconciler wake facade is
    // deleted) — subscribe before reducing to observe the terminal wake.
    const wakes: number[] = [];
    const wakeListener = (cardId: number): void => { wakes.push(cardId); };
    M.nerveMod.nerve.on("card:queued", wakeListener);
    expect(await reduceTerminalEvent(terminalEventPayload("completed", decisionId, "peer finished", "r1"))).toBe(true);
    M.nerveMod.nerve.off("card:queued", wakeListener);

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
    expect(wakes).toContain(delegated.projectCardId);
    // #1680: the terminal event released the contribution-wait predicate; the
    // next owner inspection sees the settled proxy and advances to review —
    // never a post-contract Orc continuation claim.
    expect(hasLiveContributionForProject(requester.taskDb as never, delegated.projectCardId)).toBe(false);
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

    // #1792: the receiver blocks through the real runner — a required node
    // exhausts with no retry allowance, so the run fails explicitly and the
    // projection fails the card. Never a false success.
    const admittedRun = receiverRunner.store.findRunByCard(receiverCard.id);
    expect(admittedRun).toBeTruthy();
    const acc = receiverRunner.acceptPlan(admittedRun.runId, receiverPlan());
    receiverRunner.drain(10, scriptedPorts());
    receiverRunner.attemptFailed(admittedRun.runId, acc.nodeIds[0] as string, "att-block-r2", "task_failed", false);
    expect(receiverRunner.store.getRun(admittedRun.runId)?.state).toBe("failed");
    expect((receiver.db.prepare("SELECT status FROM kanban_board WHERE id = ?").get(receiverCard.id) as any).status).toBe("failed");

    const decisionId = `rd_runner_block_${receiverCard.id}_t1`;
    expect(await reduceTerminalEvent(terminalEventPayload("failed", decisionId, "Project blocked: task_failed", "r2"))).toBe(true);

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
    // #1792: the receiver accepts through the real runner; the terminal
    // contribution event below carries that verdict's stable decision id.
    const admittedRun = receiverRunner.store.findRunByCard(receiverCard.id);
    expect(admittedRun).toBeTruthy();
    const nodeIds = succeedReceiverWork(admittedRun.runId, "att-recv-r3");
    expect(receiverRunner.submitVerdict(admittedRun.runId, nodeIds[1] as string, { verdict: "accept" })).toBe("accepted");
    const captured: Array<{ idempotenceKey: string }> = [];
    expect(receiverRunner.executeDelivery(admittedRun.runId, nodeIds[1] as string, capturingSender(captured))).toBe("acknowledged");
    expect(captured).toHaveLength(1);
    const decisionId = `rd_runner_${receiverCard.id}_t1`;
    const event = terminalEventPayload("completed", decisionId, "peer finished", "r3");

    // disconnect once: delivery to the wrong peer fails, ledger untouched
    const failedDelivery = await requesterReducerService.handleContributionEvent("kp", event);
    expect(failedDelivery.ok).toBe(false); // misdelivered — simulate disconnect BEFORE delivery
    // deliver twice: first applies (and wakes once), second is a duplicate
    // no-op that wakes nothing more
    expect(await reduceTerminalEvent(event)).toBe(true);
    const wakes: number[] = [];
    const wakeListener = (cardId: number): void => { wakes.push(cardId); };
    M.nerveMod.nerve.on("card:queued", wakeListener);
    expect(await reduceTerminalEvent(event)).toBe(true);
    M.nerveMod.nerve.off("card:queued", wakeListener);
    expect(wakes).toHaveLength(0);

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
    const request: PeerHelpRequestV1 = {
      version: 1, request_id: "r4", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      goal: "g4", priority: "MEDIUM", required_capabilities: [],
    };
    await requesterService.delegate({ peer: "molty", request, binding: { kind: "create_cli_project", title: "d4", goal: "g4" } });

    // "restart": recreate the requester composition on the SAME databases.
    const freshStore = new M.csMod.ContributionStore(requester.taskDb, { kanbanGetCard: requester.kanban.kanbanGetCard, kanbanUpdate: requester.kanban.kanbanUpdate, kanbanComplete: requester.kanban.kanbanComplete, kanbanFail: requester.kanban.kanbanFail });
    const freshService = new M.rcsMod.RequesterContributionService({
      taskDb: requester.taskDb,
      contributionStore: freshStore,
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

  // ── #1672: authoritative receiver decline ─────────────────────────────────
  it("explicit peer with contradictory inventory reaches real receiver admission, declines with proves_non_creation, and replays idempotently", async () => {
    // the receiver genuinely lacks the requested generic capability; the
    // requester explicitly names the peer regardless of any inventory hint
    const request = {
      version: 1, request_id: "r5", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      goal: "g5", priority: "MEDIUM", required_capabilities: ["synthetic-cap"],
    };

    const delegated = await requesterService.delegate({
      peer: "molty",
      request,
      binding: { kind: "create_cli_project", title: "d5", goal: "g5" },
    });
    expect(delegated.decision).toBe("declined");
    expect(delegated.response?.proves_non_creation).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.peer).toBe("molty");

    // receiver admission created no receiver card, project, or run
    const receiverCards = receiver.db.prepare("SELECT COUNT(*) as cnt FROM kanban_board WHERE source = 'peer'").get() as any;
    expect(receiverCards.cnt).toBe(0);
    const receiverSupervision = receiver.db.prepare("SELECT COUNT(*) as cnt FROM project_supervision").get() as any;
    expect(receiverSupervision.cnt).toBe(0);

    // requester projection is terminal declined
    const ledger = contributionStore.getContribution("molty", "r5");
    expect(ledger).toBeDefined();
    expect(ledger.state).toBe("declined");
    const proxy = requester.db.prepare("SELECT status FROM kanban_board WHERE id = (SELECT proxy_card_id FROM peer_contributions WHERE request_id = 'r5')").get() as any;
    expect(proxy.status).toBe("failed");

    // replay reuses the same durable decision with no second send
    sends.length = 0;
    const replay = await requesterService.delegate({
      peer: "molty",
      request,
      binding: { kind: "create_cli_project", title: "d5", goal: "g5" },
    });
    expect(replay.decision).toBe("declined");
    expect(sends).toHaveLength(0);
    const ledgers = requester.db.prepare("SELECT COUNT(*) as cnt FROM peer_contributions WHERE request_id = 'r5'").get() as any;
    expect(ledgers.cnt).toBe(1);
  });

  it("#1672: an explicit request never falls back to another connected capable peer", async () => {
    const request = {
      version: 1, request_id: "r6", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      goal: "g6", priority: "MEDIUM", required_capabilities: [],
    };
    const delegated = await requesterService.delegate({
      peer: "molty",
      request,
      binding: { kind: "create_cli_project", title: "d6", goal: "g6" },
    });
    expect(delegated.decision).toBe("accepted");
    // exactly one send to the NAMED peer; the other enrolled peer is never contacted
    expect(sends).toHaveLength(1);
    expect(sends[0]!.peer).toBe("molty");
  });
});
