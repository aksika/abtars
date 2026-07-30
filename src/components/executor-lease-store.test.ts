import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let ExecutorLeaseStore: typeof import("./executor-lease-store.js").ExecutorLeaseStore;
let WorkerSupervisionStore: typeof import("./worker-supervision-store.js").WorkerSupervisionStore;

const TEST_ATTEMPT_ID = "a_test_001";
const TEST_CARD_ID = 42;
const TEST_CONTRACT_ID = "c_test_001";

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `lease-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const storeMod = await import("./executor-lease-store.js");
  ExecutorLeaseStore = storeMod.ExecutorLeaseStore;
  const supMod = await import("./worker-supervision-store.js");
  WorkerSupervisionStore = supMod.WorkerSupervisionStore;

  // Create a supervision store + attempt row so appendFact can validate against it
  const sup = new WorkerSupervisionStore();
  sup.insertContract({
    schema_version: 1,
    id: TEST_CONTRACT_ID,
    digest: "d1",
    goal: "test",
    criteria: [{ id: "c1", description: "test" }],
    expected_artifacts: [],
    verification_commands: [],
    required_capabilities: [],
    provenance: { root_card_id: TEST_CARD_ID, card_id: TEST_CARD_ID, authored_by: "test", created_at: new Date().toISOString() },
  }, TEST_CARD_ID);

  sup.insertAttempt({
    id: TEST_ATTEMPT_ID,
    card_id: TEST_CARD_ID,
    contract_id: TEST_CONTRACT_ID,
    ordinal: 1,
    executor_kind: "agent",
    executor_id: "spin-01",
    status: "pending",
    started_at: new Date().toISOString(),
  });
  expect(sup.lifecycleTransition(TEST_ATTEMPT_ID, ["pending"], "claimed")).toBe(true);
  expect(sup.lifecycleTransition(TEST_ATTEMPT_ID, ["claimed"], "starting")).toBe(true);
  expect(sup.lifecycleTransition(TEST_ATTEMPT_ID, ["starting"], "running")).toBe(true);
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

const ALIVE_FACT = {
  schema_version: 1 as const,
  fact_id: "fact_001",
  attempt_id: TEST_ATTEMPT_ID,
  claim_generation: 1,
  executor: { kind: "agent" as const, id: "spin-01" },
  kind: "alive" as const,
  producer_at: "2026-07-13T00:00:00.000Z",
  payload: {},
};

const MILESTONE_FACT = {
  ...ALIVE_FACT,
  fact_id: "fact_002",
  kind: "durable_milestone" as const,
  payload: { milestone_id: "m1", summary: "Evidence committed" },
};

describe("ExecutorLeaseStore", () => {
  it("creates tables on first use", () => {
    const store = new ExecutorLeaseStore();
    expect(store).toBeInstanceOf(ExecutorLeaseStore);
  });

  it("accepts a valid alive fact", () => {
    const store = new ExecutorLeaseStore();
    const result = store.appendFact(ALIVE_FACT);
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.snapshot.highWaterSequence).toBe(1);
      expect(result.snapshot.semanticState).toBe("alive");
    }
  });

  it("returns idempotent for duplicate fact_id", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    const result = store.appendFact(ALIVE_FACT);
    expect(result.kind).toBe("idempotent");
  });

  it("advances sequence with later facts", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    store.appendFact(MILESTONE_FACT);
    const snapshot = store.getSnapshot(TEST_ATTEMPT_ID);
    expect(snapshot).toBeDefined();
    expect(snapshot!.highWaterSequence).toBe(2);
  });

  it("getSnapshot returns undefined for unknown attempt", () => {
    const store = new ExecutorLeaseStore();
    expect(store.getSnapshot("nonexistent")).toBeUndefined();
  });

  it("rejects fact for nonexistent attempt", () => {
    const store = new ExecutorLeaseStore();
    const result = store.appendFact({ ...ALIVE_FACT, attempt_id: "no_such_attempt", fact_id: "fact_no" });
    expect(result.kind).toBe("rejected");
  });

  it("rejects facts while the attempt is still pending", () => {
    const sup = new WorkerSupervisionStore();
    sup.db.prepare(`UPDATE worker_attempts SET lifecycle = 'pending' WHERE id = ?`).run(TEST_ATTEMPT_ID);
    const store = new ExecutorLeaseStore();
    const result = store.appendFact({ ...ALIVE_FACT, fact_id: "fact_pending" });
    expect(result.kind).toBe("rejected");
  });

  it("rejects fact with wrong generation", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    const result = store.appendFact({ ...ALIVE_FACT, fact_id: "fact_wrong", claim_generation: 2 });
    expect(result.kind).toBe("rejected");
  });

  it("rejects fact with wrong executor kind", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    const result = store.appendFact({ ...ALIVE_FACT, fact_id: "fact_wrong_kind", executor: { kind: "pi", id: "pi-01" } });
    expect(result.kind).toBe("rejected");
  });

  it("stalled fact updates semantic state", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    const stalled = { ...ALIVE_FACT, fact_id: "fact_stalled", kind: "stalled" as const };
    store.appendFact(stalled);
    const snapshot = store.getSnapshot(TEST_ATTEMPT_ID);
    expect(snapshot!.semanticState).toBe("stalled");
  });

  it("closeLease prevents further facts", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    store.closeLease(TEST_ATTEMPT_ID, 1, "test_complete");
    const result = store.appendFact({ ...MILESTONE_FACT, fact_id: "fact_after_close" });
    expect(result.kind).toBe("rejected");
  });

  it("getView returns bounded view", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    const view = store.getView(TEST_ATTEMPT_ID);
    expect(view).toBeDefined();
    expect(view!.attemptId).toBe(TEST_ATTEMPT_ID);
    expect(view!.semanticState).toBe("alive");
    expect(typeof view!.livenessAgeSec).toBe("number");
  });

  it("getDueSnapshots returns empty when no next_evaluation", () => {
    const store = new ExecutorLeaseStore();
    const due = store.getDueSnapshots();
    expect(due).toEqual([]);
  });

  it("getActiveSnapshots returns only non-closed snapshots", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    expect(store.getActiveSnapshots()).toHaveLength(1);
    store.closeLease(TEST_ATTEMPT_ID, 1, "done");
    expect(store.getActiveSnapshots()).toHaveLength(0);
  });

  it("recordCancelIntent atomically cancels attempt and updates snapshot", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);

    const supStore = new WorkerSupervisionStore();
    const snap = store.getSnapshot(TEST_ATTEMPT_ID)!;
    const committed = store.recordCancelIntent(TEST_ATTEMPT_ID, "test_cancel", 1, snap.stateVersion);
    expect(committed).toBe(true);

    const attempt = supStore.getAttempt(TEST_ATTEMPT_ID);
    expect(attempt!.lifecycle).toBe("cancel_requested");

    const updatedSnap = store.getSnapshot(TEST_ATTEMPT_ID);
    expect(updatedSnap!.evaluation.phase).toBe("cancel_requested");
  });

  it("does not partially cancel when the snapshot CAS is stale", () => {
    const store = new ExecutorLeaseStore();
    store.appendFact(ALIVE_FACT);
    const snap = store.getSnapshot(TEST_ATTEMPT_ID)!;
    expect(store.recordCancelIntent(TEST_ATTEMPT_ID, "stale", 1, snap.stateVersion + 1)).toBe(false);
    expect(new WorkerSupervisionStore().getAttempt(TEST_ATTEMPT_ID)!.lifecycle).toBe("running");
  });

  it("redacts secret-shaped summaries before persistence", () => {
    const store = new ExecutorLeaseStore();
    const result = store.appendFact({
      ...MILESTONE_FACT,
      fact_id: "fact_secret",
      payload: { milestone_id: "m-secret", summary: "api_key=sk-12345678901234567890" },
    });
    expect(result.kind).toBe("accepted");
    const row = (new WorkerSupervisionStore()).db.prepare(`SELECT event_json FROM attempt_progress_events WHERE fact_id = ?`).get("fact_secret") as { event_json: string };
    expect(row.event_json).not.toContain("sk-12345678901234567890");
  });
});
