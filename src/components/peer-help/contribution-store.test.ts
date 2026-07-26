import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContributionStore, type ContributionState } from "./contribution-store.js";
import type { PeerContributionEventV1 } from "./contract.js";

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
  kanbanComplete: () => {},
  kanbanFail: () => {},
};

function makeEvent(overrides: Partial<PeerContributionEventV1> = {}): PeerContributionEventV1 {
  return {
    version: 1,
    event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sequence: 0,
    request_id: "req_test_1",
    contribution_ref: "help_test_ref",
    kind: "progress",
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ContributionStore", () => {
  let harness: Awaited<ReturnType<typeof makeDb>>;
  let store: ContributionStore;

  beforeEach(async () => {
    harness = await makeDb();
    store = new ContributionStore(harness.db, noopKanban);
  });

  afterEach(() => {
    harness.close();
  });

  describe("migration", () => {
    it("creates peer_contributions and peer_contribution_events tables", () => {
      const tables = harness.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
      const names = tables.map(t => t.name);
      expect(names).toContain("peer_contributions");
      expect(names).toContain("peer_contribution_events");
    });
  });

  describe("reserve", () => {
    it("returns new for first reservation", () => {
      const r = store.reserve("peer1", "req1", "hash1", 100, 200, '["c1","c2"]');
      expect(r.status).toBe("new");
      expect(r.contributionRef).toBeTruthy();
    });

    it("returns replay for identical request", () => {
      store.reserve("peer1", "req1", "hash1", 100, 200, null);
      const r = store.reserve("peer1", "req1", "hash1", 100, 200, null);
      expect(r.status).toBe("replay");
      expect(r.contributionRef).toBeTruthy();
    });

    it("returns conflict for same request_id with different hash", () => {
      store.reserve("peer1", "req1", "hash1", 100, 200, null);
      const r = store.reserve("peer1", "req1", "hash2", 100, 200, null);
      expect(r.status).toBe("conflict");
    });

    it("contribution_ref is unique across peers", () => {
      const r1 = store.reserve("peer1", "req1", "h1", null, null, null);
      const r2 = store.reserve("peer2", "req2", "h2", null, null, null);
      expect(r1.contributionRef).toBeTruthy();
      expect(r2.contributionRef).toBeTruthy();
      expect(r1.contributionRef).not.toBe(r2.contributionRef);
    });
  });

  describe("state transitions", () => {
    it("transitions pending -> accepted", () => {
      store.reserve("p", "r", "h", null, null, null);
      expect(store.transitionToAccepted("p", "r")).toBe(true);
      const row = store.getContribution("p", "r")!;
      expect(row.state).toBe("accepted");
    });

    it("transitions accepted -> running", () => {
      store.reserve("p", "r", "h", null, null, null);
      store.transitionToAccepted("p", "r");
      expect(store.transitionToRunning("p", "r")).toBe(true);
      expect(store.getContribution("p", "r")!.state).toBe("running");
    });

    it("transitions running -> completed with projection", () => {
      store.reserve("p", "r", "h", null, null, null);
      store.transitionToAccepted("p", "r");
      store.transitionToRunning("p", "r");
      expect(store.transitionToCompleted("p", "r", '{"outcome":"completed"}')).toBe(true);
      expect(store.getContribution("p", "r")!.state).toBe("completed");
    });

    it("rejects transition from invalid source state", () => {
      store.reserve("p", "r", "h", null, null, null);
      expect(store.transitionToRunning("p", "r")).toBe(false);
      expect(store.getContribution("p", "r")!.state).toBe("pending");
    });

    it("transitions pending -> declined/deferred/unknown", () => {
      store.reserve("p", "r", "h", null, null, null);
      expect(store.transitionToNonStarted("p", "r", "declined")).toBe(true);
      expect(store.getContribution("p", "r")!.state).toBe("declined");
    });

    it("rejects invalid transitionToNonStarted state", () => {
      store.reserve("p", "r", "h", null, null, null);
      expect(store.transitionToNonStarted("p", "r", "completed")).toBe(false);
    });
  });

  describe("applyEvent", () => {
    it("applies a progress event", () => {
      store.reserve("p", "r", "h", null, null, null);
      store.transitionToAccepted("p", "r");
      const result = store.applyEvent("p", makeEvent({ request_id: "r", contribution_ref: store.getContribution("p", "r")!.contribution_ref, sequence: 1, kind: "progress" }), "digest1", null);
      expect(result).toBe("applied");
      expect(store.getContribution("p", "r")!.state).toBe("running");
      expect(store.getContribution("p", "r")!.last_sequence).toBe(1);
    });

    it("applies a completed terminal event and sets proxy to done", () => {
      const proxyUpdates: string[] = [];
      const trackingKanban = {
        kanbanGetCard: () => undefined,
        kanbanUpdate: () => {},
        kanbanComplete: (id: number, _r: string | null, s: string) => { proxyUpdates.push(`complete:${id}:${s}`); },
        kanbanFail: () => {},
      };
      const localStore = new ContributionStore(harness.db, trackingKanban);
      localStore.reserve("p", "r", "h", null, 999, null);
      localStore.transitionToAccepted("p", "r");
      const evt = makeEvent({ request_id: "r", contribution_ref: localStore.getContribution("p", "r")!.contribution_ref, sequence: 1, kind: "completed", summary: "done" });
      const result = localStore.applyEvent("p", evt, "digest_t", '{"outcome":"completed"}');
      expect(result).toBe("applied");
      expect(localStore.getContribution("p", "r")!.state).toBe("completed");
      expect(proxyUpdates).toEqual(["complete:999:done"]);
    });

    it("rejects event for unknown contribution", () => {
      const result = store.applyEvent("p", makeEvent({ request_id: "no_such" }), "d", null);
      expect(result).toBe("rejected");
    });

    it("duplicate event with same ID and digest returns duplicate", () => {
      store.reserve("p", "r", "h", null, null, null);
      store.transitionToAccepted("p", "r");
      const evt = makeEvent({ request_id: "r", event_id: "evt1", contribution_ref: store.getContribution("p", "r")!.contribution_ref, sequence: 1, kind: "completed" });
      expect(store.applyEvent("p", evt, "digest1", '{"done":true}')).toBe("applied");
      expect(store.applyEvent("p", evt, "digest1", '{"done":true}')).toBe("duplicate");
    });

    it("same event ID with different digest returns conflict", () => {
      store.reserve("p", "r", "h", null, null, null);
      store.transitionToAccepted("p", "r");
      const evt = makeEvent({ request_id: "r", event_id: "evt1", contribution_ref: store.getContribution("p", "r")!.contribution_ref, sequence: 1, kind: "completed" });
      expect(store.applyEvent("p", evt, "digest1", null)).toBe("applied");
      expect(store.applyEvent("p", evt, "digest2", null)).toBe("conflict");
    });

    it("second terminal event after first-terminal-wins returns conflict", () => {
      store.reserve("p", "r", "h", null, null, null);
      store.transitionToAccepted("p", "r");
      const e1 = makeEvent({ request_id: "r", event_id: "evt1", contribution_ref: store.getContribution("p", "r")!.contribution_ref, sequence: 1, kind: "completed" });
      expect(store.applyEvent("p", e1, "d1", null)).toBe("applied");
      const e2 = makeEvent({ request_id: "r", event_id: "evt2", contribution_ref: store.getContribution("p", "r")!.contribution_ref, sequence: 2, kind: "completed" });
      expect(store.applyEvent("p", e2, "d2", null)).toBe("conflict");
    });

    it("rejects out-of-order progress event (lower sequence)", () => {
      store.reserve("p", "r", "h", null, null, null);
      store.transitionToAccepted("p", "r");
      const e1 = makeEvent({ request_id: "r", contribution_ref: store.getContribution("p", "r")!.contribution_ref, sequence: 5, kind: "progress" });
      expect(store.applyEvent("p", e1, "d1", null)).toBe("applied");
      const e2 = makeEvent({ request_id: "r", contribution_ref: store.getContribution("p", "r")!.contribution_ref, sequence: 3, kind: "progress" });
      expect(store.applyEvent("p", e2, "d2", null)).toBe("conflict");
    });
  });

  describe("getProjectContributions", () => {
    it("returns contributions for a project", () => {
      store.reserve("p1", "r1", "h", 100, null, '["c1"]');
      store.reserve("p2", "r2", "h", 100, null, null);
      store.reserve("p1", "r3", "h", 200, null, null);
      const rows = store.getProjectContributions(100);
      expect(rows.length).toBe(2);
    });
  });
});
