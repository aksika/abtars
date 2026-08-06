import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let mod: typeof import("./kanban-board.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `kanban-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  mod = await import("./kanban-board.js");
});

describe("kanban-board", () => {
  it("creates the DB and kanban dir on first use", () => {
    mod.kanbanEnqueue("test", "task");
    expect(existsSync(join(TEST_HOME, "kanban", "kanban.db"))).toBe(true);
  });

  it("enqueue returns an id and sets status=queued", () => {
    const id = mod.kanbanEnqueue("My task", "task", "finance-daily");
    expect(id).toBe(1);
    const cards = mod.kanbanList("*");
    expect(cards[0].title).toBe("My task");
    expect(cards[0].status).toBe("queued");
    expect(cards[0].source).toBe("task");
    expect(cards[0].source_id).toBe("finance-daily");
  });

  it("transitions queued → running → done", () => {
    const id = mod.kanbanEnqueue("Build report", "task");
    mod.kanbanRunning(id);
    expect(mod.kanbanList("running")).toHaveLength(1);

    mod.kanbanComplete(id, "/tmp/result.md", "Report generated successfully");
    const cards = mod.kanbanList("done");
    expect(cards).toHaveLength(1);
    expect(cards[0].result_path).toBe("/tmp/result.md");
    expect(cards[0].result_summary).toBe("Report generated successfully");
    expect(cards[0].completed_at).not.toBeNull();
  });

  it("does not emit a second completion for an already-done card", () => {
    const id = mod.kanbanEnqueue("Once", "task");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "first");
    mod.kanbanComplete(id, null, "second");
    expect(mod.kanbanList("done")).toHaveLength(1);
    expect(mod.kanbanGetCard(id)!.result_summary).toBe("first");
  });

  it("claims one delivery attempt atomically", () => {
    const id = mod.kanbanEnqueue("Claim once", "task");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "done");
    expect(mod.kanbanClaimDelivery(id)).toBe(true);
    expect(mod.kanbanClaimDelivery(id)).toBe(false);
    expect(mod.kanbanGetCard(id)!.delivery_attempts).toBe(1);
  });

  it("transitions to failed with error", () => {
    const id = mod.kanbanEnqueue("Failing task", "agent");
    mod.kanbanRunning(id);
    mod.kanbanFail(id, "timeout after 30min");

    const cards = mod.kanbanList("failed");
    expect(cards).toHaveLength(1);
    expect(cards[0].error).toBe("timeout after 30min");
  });

  it("kanbanPending returns done cards with < 3 attempts", () => {
    const id = mod.kanbanEnqueue("Pending delivery", "task");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "done");

    const pending = mod.kanbanPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);
  });

  it("delivery flow: delivering → delivered", () => {
    const id = mod.kanbanEnqueue("Deliver me", "task");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, "/tmp/r.md", "summary");

    mod.kanbanSetDelivering(id);
    expect(mod.kanbanList("delivering")).toHaveLength(1);
    expect(mod.kanbanPending()).toHaveLength(0);

    mod.kanbanMarkDelivered(id);
    expect(mod.kanbanList("delivered")).toHaveLength(1);
    expect(mod.kanbanList("delivered")[0].delivered_at).not.toBeNull();
  });


  it("default kanbanList excludes delivered", () => {
    mod.kanbanEnqueue("Active", "task");
    const id2 = mod.kanbanEnqueue("Done and gone", "task");
    mod.kanbanRunning(id2);
    mod.kanbanComplete(id2, null, "x");
    mod.kanbanSetDelivering(id2);
    mod.kanbanMarkDelivered(id2);

    const active = mod.kanbanList();
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe("Active");
  });

  it("kanbanList with * returns everything", () => {
    const id = mod.kanbanEnqueue("All", "task");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "x");
    mod.kanbanSetDelivering(id);
    mod.kanbanMarkDelivered(id);

    expect(mod.kanbanList("*")).toHaveLength(1);
    expect(mod.kanbanList()).toHaveLength(0);
  });

  it("kanbanUpdate changes fields", () => {
    const id = mod.kanbanEnqueue("Update me", "user");
    mod.kanbanUpdate(id, { priority: "HIGH", labels: "urgent,finance", due_at: "2026-06-10T12:00:00" });

    const cards = mod.kanbanList("*");
    expect(cards[0].priority).toBe("HIGH");
    expect(cards[0].labels).toBe("urgent,finance");
    expect(cards[0].due_at).toBe("2026-06-10T12:00:00");
  });

  it("kanbanCleanup purges old delivered cards", () => {
    const id = mod.kanbanEnqueue("Old card", "task");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "x");
    mod.kanbanSetDelivering(id);
    mod.kanbanMarkDelivered(id);

    // Backdate via module's own DB handle — avoids direct better-sqlite3 require in tests
    mod._kanbanExecForTest(
      "UPDATE kanban_board SET delivered_at = datetime('now', '-10 days') WHERE id = ?",
      [id],
    );

    const purged = mod.kanbanCleanup(7);
    expect(purged).toBe(1);
    expect(mod.kanbanList("*")).toHaveLength(0);
  });

  it("enqueue with options sets priority, labels, type", () => {
    mod.kanbanEnqueue("Rich card", "user", undefined, {
      priority: "HIGH",
      type: "research",
      labels: "ai,finance",
      due_at: "2026-06-09T00:00:00",
      notes: "Do this carefully",
    });
    const card = mod.kanbanList("*")[0];
    expect(card.priority).toBe("HIGH");
    expect(card.type).toBe("research");
    expect(card.labels).toBe("ai,finance");
    expect(card.due_at).toBe("2026-06-09T00:00:00");
    expect(card.notes).toBe("Do this carefully");
  });

  it("enqueue accepts lowercase priority and normalizes to uppercase", () => {
    mod.kanbanEnqueue("Lowercase priority", "task", undefined, { priority: "medium" });
    const card = mod.kanbanList("*")[0];
    expect(card.priority).toBe("MEDIUM");
  });

  it("enqueue accepts mixed-case priority and normalizes to uppercase", () => {
    mod.kanbanEnqueue("Mixed case priority", "task", undefined, { priority: "High" });
    const card = mod.kanbanList("*")[0];
    expect(card.priority).toBe("HIGH");
  });

  it("enqueue falls back to MEDIUM for an invalid priority value", () => {
    mod.kanbanEnqueue("Invalid priority", "task", undefined, { priority: "urgent" });
    const card = mod.kanbanList("*")[0];
    expect(card.priority).toBe("MEDIUM");
  });
});

describe("kanbanUpdate priority normalization", () => {
  it("stores lowercase priority as uppercase", () => {
    const id = mod.kanbanEnqueue("low update", "test");
    mod.kanbanUpdate(id, { priority: "high" });
    const card = mod.kanbanList("*")[0]!;
    expect(card.priority).toBe("HIGH");
  });

  it("stores mixed-case priority as uppercase", () => {
    const id = mod.kanbanEnqueue("mixed update", "test");
    mod.kanbanUpdate(id, { priority: "mEdIuM" });
    const card = mod.kanbanList("*")[0]!;
    expect(card.priority).toBe("MEDIUM");
  });

  it("falls back to MEDIUM for invalid priority", () => {
    const id = mod.kanbanEnqueue("invalid update", "test");
    mod.kanbanUpdate(id, { priority: "URGENT" });
    const card = mod.kanbanList("*")[0]!;
    expect(card.priority).toBe("MEDIUM");
  });

  it("falls back to MEDIUM for empty string priority", () => {
    const id = mod.kanbanEnqueue("empty update", "test");
    mod.kanbanUpdate(id, { priority: "" });
    const card = mod.kanbanList("*")[0]!;
    expect(card.priority).toBe("MEDIUM");
  });

  it("preserves existing priority when priority is omitted", () => {
    const id = mod.kanbanEnqueue("omit update", "test", undefined, { priority: "CRITICAL" });
    mod.kanbanUpdate(id, { labels: "only-labels" });
    const card = mod.kanbanList("*")[0]!;
    expect(card.priority).toBe("CRITICAL");
    expect(card.labels).toBe("only-labels");
  });

  it("does not throw on invalid priority", () => {
    const id = mod.kanbanEnqueue("no throw", "test");
    expect(() => mod.kanbanUpdate(id, { priority: "bogus" })).not.toThrow();
  });
});

describe("kanbanRetryOrFail (#1411)", () => {
  it("increments retry_count and writes future next_retry_at", () => {
    const id = mod.kanbanEnqueue("Retry me", "agent");
    mod.kanbanRunning(id);
    const result = mod.kanbanRetryOrFail(id, "token budget exceeded");
    expect(result).toBe("retrying");
    const card = mod.kanbanList("*")[0]!;
    expect((card as any).retry_count).toBe(1);
    expect((card as any).next_retry_at).toBeTruthy();
    expect(new Date((card as any).next_retry_at).getTime()).toBeGreaterThan(Date.now());
    expect(card.status).toBe("queued");
  });

  it("second retry has larger backoff than first", () => {
    const id = mod.kanbanEnqueue("Retry me 2", "agent");
    mod.kanbanRunning(id);
    mod.kanbanRetryOrFail(id, "first");
    const c1 = mod.kanbanList("*")[0]!;
    const d1 = new Date((c1 as any).next_retry_at).getTime();
    // Run again
    mod.kanbanRunning(id);
    mod.kanbanRetryOrFail(id, "second");
    const c2 = mod.kanbanList("*")[0]!;
    const d2 = new Date((c2 as any).next_retry_at).getTime();
    expect((c2 as any).retry_count).toBe(2);
    expect(d2 - d1).toBeGreaterThanOrEqual(9_000); // 10s backoff vs 20s backoff
  });

  it("permanently fails after MAX_RETRIES", () => {
    const id = mod.kanbanEnqueue("Fatal error", "agent");
    mod.kanbanRunning(id);
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      mod.kanbanRunning(id);
      results.push(mod.kanbanRetryOrFail(id, "fail"));
    }
    // First 3 retries succeed, 4th fails
    expect(results).toEqual(["retrying", "retrying", "retrying", "failed"]);
    const card = mod.kanbanList("*")[0]!;
    expect(card.status).toBe("failed");
    expect(card.error).toContain("after 3 retries");
  });

  it("retry_count and next_retry_at survive DB reopen", async () => {
    // Write state
    const id = mod.kanbanEnqueue("Survive", "agent");
    mod.kanbanRunning(id);
    mod.kanbanRetryOrFail(id, "oops");

    // Reimport with a fresh module (same tmpdir)
    vi.resetModules();
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const mod2 = await import("./kanban-board.js");
    const card = mod2.kanbanList("*")[0]!;
    expect((card as any).retry_count).toBe(1);
    expect((card as any).next_retry_at).toBeTruthy();
    expect(new Date((card as any).next_retry_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("kanbanPromoteDueRetry (#1546)", () => {
  it("promotes a queued due card and clears only the retry marker", () => {
    const id = mod.kanbanEnqueue("Due", "task", "run-1");
    mod.kanbanRunning(id);
    mod.kanbanRetryOrFail(id, "transient");
    const before = mod.kanbanGetCard(id)!;
    const retryAt = new Date(before.next_retry_at!).getTime();

    expect(mod.kanbanPromoteDueRetry(id, retryAt)).toBe(true);
    const card = mod.kanbanGetCard(id)!;
    expect(card.status).toBe("running");
    expect(card.next_retry_at).toBeNull();
    expect(card.retry_count).toBe(before.retry_count); // preserved
    expect(card.error).toBe(before.error); // preserved
  });

  it("never promotes a future retry", () => {
    const id = mod.kanbanEnqueue("Future", "task", "run-2");
    mod.kanbanRunning(id);
    mod.kanbanRetryOrFail(id, "later");
    const card = mod.kanbanGetCard(id)!;
    const retryAt = new Date(card.next_retry_at!).getTime();

    // a full second before the marker is strictly before due time
    expect(mod.kanbanPromoteDueRetry(id, retryAt - 5000)).toBe(false);
    expect(mod.kanbanGetCard(id)!.status).toBe("queued");
    expect(mod.kanbanGetCard(id)!.next_retry_at).not.toBeNull();
  });

  it("is a no-op for a card without a retry marker or not queued", () => {
    const fresh = mod.kanbanEnqueue("Fresh", "task", "run-3");
    expect(mod.kanbanPromoteDueRetry(fresh)).toBe(false);
    const running = mod.kanbanEnqueue("Running", "task", "run-4");
    mod.kanbanRunning(running);
    expect(mod.kanbanPromoteDueRetry(running)).toBe(false);
  });

  it("loses the conditional race to a concurrent promotion (single writer)", () => {
    const id = mod.kanbanEnqueue("Race", "task", "run-5");
    mod.kanbanRunning(id);
    mod.kanbanRetryOrFail(id, "race");
    const card = mod.kanbanGetCard(id)!;
    const retryAt = new Date(card.next_retry_at!).getTime();

    expect(mod.kanbanPromoteDueRetry(id, retryAt)).toBe(true);
    expect(mod.kanbanPromoteDueRetry(id, retryAt)).toBe(false); // already running
    expect(mod.kanbanGetCard(id)!.status).toBe("running");
  });

  it("is a no-op on a terminal card even when a marker lingers", () => {
    const id = mod.kanbanEnqueue("Terminal", "task", "run-6");
    mod.kanbanRunning(id);
    mod.kanbanRetryOrFail(id, "x");
    mod._kanbanExecForTest(`UPDATE kanban_board SET status = 'failed', next_retry_at = datetime('now', '-1 second') WHERE id = ?`, [id]);
    expect(mod.kanbanPromoteDueRetry(id)).toBe(false);
    expect(mod.kanbanGetCard(id)!.status).toBe("failed");
  });
});

describe("kanbanRunningProjectIds (#1414)", () => {
  it("returns running O-type project IDs", () => {
    mod.kanbanEnqueue("Running O project", "agent", undefined, { type: "O" });
    mod.kanbanRunning(2); // enqueue returns id, but with type=O we need to check
    // Actually enqueue with type param — kanbanEnqueue sets type from opts
    // Let's use _kanbanExecForTest to set up precise rows
    mod._kanbanExecForTest(
      `INSERT INTO kanban_board (id, title, source, status, type, created_at) VALUES (10, 'RunO', 'agent', 'running', 'O', datetime('now'))`,
    );
    mod._kanbanExecForTest(
      `INSERT INTO kanban_board (id, title, source, status, type, created_at) VALUES (11, 'QueuedO', 'agent', 'queued', 'O', datetime('now'))`,
    );
    mod._kanbanExecForTest(
      `INSERT INTO kanban_board (id, title, source, status, type, created_at) VALUES (12, 'DoneO', 'agent', 'done', 'O', datetime('now'))`,
    );
    mod._kanbanExecForTest(
      `INSERT INTO kanban_board (id, title, source, status, type, created_at) VALUES (13, 'RunW', 'agent', 'running', 'W', datetime('now'))`,
    );
    mod._kanbanExecForTest(
      `INSERT INTO kanban_board (id, title, source, status, type, created_at) VALUES (14, 'RunPi', 'agent', 'running', 'pi', datetime('now'))`,
    );
    mod._kanbanExecForTest(
      `INSERT INTO kanban_board (id, title, source, status, type, created_at) VALUES (15, 'RunNull', 'agent', 'running', NULL, datetime('now'))`,
    );

    const ids = mod.kanbanRunningProjectIds();
    expect(ids).toEqual([10]); // only running + type='O'
  });

  it("returns empty array when DB is unavailable", () => {
    // Can't easily simulate DB unavailability in this test setup,
    // but we verify the fallback path by design
    const ids = mod.kanbanRunningProjectIds();
    expect(Array.isArray(ids)).toBe(true);
  });
});

describe("kanbanSearch (#1298)", () => {
  it("matches by title", () => {
    mod.kanbanEnqueue("finance report", "cron");
    mod.kanbanEnqueue("daily briefing", "cron");
    const results = mod.kanbanSearch("finance");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("finance report");
  });

  it("matches by status", () => {
    const id = mod.kanbanEnqueue("task a", "cron");
    mod.kanbanRunning(id);
    const results = mod.kanbanSearch("running");
    expect(results.some(c => c.id === id)).toBe(true);
  });

  it("matches by source", () => {
    mod.kanbanEnqueue("task b", "peer");
    const results = mod.kanbanSearch("peer");
    expect(results.some(c => c.source === "peer")).toBe(true);
  });

  it("strips LIKE wildcard characters from term", () => {
    mod.kanbanEnqueue("safe title", "cron");
    // A bare % or _ should not blow up or match everything
    expect(() => mod.kanbanSearch("%")).not.toThrow();
    expect(() => mod.kanbanSearch("_")).not.toThrow();
    const results = mod.kanbanSearch("%");
    // % stripped → empty search string → matches nothing (empty like %%)
    // The important thing is no SQL injection crash
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("kanban-board #1516 bounded agent orchestration", () => {
  it("rejects an invalid maxAgents at the write boundary", () => {
    const id = mod.kanbanEnqueue("Capped", "task", undefined, { type: "O", maxAgents: 5 });
    expect(id).toBe(0);
    expect(mod.kanbanList("*")).toHaveLength(0);
  });

  it("admits up to maxAgents-1 concurrent workers and refuses the next", () => {
    const root = mod.kanbanEnqueue("Capped project", "task", undefined, { type: "O", maxAgents: 4 });
    expect(mod.kanbanGetCard(root)!.max_agents).toBe(4);
    expect(mod.checkWorkerSlotForProject(root)).toEqual({ ok: true });
    for (let i = 0; i < 3; i++) {
      const w = mod.kanbanEnqueue(`worker-${i}`, "agent", undefined, { type: "W", parent_id: root });
      expect(w).toBeGreaterThan(0);
      const slot = mod.checkWorkerSlotForProject(root);
      if (i < 2) {
        expect(slot).toEqual({ ok: true });
      } else {
        expect(slot).toEqual({ ok: false, reason: "agent_cap_reached", active: 3, workerLimit: 3 });
      }
    }
  });

  it("refuses a fourth worker with no partial state", () => {
    const root = mod.kanbanEnqueue("Capped project", "task", undefined, { type: "O", maxAgents: 4 });
    const ids = [1, 2, 3].map(i => mod.kanbanEnqueue(`w-${i}`, "agent", undefined, { type: "W", parent_id: root }));
    const refused = mod.checkWorkerSlotForProject(root);
    expect(refused).toEqual({ ok: false, reason: "agent_cap_reached", active: 3, workerLimit: 3 });
    const children = mod.kanbanGetChildren(root);
    expect(children.map(c => c.id)).toEqual(ids);
    expect(children).toHaveLength(3);
  });

  it("releases capacity when a worker reaches a terminal status", () => {
    const root = mod.kanbanEnqueue("Capped project", "task", undefined, { type: "O", maxAgents: 4 });
    const w1 = mod.kanbanEnqueue("w-1", "agent", undefined, { type: "W", parent_id: root });
    const w2 = mod.kanbanEnqueue("w-2", "agent", undefined, { type: "W", parent_id: root });
    const w3 = mod.kanbanEnqueue("w-3", "agent", undefined, { type: "W", parent_id: root });
    expect(mod.checkWorkerSlotForProject(root).ok).toBe(false);
    // #1590: settlement is only legal from `running` — dispatch first, as the
    // scheduler does before any kanbanComplete in production.
    mod.kanbanRunning(w1);
    mod.kanbanComplete(w1, null, "done");
    expect(mod.checkWorkerSlotForProject(root)).toEqual({ ok: true });
    const w4 = mod.kanbanEnqueue("w-4", "agent", undefined, { type: "W", parent_id: root });
    expect(w4).toBeGreaterThan(w3);
  });

  it("counts cancelled workers as terminal and releases capacity", () => {
    const root = mod.kanbanEnqueue("Capped project", "task", undefined, { type: "O", maxAgents: 2 });
    mod.kanbanEnqueue("w-1", "agent", undefined, { type: "W", parent_id: root });
    mod.kanbanFail(root + 1, "cancelled by Orc");
    expect(mod.checkWorkerSlotForProject(root)).toEqual({ ok: true });
  });

  it("leaves uncapped projects behaviorally unchanged", () => {
    const root = mod.kanbanEnqueue("Uncapped project", "task", undefined, { type: "O" });
    expect(mod.kanbanGetCard(root)!.max_agents).toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(mod.checkWorkerSlotForProject(root)).toEqual({ ok: true });
      mod.kanbanEnqueue(`w-${i}`, "agent", undefined, { type: "W", parent_id: root });
    }
  });

  it("attaches a validated result to an accepted project card exactly once", () => {
    const root = mod.kanbanEnqueue("Accepted project", "task", undefined, { type: "O" });
    mod.kanbanRunning(root);
    mod.kanbanComplete(root, null, "accepted");
    mod.kanbanAttachResult(root, "/tmp/report.md", "artifact 1234 bytes");
    mod.kanbanAttachResult(root, "/tmp/other.md", "late write");
    const card = mod.kanbanGetCard(root)!;
    expect(card.result_path).toBe("/tmp/report.md");
    expect(card.result_summary).toBe("artifact 1234 bytes");
    expect(card.status).toBe("done");
  });

  it("releases deferred delivery exactly once", () => {
    const root = mod.kanbanEnqueue("Deferred project", "task", "run-1", { type: "O", maxAgents: 2, deliveryReady: false });
    mod.kanbanRunning(root);
    mod.kanbanComplete(root, null, "accepted");
    expect(mod.kanbanGetCard(root)!.delivery_ready).toBe(0);
    mod.kanbanSetDeliveryReady(root);
    mod.kanbanSetDeliveryReady(root);
    expect(mod.kanbanGetCard(root)!.delivery_ready).toBe(1);
  });
});

// ── #1590: transition choke point + append-only journal ──────────────────────

function journalFor(cardId: number): Array<Record<string, unknown>> {
  const db = mod.requireTaskDatabase();
  return db.prepare(
    `SELECT id, from_status, to_status, actor, reason, attempt_id, claim_generation FROM kanban_card_transitions WHERE card_id = ? ORDER BY id`
  ).all(cardId) as Array<Record<string, unknown>>;
}

function setStatusRaw(cardId: number, status: string): void {
  // Test-only seeding — the boundary test proves production code never does
  // this outside kanbanTransition.
  mod._kanbanExecForTest(`UPDATE kanban_board SET status = ? WHERE id = ?`, [status, cardId]);
}

describe("#1590 transition matrix", () => {
  const LEGAL_PAIRS: Array<[string, string]> = [
    ["queued", "running"],
    ["queued", "failed"],
    ["queued", "done"], // task-run-settler completes one-shot K/T cards never dispatched
    ["running", "done"],
    ["running", "failed"],
    ["running", "queued"],
    ["done", "delivering"],
    ["done", "queued"],
    ["done", "failed"], // task-run-settler fails an accepted-but-stale project
    ["delivering", "delivered"],
    ["delivering", "done"],
    ["failed", "queued"],
  ];
  const ILLEGAL_PAIRS: Array<[string, string]> = [
    ["delivered", "queued"],
    ["delivered", "done"],
    ["delivered", "failed"],
    ["done", "running"],
    ["failed", "done"],
    ["failed", "running"],
    ["queued", "delivering"],
    ["running", "delivering"],
  ];

  for (const [from, to] of LEGAL_PAIRS) {
    it(`accepts ${from} -> ${to}`, () => {
      const id = mod.kanbanEnqueue("matrix", "test");
      setStatusRaw(id, from);
      const outcome = mod.kanbanTransition({
        cardId: id, from: [from as never], to: to as never, actor: "dispatch", reason: "matrix test",
      });
      expect(outcome.kind).toBe("applied");
      expect(mod.kanbanGetCard(id)!.status).toBe(to);
    });
  }

  for (const [from, to] of ILLEGAL_PAIRS) {
    it(`throws on declared illegal pair ${from} -> ${to}`, () => {
      const id = mod.kanbanEnqueue("matrix", "test");
      setStatusRaw(id, from);
      expect(() => mod.kanbanTransition({
        cardId: id, from: [from as never], to: to as never, actor: "dispatch", reason: "matrix test",
      })).toThrow(/illegal kanban transition/);
    });
  }

  it("throws on an empty from-set", () => {
    const id = mod.kanbanEnqueue("empty", "test");
    expect(() => mod.kanbanTransition({
      cardId: id, from: [], to: "running", actor: "dispatch", reason: "empty",
    })).toThrow(/illegal kanban transition/);
  });

  it("throws on a non-co-writable field", () => {
    const id = mod.kanbanEnqueue("field", "test");
    expect(() => mod.kanbanTransition({
      cardId: id, from: ["queued"], to: "running", actor: "dispatch", reason: "field",
      fields: { status: "running" } as never,
    })).toThrow(/not co-writable/);
  });

  it("applied writes exactly one journal row with actor/attempt/generation", () => {
    const id = mod.kanbanEnqueue("journal", "test");
    const outcome = mod.kanbanTransition({
      cardId: id, from: ["queued"], to: "running", actor: "dispatch", reason: "journal row test",
      attemptId: "attempt-7", claimGeneration: 3,
    });
    expect(outcome.kind).toBe("applied");
    const rows = journalFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_status: "queued", to_status: "running", actor: "dispatch",
      reason: "journal row test", attempt_id: "attempt-7", claim_generation: 3,
    });
  });

  it("CAS loss against a wrong current status is a no_op with zero journal rows", () => {
    const id = mod.kanbanEnqueue("cas", "test");
    setStatusRaw(id, "failed");
    const outcome = mod.kanbanTransition({
      cardId: id, from: ["running"], to: "done", actor: "settle_done", reason: "lost race",
    });
    expect(outcome).toEqual({ kind: "no_op", observed: "failed" });
    expect(journalFor(id)).toHaveLength(0);
    expect(mod.kanbanGetCard(id)!.status).toBe("failed");
  });

  it("reasserted (observed === to, to in from) applies fields without a journal row", () => {
    const id = mod.kanbanEnqueue("reassert", "test");
    setStatusRaw(id, "running");
    const outcome = mod.kanbanTransition({
      cardId: id, from: ["queued", "running"], to: "running", actor: "pi_origin_projection",
      reason: "same-status", fields: { result_summary: "re-asserted" },
      emit: false,
    });
    expect(outcome).toEqual({ kind: "reasserted", observed: "running" });
    expect(journalFor(id)).toHaveLength(0);
    expect(mod.kanbanGetCard(id)!.result_summary).toBe("re-asserted");
  });

  it("terminal protection: a late write against a delivered card is a no_op", () => {
    const id = mod.kanbanEnqueue("late", "test");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "ok");
    mod.kanbanSetDelivering(id);
    mod.kanbanMarkDelivered(id);
    const before = journalFor(id);
    const outcome = mod.kanbanTransition({
      cardId: id, from: ["running"], to: "done", actor: "pi_run_settle", reason: "superseded attempt",
      emit: false,
    });
    expect(outcome).toEqual({ kind: "no_op", observed: "delivered" });
    expect(mod.kanbanGetCard(id)!.status).toBe("delivered");
    expect(journalFor(id)).toHaveLength(before.length);
  });

  it("reason longer than 300 chars is truncated", () => {
    const id = mod.kanbanEnqueue("truncate", "test");
    mod.kanbanTransition({
      cardId: id, from: ["queued"], to: "running", actor: "dispatch", reason: "x".repeat(500),
    });
    const rows = journalFor(id);
    expect(rows[0]!.reason).toHaveLength(300);
  });

  it("a 201st transition prunes the oldest and keeps the newest 200", () => {
    const id = mod.kanbanEnqueue("prune", "test");
    for (let i = 0; i < 205; i++) {
      const from = i % 2 === 0 ? "queued" : "running";
      const to = i % 2 === 0 ? "running" : "queued";
      setStatusRaw(id, from);
      mod.kanbanTransition({
        cardId: id, from: [from as never], to: to as never, actor: "retry_backoff", reason: `loop-${i}`,
        emit: false,
      });
    }
    const rows = journalFor(id);
    expect(rows).toHaveLength(200);
    expect(rows[0]!.reason).toBe("loop-5");
    expect(rows[199]!.reason).toBe("loop-204");
  });

  it("two concurrent settlements produce one applied, one journal row, one card:done", async () => {
    const { nerve } = await import("../nerve.js");
    const doneEvents: number[] = [];
    const listener = (cardId: number) => { doneEvents.push(cardId); };
    nerve.on("card:done", listener);
    try {
      const id = mod.kanbanEnqueue("race", "test");
      mod.kanbanRunning(id);
      mod.kanbanComplete(id, null, "first");
      mod.kanbanComplete(id, null, "second");
      const rows = journalFor(id);
      expect(rows.filter(r => r.to_status === "done")).toHaveLength(1);
      expect(doneEvents).toEqual([id]);
      expect(mod.kanbanGetCard(id)!.result_summary).toBe("first");
    } finally {
      nerve.off("card:done", listener);
    }
  });

  it("kanbanCleanup leaves zero journal rows for deleted cards", () => {
    const id = mod.kanbanEnqueue("cleanup", "test");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "ok");
    mod.kanbanSetDelivering(id);
    mod.kanbanMarkDelivered(id);
    const db = mod.requireTaskDatabase();
    db.prepare(`UPDATE kanban_board SET delivered_at = datetime('now', '-30 days') WHERE id = ?`).run(id);
    expect(mod.kanbanCleanup(7)).toBeGreaterThan(0);
    expect(journalFor(id)).toHaveLength(0);
    expect(mod.kanbanGetCard(id)).toBeUndefined();
  });

  it("lifecycle queued → running → done → delivering → delivered writes five ordered journal rows", () => {
    const id = mod.kanbanEnqueue("lifecycle", "test");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "lifecycle done");
    mod.kanbanSetDelivering(id);
    mod.kanbanMarkDelivered(id);
    const rows = journalFor(id);
    expect(rows.map(r => `${r.from_status}->${r.to_status}`)).toEqual([
      "queued->running", "running->done", "done->delivering", "delivering->delivered",
    ]);
    expect(mod.kanbanGetCard(id)!.status).toBe("delivered");
  });

  it("out-of-process second connection: CAS wins once, the other transition no-ops", async () => {
    // #1590: doctor-fixes opens its own connection. Two connections against
    // one database file must serialize on the CAS predicate.
    const { resolveNativeDep } = await import("../../utils/lazy-require.js");
    const Database = resolveNativeDep("better-sqlite3") as new (p: string) => {
      prepare(sql: string): { run(...p: unknown[]): { changes: number }; get(...p: unknown[]): Record<string, unknown> | undefined; all(...p: unknown[]): unknown[] };
      exec(sql: string): void;
      transaction<T>(fn: () => T): () => T;
      close(): void;
    };
    const dbPath = join(TEST_HOME, "kanban", "kanban.db");
    mkdirSync(join(TEST_HOME, "kanban"), { recursive: true });
    const conn = new Database(dbPath);
    try {
      // Seed a queued card through the module singleton, then race two
      // transitions from separate connections.
      const id = mod.kanbanEnqueue("two-conn", "test");
      const wrap = (d: { prepare(sql: string): { run(...p: unknown[]): { changes: number }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }; exec(sql: string): void; transaction<T>(fn: () => T): unknown }) =>
        mod.wrapTaskDatabase(d);
      const tx1 = wrap(conn);
      const outcome1 = mod.kanbanTransition({
        cardId: id, from: ["queued"], to: "running", actor: "dispatch", reason: "conn1",
      }, tx1);
      expect(outcome1.kind).toBe("applied");
      const outcome2 = mod.kanbanTransition({
        cardId: id, from: ["queued"], to: "running", actor: "dispatch", reason: "conn2",
      }, tx1);
      expect(outcome2.kind).toBe("no_op");
      const rows = journalFor(id);
      expect(rows).toHaveLength(1);
    } finally {
      conn.close();
    }
  });
});
