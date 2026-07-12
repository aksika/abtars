import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1 } from "./worker-contract.js";

let TEST_HOME: string;
let mod: typeof import("./worker-supervision-store.js");
let Store: typeof import("./worker-supervision-store.js").WorkerSupervisionStore;
let SettlementResult: typeof import("./worker-supervision-store.js").SettlementResult;
let settleResult: typeof import("./worker-supervision-store.js").settleResult;

const TEST_CONTRACT: WorkerAcceptanceContractV1 = {
  schema_version: 1,
  id: "c_test_001",
  digest: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  goal: "Build report",
  criteria: [{ id: "c1", description: "Report must exist" }],
  expected_artifacts: [{ id: "a1", kind: "file", ref: "output/report.md", required: true, criterion_ids: ["c1"] }],
  verification_commands: [{ id: "v1", argv: ["test", "-f", "output/report.md"], timeout_ms: 10_000, criterion_ids: ["c1"] }],
  required_capabilities: ["shell"],
  limits: {},
  provenance: { root_card_id: 100, card_id: 101, authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
};

const TEST_ENVELOPE: WorkerResultEnvelopeV1 = {
  schema_version: 1,
  attempt: {
    id: "a_test_001",
    ordinal: 1,
    contract_id: "c_test_001",
    contract_digest: TEST_CONTRACT.digest,
    executor_kind: "local_worker",
    executor_id: "spin-01",
    started_at: "2026-07-12T00:00:00.000Z",
    finished_at: "2026-07-12T00:01:00.000Z",
  },
  outcome: "completed",
  criteria: [{ criterion_id: "c1", status: "passed", evidence_ids: ["v1"] }],
  checks: [{
    check_id: "v1",
    argv: ["test", "-f", "output/report.md"],
    started_at: "2026-07-12T00:00:00.000Z",
    finished_at: "2026-07-12T00:00:01.000Z",
    timed_out: false,
    exit_code: 0,
    signal: null,
    stdout_excerpt: "",
    stderr_excerpt: "",
  }],
  artifacts: [{ artifact_id: "a1", exists: true, kind: "file", ref: "output/report.md", size: 1024 }],
  worker_report: { summary: "Done", claims: [], unresolved_risks: [] },
};

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `sup-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  mod = await import("./worker-supervision-store.js");
  Store = mod.WorkerSupervisionStore;
  SettlementResult = mod.SettlementResult;
  settleResult = mod.settleResult;
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

describe("WorkerSupervisionStore", () => {
  it("creates tables on first use", () => {
    const store = new Store();
    expect(store).toBeInstanceOf(Store);
  });

  it("inserts and retrieves a contract", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    const row = store.getContract("c_test_001");
    expect(row).toBeDefined();
    expect(row!.card_id).toBe(101);
    expect(row!.contract_digest).toBe(TEST_CONTRACT.digest);
  });

  it("getContractByCardId returns contract", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    const row = store.getContractByCardId(101);
    expect(row).toBeDefined();
    expect(row!.id).toBe("c_test_001");
  });

  it("contractExists returns true/false", () => {
    const store = new Store();
    expect(store.contractExists(101)).toBe(false);
    store.insertContract(TEST_CONTRACT, 101);
    expect(store.contractExists(101)).toBe(true);
  });

  it("enforces UNIQUE card_id on contract", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    expect(() => store.insertContract(TEST_CONTRACT, 101)).toThrow();
  });

  it("inserts and retrieves an attempt", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    store.insertAttempt({
      id: "a_test_001",
      card_id: 101,
      contract_id: "c_test_001",
      ordinal: 1,
      executor_kind: "local_worker",
      executor_id: "spin-01",
      status: "pending",
      started_at: "2026-07-12T00:00:00.000Z",
    });
    const attempt = store.getAttempt("a_test_001");
    expect(attempt).toBeDefined();
    expect(attempt!.card_id).toBe(101);
    expect(attempt!.ordinal).toBe(1);
  });

  it("enforces UNIQUE(card_id, ordinal) on attempt", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    });
    expect(() => store.insertAttempt({
      id: "a_test_002", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    })).toThrow();
  });

  it("getAttemptsForCard returns attempts in ordinal order", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    store.insertAttempt({
      id: "a_002", card_id: 101, contract_id: "c_test_001",
      ordinal: 2, executor_kind: "local_worker", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.insertAttempt({
      id: "a_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    });
    const attempts = store.getAttemptsForCard(101);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.ordinal).toBe(1);
    expect(attempts[1]!.ordinal).toBe(2);
  });

  it("nextOrdinal starts at 1 and increments", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    expect(store.nextOrdinal(101)).toBe(1);
    store.insertAttempt({
      id: "a_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    });
    expect(store.nextOrdinal(101)).toBe(2);
  });

  it("insertResult and getResult persist envelope", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.insertResult("a_test_001", TEST_ENVELOPE);
    const row = store.getResult("a_test_001");
    expect(row).toBeDefined();
    expect(row!.envelope_digest).toBeTruthy();
  });

  it("settleResult settles a new attempt", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    const result = settleResult(store, "a_test_001", TEST_ENVELOPE, "settled");
    expect(result).toBe(SettlementResult.Settled);
    const attempt = store.getAttempt("a_test_001");
    expect(attempt!.status).toBe("settled");
    expect(attempt!.settled_at).not.toBeNull();
  });

  it("settleResult replays identical result", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    settleResult(store, "a_test_001", TEST_ENVELOPE, "settled");
    const result = settleResult(store, "a_test_001", TEST_ENVELOPE, "settled");
    expect(result).toBe(SettlementResult.Replayed);
  });

  it("settleResult returns conflict on envelope digest mismatch", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.insertResult("a_test_001", TEST_ENVELOPE);
    const conflictingEnvelope = { ...TEST_ENVELOPE, outcome: "failed" as const };
    const result = settleResult(store, "a_test_001", conflictingEnvelope, "failed");
    expect(result).toBe(SettlementResult.Conflict);
  });

  it("cardHasSettledAttempts after settlement", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    expect(store.cardHasSettledAttempts(101)).toBe(false);
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    settleResult(store, "a_test_001", TEST_ENVELOPE, "settled");
    expect(store.cardHasSettledAttempts(101)).toBe(true);
  });

  it("transactions are atomic — rollback on constraint violation", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    expect(() => {
      store.db.transaction(() => {
        store.insertAttempt({
          id: "a_001", card_id: 101, contract_id: "c_test_001",
          ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
          status: "pending", started_at: "now",
        });
        store.insertAttempt({
          id: "a_002", card_id: 101, contract_id: "c_test_001",
          ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
          status: "pending", started_at: "now",
        });
      });
    }).toThrow();
    const attempts = store.getAttemptsForCard(101);
    expect(attempts).toHaveLength(0);
  });

  describe("lifecycle transitions", () => {
    let store: import("./worker-supervision-store.js").WorkerSupervisionStore;
    beforeEach(() => {
      store = new Store();
      store.insertContract(TEST_CONTRACT, 101);
      store.insertAttempt({
        id: "a_lc_001", card_id: 101, contract_id: "c_test_001",
        ordinal: 1, executor_kind: "local_worker", executor_id: "spin-01",
        status: "pending", started_at: "2026-07-12T00:00:00.000Z",
      });
    });

    it("starts as pending lifecycle", () => {
      const attempt = store.getAttempt("a_lc_001");
      expect(attempt!.lifecycle).toBe("pending");
    });

    it("claimAttempt transitions from pending to claimed", () => {
      const claim = store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      expect(claim).not.toBeNull();
      expect(claim!.attemptId).toBe("a_lc_001");
      const attempt = store.getAttempt("a_lc_001");
      expect(attempt!.lifecycle).toBe("claimed");
      expect(attempt!.generation).toBe(1);
      expect(attempt!.claimed_at).not.toBeNull();
    });

    it("claimAttempt returns null for non-pending attempt", () => {
      store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      const claim2 = store.claimAttempt(101, "c_test_001", "agent", "spin-01", 2);
      expect(claim2).toBeNull();
    });

    it("lifecycleTransition guards against invalid transitions", () => {
      store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      const result = store.markAttemptRunning("a_lc_001");
      expect(result).toBe(true);
      expect(store.getAttempt("a_lc_001")!.lifecycle).toBe("running");
    });

    it("completeAttempt transitions from running to completed", () => {
      store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      store.markAttemptRunning("a_lc_001");
      expect(store.completeAttempt("a_lc_001")).toBe(true);
      expect(store.getAttempt("a_lc_001")!.lifecycle).toBe("completed");
    });

    it("cannot transition from completed", () => {
      store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      store.markAttemptRunning("a_lc_001");
      store.completeAttempt("a_lc_001");
      expect(store.failAttempt("a_lc_001")).toBe(false);
      expect(store.getAttempt("a_lc_001")!.lifecycle).toBe("completed");
    });

    it("requestCancel transitions from running to cancel_requested", () => {
      store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      store.markAttemptRunning("a_lc_001");
      expect(store.requestCancel("a_lc_001", "operator")).toBe(true);
      expect(store.getAttempt("a_lc_001")!.lifecycle).toBe("cancel_requested");
      expect(store.getAttempt("a_lc_001")!.cancel_reason).toBe("operator");
    });

    it("cancelled is terminal and blocks further transitions", () => {
      store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      store.cancelAttempt("a_lc_001");
      expect(store.getAttempt("a_lc_001")!.lifecycle).toBe("cancelled");
      expect(store.failAttempt("a_lc_001")).toBe(false);
    });

    it("hasLiveClaim returns true for active lifecycle", () => {
      expect(store.hasLiveClaim(101)).toBe(false);
      store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      expect(store.hasLiveClaim(101)).toBe(true);
      store.completeAttempt("a_lc_001");
      expect(store.hasLiveClaim(101)).toBe(false);
    });

    it("generation increments on sequential claims", () => {
      store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1);
      store.completeAttempt("a_lc_001");
      store.insertAttempt({
        id: "a_lc_002", card_id: 101, contract_id: "c_test_001",
        ordinal: 2, executor_kind: "local_worker", executor_id: "spin-01",
        status: "pending", started_at: "2026-07-12T00:00:00.000Z",
      });
      const claim2 = store.claimAttempt(101, "c_test_001", "agent", "spin-01", 2);
      expect(claim2).not.toBeNull();
      expect(store.getAttempt("a_lc_002")!.generation).toBe(2);
    });
  });
});
