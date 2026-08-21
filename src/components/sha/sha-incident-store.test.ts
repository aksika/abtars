import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShaIncidentStore } from "./sha-incident-store.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { makeTaskFailure } from "../tasks/task-failure.js";

let TEST_HOME: string;
let db: TaskDatabase;
let store: ShaIncidentStore;

async function openDb(): Promise<TaskDatabase> {
  const mod = await import("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
  return mod.requireTaskDatabase();
}

async function setup(): Promise<void> {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `sha-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  db = await openDb();
  store = new ShaIncidentStore(db);
}

beforeEach(async () => {
  await setup();
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

function admit(overrides: Partial<Parameters<ShaIncidentStore["admitEvent"]>[0]> = {}): ReturnType<ShaIncidentStore["admitEvent"]> {
  return store.admitEvent({
    eventKey: "task:daily-ai:run:r1",
    fingerprint: FP_A,
    workflowKind: "project",
    source: "scheduled",
    sourceScope: "daily-ai",
    taskKind: "agent",
    mode: "full",
    diagnosticJson: JSON.stringify(makeTaskFailure("execution", "model_error", "executing", "boom", "none")),
    occurredAt: Date.now(),
    ...overrides,
  });
}

describe("schema", () => {
  it("creates the four sha_* tables idempotently on the canonical database", async () => {
    const mod = await import("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
    const taskDb = mod.requireTaskDatabase();
    new ShaIncidentStore(taskDb); // second open: no-op DDL
    for (const table of ["sha_incidents", "sha_incident_events", "sha_incident_transitions", "sha_fault_state"]) {
      const row = taskDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
      expect(row).toBeDefined();
    }
  });
});

describe("admitEvent — create-or-attach (R4)", () => {
  it("creates episode 1 on first admission with provisioning state", () => {
    const result = admit();
    expect(result).toMatchObject({ kind: "created", episode: 1, rootCardId: null });
    if (result.kind !== "created") return;
    const row = store.findById(result.incidentId);
    expect(row?.state).toBe("provisioning");
    expect(row?.occurrenceCount).toBe(1);
    expect(row?.fingerprint).toBe(FP_A);
    expect(row?.sourceScope).toBe("daily-ai");
    expect(row?.mode).toBe("full");
    expect(row?.taskKind).toBe("agent");
  });

  it("replaying the same event key is a no-op — no second row, no occurrence bump", () => {
    const first = admit();
    expect(first.kind).toBe("created");
    const second = admit({ eventKey: "task:daily-ai:run:r1" });
    expect(second).toMatchObject({ kind: "duplicate_event" });
    const events = db.prepare("SELECT COUNT(*) AS n FROM sha_incident_events").get();
    expect(Number(events?.["n"])).toBe(1);
    if (first.kind !== "created") return;
    expect(store.findById(first.incidentId)?.occurrenceCount).toBe(1);
  });

  it("a different event with the same fingerprint attaches and increments exactly once", () => {
    const first = admit();
    expect(first.kind).toBe("created");
    if (first.kind !== "created") return;
    const attached = admit({ eventKey: "task:daily-ai:run:r2" });
    expect(attached).toMatchObject({ kind: "attached", incidentId: first.incidentId, occurrenceCount: 2, rootCardId: null });
    expect(store.findById(first.incidentId)?.occurrenceCount).toBe(2);
    expect(store.listNonTerminal()).toHaveLength(1);
  });

  it("different fingerprints create separate active episodes", () => {
    const a = admit();
    const b = admit({ eventKey: "task:other:run:r1", fingerprint: FP_B, sourceScope: "other" });
    expect(a.kind).toBe("created");
    expect(b.kind).toBe("created");
    expect(store.listNonTerminal()).toHaveLength(2);
  });

  it("a terminal episode permits a later event to allocate the next episode", () => {
    const first = admit();
    if (first.kind !== "created") return;
    const blocked = store.transition({
      incidentId: first.incidentId,
      expectedVersion: 1,
      fromStates: ["provisioning"],
      toState: "blocked",
      reason: "test block",
    });
    expect(blocked.ok).toBe(true);
    const next = admit({ eventKey: "task:daily-ai:run:r9" });
    expect(next).toMatchObject({ kind: "created", episode: 2 });
    const rows = store.listNonTerminal();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.episode).toBe(2);
  });

  it("bounded diagnostic JSON insertion", () => {
    const huge = JSON.stringify(makeTaskFailure("execution", "model_error", "executing", "x".repeat(20_000), "none"));
    const result = admit({ diagnosticJson: huge });
    expect(result.kind).not.toBe("duplicate_event");
    const row = db.prepare("SELECT diagnostic_json FROM sha_incident_events WHERE event_key = 'task:daily-ai:run:r1'").get();
    expect(String(row?.["diagnostic_json"]).length).toBeLessThanOrEqual(8192);
  });
});

describe("transition — CAS + journal (R4)", () => {
  it("applies on matching version/state and appends a journal row", async () => {
    const result = admit();
    if (result.kind !== "created") return;
    const mod = await import("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
    const rootCardId = mod.kanbanEnqueue("sha root", "O", "sha");
    const stageCardId = mod.kanbanEnqueue("sha rca", "W", "sha");
    const t = store.transition({
      incidentId: result.incidentId,
      expectedVersion: 1,
      fromStates: ["provisioning", "rca"],
      toState: "rca",
      reason: "activate",
      fields: { rootCardId, currentStageCardId: stageCardId },
    });
    expect(t).toMatchObject({ ok: true, toState: "rca", version: 2 });
    const row = store.findById(result.incidentId);
    expect(row?.rootCardId).toBe(rootCardId);
    expect(row?.currentStageCardId).toBe(stageCardId);
    const journal = db.prepare("SELECT * FROM sha_incident_transitions WHERE incident_id = ?").all(result.incidentId);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.["from_version"]).toBe(1);
    expect(journal[0]?.["to_state"]).toBe("rca");
  });

  it("lost CAS returns stale and does not mutate or journal", () => {
    const result = admit();
    if (result.kind !== "created") return;
    const first = store.transition({ incidentId: result.incidentId, expectedVersion: 1, fromStates: ["provisioning"], toState: "rca", reason: "a" });
    expect(first.ok).toBe(true);
    const second = store.transition({ incidentId: result.incidentId, expectedVersion: 1, fromStates: ["provisioning"], toState: "rca", reason: "b" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.kind).toBe("stale");
    const journal = db.prepare("SELECT COUNT(*) AS n FROM sha_incident_transitions WHERE incident_id = ?").get(result.incidentId);
    expect(Number(journal?.["n"])).toBe(1);
    expect(store.findById(result.incidentId)?.state).toBe("rca");
  });

  it("terminal transitions stamp terminal_at and terminal_reason", () => {
    const result = admit();
    if (result.kind !== "created") return;
    const t = store.transition({ incidentId: result.incidentId, expectedVersion: 1, fromStates: ["provisioning"], toState: "blocked", reason: "cascade" });
    expect(t.ok).toBe(true);
    const row = store.findById(result.incidentId);
    expect(row?.terminalAt).not.toBeNull();
    expect(row?.terminalReason).toBe("cascade");
    expect(store.listNonTerminal()).toHaveLength(0);
  });
});

describe("fault state cooldowns (R8)", () => {
  it("records attempts, results, and resets attempts on success", () => {
    store.recordAttempt("autofix-known", "p1");
    store.recordAttempt("autofix-known", "p1");
    expect(store.faultState("autofix-known", "p1")?.attempts).toBe(2);
    expect(store.faultState("autofix-known", "p1")?.totalRuns).toBe(2);
    store.recordResult("autofix-known", "p1", false, "exit 1");
    expect(store.faultState("autofix-known", "p1")?.attempts).toBe(3);
    store.recordResult("autofix-known", "p1", true);
    const state = store.faultState("autofix-known", "p1");
    expect(state?.attempts).toBe(0);
    expect(state?.lastResult).toBe("ok");
    expect(state?.lastError).toBeNull();
  });

  it("reset deletes matching rows in one transaction", () => {
    store.recordAttempt("autofix-known", "p1");
    store.recordAttempt("autofix-known", "p2");
    store.recordAttempt("autofix-unknown", "p1");
    expect(store.resetFaultState("autofix-known")).toBe(2);
    expect(store.faultState("autofix-known", "p1")).toBeNull();
    expect(store.faultState("autofix-unknown", "p1")).not.toBeNull();
    expect(store.resetFaultState()).toBe(1);
  });

  it("atomically gates a new known-fix episode and preserves replay no-op", () => {
    const first = store.admitEventWithCooldown({
      eventKey: "known-fix-event-1",
      fingerprint: "known-fix-fingerprint",
      workflowKind: "known_fix",
      source: "scheduled",
      sourceScope: "daily-ai",
      taskKind: "agent",
      mode: "full",
      diagnosticJson: "{}",
      occurredAt: Date.now(),
    }, "autofix-known", "known-fix", 30, "2026-08-21T10:00:00.000Z");
    expect(first.kind).toBe("created");
    expect(store.faultState("autofix-known", "known-fix")?.totalRuns).toBe(1);

    const replay = store.admitEventWithCooldown({
      eventKey: "known-fix-event-1",
      fingerprint: "known-fix-fingerprint",
      workflowKind: "known_fix",
      source: "scheduled",
      sourceScope: "daily-ai",
      taskKind: "agent",
      mode: "full",
      diagnosticJson: "{}",
      occurredAt: Date.now(),
    }, "autofix-known", "known-fix", 30, "2026-08-21T10:01:00.000Z");
    expect(replay.kind).toBe("duplicate_event");

    // End the first episode so the next distinct event reaches the cooldown
    // gate rather than attaching to the active one.
    if (first.kind === "created") {
      store.transition({
        incidentId: first.incidentId,
        expectedVersion: 1,
        fromStates: ["provisioning"],
        toState: "known_fix_failed",
        reason: "test terminal",
      });
    }
    const blocked = store.admitEventWithCooldown({
      eventKey: "known-fix-event-2",
      fingerprint: "known-fix-fingerprint-2",
      workflowKind: "known_fix",
      source: "scheduled",
      sourceScope: "daily-ai",
      taskKind: "agent",
      mode: "full",
      diagnosticJson: "{}",
      occurredAt: Date.now(),
    }, "autofix-known", "known-fix", 30, "2026-08-21T10:02:00.000Z");
    expect(blocked.kind).toBe("cooldown");
    expect(store.faultState("autofix-known", "known-fix")?.totalRuns).toBe(1);
  });
});

describe("recovery reads (R5)", () => {
  it("lists nonterminal rows and event existence", () => {
    const first = admit();
    if (first.kind !== "created") return;
    expect(store.eventExists("task:daily-ai:run:r1")).toBe(true);
    expect(store.eventExists("task:daily-ai:run:nope")).toBe(false);
    expect(store.listNonTerminal().map((i) => i.id)).toEqual([first.incidentId]);
    expect(store.listSummaries()).toHaveLength(1);
    expect(store.listSummaries()[0]?.fingerprintPrefix).toBe(FP_A.slice(0, 8));
  });
});
