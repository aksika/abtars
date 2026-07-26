import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContributionStore } from "./contribution-store.js";
import { PeerHelpService } from "./service.js";
import { PeerHelpStore } from "./store.js";
import type { PeerContributionEventV1 } from "./contract.js";

const reconcileCalls: number[] = [];
vi.mock("../reconciler.js", () => ({
  requestReconcile: (id: number) => { reconcileCalls.push(id); },
}));

let _Database: any = null;
async function getDb() {
  if (!_Database) {
    const mod = await import("../../utils/lazy-require.js") as { resolveNativeDep: (name: string) => any };
    _Database = mod.resolveNativeDep("better-sqlite3");
  }
  return _Database;
}

async function makeDb(): Promise<any> {
  const Db = await getDb();
  const db = new Db(":memory:");
  return {
    raw: db,
    db: {
      prepare(sql: string) { const stmt = db.prepare(sql); return { run(...p: unknown[]) { return stmt.run(...p) as any; }, get(...p: unknown[]) { const r = stmt.get(...p); return r === undefined ? undefined : r as any; }, all(...p: unknown[]) { return stmt.all(...p) as any[]; } }; },
      exec(sql: string) { db.exec(sql); },
      transaction<T>(fn: () => T): T { return db.transaction(fn)(); },
    },
    close() { db.close(); },
  };
}

const noopKanban = {
  kanbanGetCard: () => undefined as any,
  kanbanUpdate: () => {},
  kanbanEnqueue: (..._args: unknown[]) => 0,
  kanbanComplete: () => {},
  kanbanFail: () => {},
  kanbanList: () => [] as any[],
};

const noopNerve = { fire: () => {} };

function makeEvent(overrides: Partial<PeerContributionEventV1> = {}): PeerContributionEventV1 {
  const kind = overrides.kind ?? "progress";
  return {
    version: 1,
    event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sequence: 0,
    request_id: "r1",
    contribution_ref: "cr1",
    kind,
    occurred_at: new Date().toISOString(),
    ...(kind === "completed" || kind === "failed" ? {
      projection: {
        schema_version: 1,
        outcome: kind,
        summary: "done",
        evidence: [],
        artifacts: [],
        provenance: {
          receiver_peer: "peer1",
          receiver_project_ref: "project1",
          acceptance_id: "accept1",
          accepted_at: new Date().toISOString(),
        },
      },
    } : {}),
    ...overrides,
  };
}

describe("PeerHelpService contribution reduction (#1493)", () => {
  let harness: Awaited<ReturnType<typeof makeDb>>;
  let helpStore: PeerHelpStore;
  let contribStore: ContributionStore;
  let service: PeerHelpService;

  beforeEach(async () => {
    reconcileCalls.length = 0;
    harness = await makeDb();
    helpStore = new PeerHelpStore(harness.raw, noopKanban, noopNerve);
    contribStore = new ContributionStore(harness.db, noopKanban);
    service = new PeerHelpService(helpStore, () => []);
    service.setContributionStore(contribStore);
  });

  afterEach(() => {
    harness.close();
  });

  it("rejects malformed event payload", async () => {
    const result = await service.handleContributionEvent("peer1", { invalid: true });
    expect(result.ok).toBe(false);
  });

  it("rejects event with wrong version", async () => {
    const result = await service.handleContributionEvent("peer1", { version: 2, request_id: "r1", contribution_ref: "cr1", event_id: "e1", sequence: 0, kind: "completed", occurred_at: new Date().toISOString() });
    expect(result.ok).toBe(false);
  });

  it("rejects event with missing fields", async () => {
    const result = await service.handleContributionEvent("peer1", { version: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects event for unknown contribution", async () => {
    const evt = makeEvent({ request_id: "no_such" });
    const result = await service.handleContributionEvent("peer1", evt as any);
    expect(result.ok).toBe(false);
  });

  it("applies progress events without waking Reconciler", async () => {
    contribStore.reserve("peer1", "r1", "h1", 100, 200, null);
    contribStore.transitionToAccepted("peer1", "r1");
    const evt = makeEvent({ request_id: "r1", contribution_ref: contribStore.getContribution("peer1", "r1")!.contribution_ref, sequence: 1, kind: "progress" });
    const result = await service.handleContributionEvent("peer1", evt as any);
    expect(result.ok).toBe(true);
    expect(contribStore.getContribution("peer1", "r1")!.state).toBe("running");
    await new Promise(r => setTimeout(r, 0));
    expect(reconcileCalls.length).toBe(0);
  });

  it("wakes Reconciler on completed terminal event", async () => {
    contribStore.reserve("peer1", "r1", "h1", 42, 200, null);
    contribStore.transitionToAccepted("peer1", "r1");
    const cr = contribStore.getContribution("peer1", "r1")!.contribution_ref;
    const evt = makeEvent({ request_id: "r1", contribution_ref: cr, sequence: 1, kind: "completed", summary: "done",
      projection: { schema_version: 1, outcome: "completed", summary: "done", evidence: [], artifacts: [],
        provenance: { receiver_peer: "peer1", receiver_project_ref: "prj", acceptance_id: "acc1", accepted_at: new Date().toISOString() } },
    });
    const result = await service.handleContributionEvent("peer1", evt as any);
    expect(result.ok).toBe(true);
    expect(contribStore.getContribution("peer1", "r1")!.state).toBe("completed");
    await new Promise(r => setTimeout(r, 0));
    expect(reconcileCalls).toContain(42);
  });

  it("wakes Reconciler on failed terminal event", async () => {
    contribStore.reserve("peer1", "r1", "h1", 42, 200, null);
    contribStore.transitionToAccepted("peer1", "r1");
    const cr = contribStore.getContribution("peer1", "r1")!.contribution_ref;
    const evt = makeEvent({ request_id: "r1", contribution_ref: cr, sequence: 1, kind: "failed" });
    const result = await service.handleContributionEvent("peer1", evt as any);
    expect(result.ok).toBe(true);
    expect(contribStore.getContribution("peer1", "r1")!.state).toBe("failed");
    await new Promise(r => setTimeout(r, 0));
    expect(reconcileCalls).toContain(42);
  });

  it("duplicate event is accepted but does not add extra reconcile", async () => {
    contribStore.reserve("peer1", "r1", "h1", 42, 200, null);
    contribStore.transitionToAccepted("peer1", "r1");
    const cr = contribStore.getContribution("peer1", "r1")!.contribution_ref;
    const evt = makeEvent({ request_id: "r1", event_id: "evt_fixed", contribution_ref: cr, sequence: 1, kind: "completed", summary: "done" });
    expect((await service.handleContributionEvent("peer1", evt as any)).ok).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    const countAfterFirst = reconcileCalls.length;
    expect((await service.handleContributionEvent("peer1", evt as any)).ok).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(reconcileCalls.length).toBe(countAfterFirst);
  });

  it("conflicting terminal event after first-terminal-wins is handled gracefully", async () => {
    contribStore.reserve("peer1", "r1", "h1", 42, 200, null);
    contribStore.transitionToAccepted("peer1", "r1");
    const cr = contribStore.getContribution("peer1", "r1")!.contribution_ref;
    const evt1 = makeEvent({ request_id: "r1", event_id: "e1", contribution_ref: cr, sequence: 1, kind: "completed", summary: "done" });
    const evt2 = makeEvent({ request_id: "r1", event_id: "e2", contribution_ref: cr, sequence: 2, kind: "completed", summary: "different" });
    expect((await service.handleContributionEvent("peer1", evt1 as any)).ok).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(reconcileCalls.filter(c => c === 42).length).toBe(1);
    expect((await service.handleContributionEvent("peer1", evt2 as any)).ok).toBe(false);
    await new Promise(r => setTimeout(r, 0));
    expect(reconcileCalls.filter(c => c === 42).length).toBe(1);
  });

  it("rejects event with invalid projection provenance", async () => {
    contribStore.reserve("peer1", "r1", "h1", 42, 200, null);
    contribStore.transitionToAccepted("peer1", "r1");
    const cr = contribStore.getContribution("peer1", "r1")!.contribution_ref;
    const evt = makeEvent({ request_id: "r1", contribution_ref: cr, sequence: 1, kind: "completed", summary: "done",
      projection: { outcome: "completed", summary: "done" } as any });
    const result = await service.handleContributionEvent("peer1", evt as any);
    expect(result.ok).toBe(false);
  });
});
