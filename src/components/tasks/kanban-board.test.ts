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

  it("delivery failure increments attempts, fails at 3", () => {
    const id = mod.kanbanEnqueue("Flaky delivery", "task");
    mod.kanbanRunning(id);
    mod.kanbanComplete(id, null, "done");

    mod.kanbanSetDelivering(id);
    mod.kanbanDeliveryFailed(id);
    expect(mod.kanbanList("done")).toHaveLength(1);
    expect(mod.kanbanPending()[0].delivery_attempts).toBe(1);

    mod.kanbanSetDelivering(id);
    mod.kanbanDeliveryFailed(id);
    expect(mod.kanbanPending()[0].delivery_attempts).toBe(2);

    mod.kanbanSetDelivering(id);
    mod.kanbanDeliveryFailed(id);
    expect(mod.kanbanPending()).toHaveLength(0);
    expect(mod.kanbanList("failed")).toHaveLength(1);
    expect(mod.kanbanList("failed")[0].error).toBe("delivery failed after 3 attempts");
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

    // Backdate delivered_at
    const Database = require("better-sqlite3");
    const db = new Database(join(TEST_HOME, "kanban", "kanban.db"));
    db.prepare("UPDATE kanban_board SET delivered_at = datetime('now', '-10 days') WHERE id = ?").run(id);
    db.close();

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
});
