import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1 } from "./worker-contract.js";

let TEST_HOME: string;
let mod: typeof import("./worker-supervision-store.js");
let Store: typeof import("./worker-supervision-store.js").WorkerSupervisionStore;

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
    executor_kind: "agent",
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
      executor_kind: "agent",
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
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    });
    expect(() => store.insertAttempt({
      id: "a_test_002", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    })).toThrow();
  });

  it("getAttemptsForCard returns attempts in ordinal order", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    store.insertAttempt({
      id: "a_002", card_id: 101, contract_id: "c_test_001",
      ordinal: 2, executor_kind: "agent", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.insertAttempt({
      id: "a_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
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
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    });
    expect(store.nextOrdinal(101)).toBe(2);
  });

  it("insertResult and getResult persist envelope", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.insertResult("a_test_001", TEST_ENVELOPE);
    const row = store.getResult("a_test_001");
    expect(row).toBeDefined();
    expect(row!.envelope_digest).toBeTruthy();
  });

  it("terminalSettlement settles a new attempt", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    const result = store.terminalSettlement({ attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "test", envelope: TEST_ENVELOPE });
    expect(result.kind).toBe("settled");
    const attempt = store.getAttempt("a_test_001");
    expect(attempt!.status).toBe("settled");
    expect(attempt!.settled_at).not.toBeNull();
    expect(attempt!.lifecycle).toBe("completed");
  });

  it("terminalSettlement charges child and project exactly once", () => {
    const store = new Store();
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, parent_id, tokens_used, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', NULL, 0, ?, ?), (?, ?, ?, 'queued', 'W', ?, 0, ?, ?)`).run(
      100, "project", "test", now, now, 101, "worker", "test", 100, now, now,
    );
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-local", status: "running", started_at: now,
    });
    store.db.prepare("UPDATE worker_attempts SET reserved_tokens = 100 WHERE id = ?").run("a_test_001");
    const settled = store.terminalSettlement({
      attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "test",
      normalizedUsage: { input: 10, output: 5, trustworthy: true }, envelope: TEST_ENVELOPE,
    });
    expect(settled.kind).toBe("settled");
    expect(store.db.prepare("SELECT tokens_used FROM kanban_board WHERE id = 100").get()).toEqual({ tokens_used: 15 });
    expect(store.db.prepare("SELECT tokens_used FROM kanban_board WHERE id = 101").get()).toEqual({ tokens_used: 15 });
    expect(store.getAttempt("a_test_001")!.usage_charged_at).not.toBeNull();
    store.terminalSettlement({
      attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "replay", envelope: TEST_ENVELOPE,
      normalizedUsage: { input: 10, output: 5, trustworthy: true },
    });
    expect(store.db.prepare("SELECT tokens_used FROM kanban_board WHERE id = 100").get()).toEqual({ tokens_used: 15 });
  });

  it("terminalSettlement rejects a late result after timeout — the absence envelope blocks replay", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-local", status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    expect(store.terminalSettlement({
      attemptId: "a_test_001", expectedGeneration: 1, desiredState: "timed_out", stableReason: "deadline",
    }).kind).toBe("settled");
    expect(store.terminalSettlement({
      attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "late", envelope: TEST_ENVELOPE,
    }).kind).toBe("conflict");
  });

  it("#1588: a timed_out settlement records a readable absence envelope with not_run criteria", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    store.insertAttempt({
      id: "a_timeout_001", card_id: 101, contract_id: "c_test_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-local", status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    const result = store.terminalSettlement({
      attemptId: "a_timeout_001", expectedGeneration: 1, desiredState: "timed_out", stableReason: "deadline fired",
    });
    expect(result.kind).toBe("settled");
    const stored = store.getResultByAttempt("a_timeout_001");
    expect(stored).toBeDefined();
    expect(stored!.envelope.outcome).toBe("timed_out");
    expect(stored!.envelope.criteria).toEqual([{ criterion_id: "c1", status: "not_run", evidence_ids: [] }]);
    expect(stored!.envelope.criteria.every((c) => c.status !== "passed")).toBe(true);
    expect(stored!.envelope.checks).toEqual([]);
    expect(stored!.envelope.artifacts).toEqual([]);
    expect(stored!.envelope.attempt.contract_id).toBe("c_test_001");
    expect(stored!.envelope.attempt.contract_digest).toBe(TEST_CONTRACT.digest);
  });

  it("pending cancellation is terminal and cannot be claimed", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_pending_cancel", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "pending", started_at: "2026-07-12T00:00:00.000Z",
    });
    expect(store.cancelPendingAttempt("a_pending_cancel", "project_abort")).toBe(true);
    expect(store.getAttempt("a_pending_cancel")!.lifecycle).toBe("cancelled");
    expect(store.claimAttempt(101, "c_test_001", "agent", "spin-01", 1)).toBeNull();
  });

  it("claims a retry and its reservation atomically", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    store.insertAttempt({
      id: "a_source", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin",
      status: "failed", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.db.prepare(`
      INSERT INTO worker_attempts
        (id, card_id, contract_id, ordinal, executor_kind, executor_id, status,
         lifecycle, started_at, source_attempt_id, earliest_claim_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?)
    `).run("a_retry", 101, "c_test_001", 2, "agent", "spin", "2026-07-12T00:02:00.000Z", "a_source", "2026-07-12T00:02:00.000Z");
    store.db.prepare(`
      INSERT INTO retry_budget_reservations
        (source_attempt_id, target_attempt_id, reserved_attempts, reserved_tokens,
         reserved_cost, reserved_switches, status, created_at, updated_at)
      VALUES (?, ?, 1, 1000, 0, 0, 'active', ?, ?)
    `).run("a_source", "a_retry", "2026-07-12T00:02:00.000Z", "2026-07-12T00:02:00.000Z");

    const claim = store.claimRetryAttempt(101, "a_retry", "c_test_001", "agent", "spin", 1, "a_source");
    expect(claim?.attemptId).toBe("a_retry");
    expect(store.getAttempt("a_retry")!.lifecycle).toBe("claimed");
    expect(store.getReservation("a_source")!.status).toBe("claimed");
    expect(store.claimRetryAttempt(101, "a_retry", "c_test_001", "agent", "spin", 1, "a_source")).toBeNull();
  });

  it("rolls back a retry claim when its reservation is missing", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    store.db.prepare(`
      INSERT INTO worker_attempts
        (id, card_id, contract_id, ordinal, executor_kind, executor_id, status,
         lifecycle, started_at, source_attempt_id)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)
    `).run("a_retry", 101, "c_test_001", 1, "agent", "spin", "2026-07-12T00:02:00.000Z", "a_source");

    expect(store.claimRetryAttempt(101, "a_retry", "c_test_001", "agent", "spin", 1, "a_source")).toBeNull();
    expect(store.getAttempt("a_retry")!.lifecycle).toBe("pending");
  });

  it("terminalSettlement replays identical result", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.terminalSettlement({ attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "test", envelope: TEST_ENVELOPE });
    const result = store.terminalSettlement({ attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "test", envelope: TEST_ENVELOPE });
    expect(result.kind).toBe("replayed");
  });

  it("terminalSettlement returns conflict on envelope digest mismatch", () => {
    const store = new Store();
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.terminalSettlement({ attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "test", envelope: TEST_ENVELOPE });
    const conflictingEnvelope = { ...TEST_ENVELOPE, outcome: "failed" as const };
    const result = store.terminalSettlement({ attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "test", envelope: conflictingEnvelope });
    expect(result.kind).toBe("conflict");
  });

  it("cardHasSettledAttempts after settlement", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    expect(store.cardHasSettledAttempts(101)).toBe(false);
    store.insertAttempt({
      id: "a_test_001", card_id: 101, contract_id: "c_test_001",
      ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
    });
    store.terminalSettlement({ attemptId: "a_test_001", expectedGeneration: 1, desiredState: "completed", stableReason: "test", envelope: TEST_ENVELOPE });
    expect(store.cardHasSettledAttempts(101)).toBe(true);
  });

  it("transactions are atomic — rollback on constraint violation", () => {
    const store = new Store();
    store.insertContract(TEST_CONTRACT, 101);
    expect(() => {
      store.db.transaction(() => {
        store.insertAttempt({
          id: "a_001", card_id: 101, contract_id: "c_test_001",
          ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
          status: "pending", started_at: "now",
        });
        store.insertAttempt({
          id: "a_002", card_id: 101, contract_id: "c_test_001",
          ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
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
        ordinal: 1, executor_kind: "agent", executor_id: "spin-01",
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
        ordinal: 2, executor_kind: "agent", executor_id: "spin-01",
        status: "pending", started_at: "2026-07-12T00:00:00.000Z",
      });
      const claim2 = store.claimAttempt(101, "c_test_001", "agent", "spin-01", 2);
      expect(claim2).not.toBeNull();
      expect(store.getAttempt("a_lc_002")!.generation).toBe(2);
    });
  });

  // ── #1510: claimAttemptWithinLimits ─────────────────────────────────────

  describe("claimAttemptWithinLimits", () => {
    function setupProjectAndChild(store: InstanceType<typeof Store>): { projectId: number; cardId: number; attemptId: string } {
      const projectId = 200;
      const cardId = 201;
      const now = new Date().toISOString();
      store.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        projectId, "test project", "test", "running", "O", now, now,
      );
      store.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cardId, "test child", "test", "queued", "W", projectId, now, now,
      );
      store.insertContract({ schema_version: 1, id: "c_201", digest: "d1", goal: "test", criteria: [], expected_artifacts: [], verification_commands: [], required_capabilities: [], limits: {}, provenance: { root_card_id: projectId, card_id: cardId, authored_by: "test", created_at: now } }, cardId);
      store.insertAttempt({ id: "a_201_1", card_id: cardId, contract_id: "c_201", ordinal: 1, executor_kind: "agent", executor_id: "spin-local", status: "pending", started_at: now });
      return { projectId, cardId, attemptId: "a_201_1" };
    }

    it("claims when all conditions are met", () => {
      const s = new Store();
      const { projectId, cardId, attemptId } = setupProjectAndChild(s);
      const result = s.claimAttemptWithinLimits({
        cardId, attemptId, contractId: "c_201",
        executorKind: "agent", executorId: "spin-local", generation: 1,
        executorMax: 3, projectId, reservedTokens: 0,
      });
      expect(result.kind).toBe("claimed");
      if (result.kind === "claimed") {
        expect(result.claim.attemptId).toBe(attemptId);
      }
    });

    it("refuses when attempt lifecycle is not pending", () => {
      const s = new Store();
      const { projectId, cardId, attemptId } = setupProjectAndChild(s);
      s.lifecycleTransition(attemptId, ["pending"], "running");
      const result = s.claimAttemptWithinLimits({
        cardId, attemptId, contractId: "c_201",
        executorKind: "agent", executorId: "spin-local", generation: 1,
        executorMax: 3, projectId, reservedTokens: 0,
      });
      expect(result.kind).not.toBe("claimed");
    });

    it("refuses when card is not queued", () => {
      const s = new Store();
      const { projectId, cardId, attemptId } = setupProjectAndChild(s);
      s.db.prepare("UPDATE kanban_board SET status = 'running' WHERE id = ?").run(cardId);
      const result = s.claimAttemptWithinLimits({
        cardId, attemptId, contractId: "c_201",
        executorKind: "agent", executorId: "spin-local", generation: 1,
        executorMax: 3, projectId, reservedTokens: 0,
      });
      expect(result.kind).not.toBe("claimed");
    });

    it("refuses capacity_full when active count >= max", () => {
      const s = new Store();
      const { projectId, cardId, attemptId } = setupProjectAndChild(s);
      s.db.prepare("UPDATE worker_attempts SET lifecycle = 'running' WHERE id = ?").run(attemptId);
      const cardId2 = 203;
      const now = new Date().toISOString();
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cardId2, "child2", "test", "queued", "W", projectId, now, now,
      );
      s.insertContract({ schema_version: 1, id: "c_203", digest: "d3", goal: "test", criteria: [], expected_artifacts: [], verification_commands: [], required_capabilities: [], limits: {}, provenance: { root_card_id: projectId, card_id: cardId2, authored_by: "test", created_at: now } }, cardId2);
      s.insertAttempt({ id: "a_203_1", card_id: cardId2, contract_id: "c_203", ordinal: 1, executor_kind: "agent", executor_id: "spin-local", status: "pending", started_at: now });
      const result = s.claimAttemptWithinLimits({
        cardId: cardId2, attemptId: "a_203_1", contractId: "c_203",
        executorKind: "agent", executorId: "spin-local", generation: 1,
        executorMax: 0, projectId, reservedTokens: 0,
      });
      expect(result.kind).toBe("capacity_full");
    });

    it("refuses budget_exhausted when committed >= max_tokens", () => {
      const s = new Store();
      const { projectId, cardId, attemptId } = setupProjectAndChild(s);
      s.db.prepare("UPDATE kanban_board SET max_tokens = 100, tokens_used = 100 WHERE id = ?").run(projectId);
      const result = s.claimAttemptWithinLimits({
        cardId, attemptId, contractId: "c_201",
        executorKind: "agent", executorId: "spin-local", generation: 1,
        executorMax: 3, projectId, reservedTokens: 50,
      });
      expect(result.kind).toBe("budget_exhausted");
    });

    it("refuses budget_wait when committed + active + candidate > max_tokens", () => {
      const s = new Store();
      const { projectId, cardId, attemptId } = setupProjectAndChild(s);
      s.db.prepare("UPDATE kanban_board SET max_tokens = 100, tokens_used = 60 WHERE id = ?").run(projectId);
      const siblingId = 202;
      const now = new Date().toISOString();
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        siblingId, "sibling", "test", "queued", "W", projectId, now, now,
      );
      s.insertContract({ schema_version: 1, id: "c_202", digest: "d2", goal: "test", criteria: [], expected_artifacts: [], verification_commands: [], required_capabilities: [], limits: {}, provenance: { root_card_id: projectId, card_id: siblingId, authored_by: "test", created_at: now } }, siblingId);
      s.insertAttempt({ id: "a_202_1", card_id: siblingId, contract_id: "c_202", ordinal: 1, executor_kind: "agent", executor_id: "spin-local", status: "pending", started_at: now });
      s.db.prepare("UPDATE worker_attempts SET lifecycle = 'running', reserved_tokens = 30 WHERE id = ?").run("a_202_1");

      const result = s.claimAttemptWithinLimits({
        cardId, attemptId, contractId: "c_201",
        executorKind: "agent", executorId: "spin-local", generation: 1,
        executorMax: 3, projectId, reservedTokens: 20,
      });
      expect(result.kind).toBe("budget_wait");
    });

    it("refuses executor_mismatch when the requested pair differs from the stored pending pair", () => {
      const s = new Store();
      const { projectId, cardId, attemptId } = setupProjectAndChild(s);
      const result = s.claimAttemptWithinLimits({
        cardId, attemptId, contractId: "c_201",
        executorKind: "pi", executorId: "pi-coding", generation: 1,
        executorMax: 3, projectId, reservedTokens: 0,
      });
      expect(result.kind).toBe("executor_mismatch");
      const unchanged = s.getAttempt(attemptId);
      expect(unchanged?.lifecycle).toBe("pending");
      expect(unchanged?.executor_kind).toBe("agent");
      expect(unchanged?.executor_id).toBe("spin-local");
    });
  });

  // ── #1510: getActiveAttemptCountForExecutor ──────────────────────────────

  describe("getActiveAttemptCountForExecutor", () => {
    it("counts only nonterminal active lifecycles", () => {
      const s = new Store();
      const now = new Date().toISOString();
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(300, "p", "t", "running", "O", now, now);
      s.insertContract({ schema_version: 1, id: "c_count", digest: "d", goal: "test", criteria: [], expected_artifacts: [], verification_commands: [], required_capabilities: [], limits: {}, provenance: { root_card_id: 300, card_id: 301, authored_by: "test", created_at: now } }, 301);
      for (let i = 0; i < 5; i++) {
        s.insertAttempt({ id: `a_count_${i}`, card_id: 301 + i, contract_id: "c_count", ordinal: 1, executor_kind: "agent", executor_id: "spin-local", status: "pending", started_at: now });
        if (i < 3) s.lifecycleTransition(`a_count_${i}`, ["pending"], "running");
      }
      expect(s.getActiveAttemptCountForExecutor("agent", "spin-local")).toBe(3);
    });
  });

  // ── #1510: terminalSettlement ────────────────────────────────────────────

  describe("terminalSettlement", () => {
    function setupAttempt(s: InstanceType<typeof Store>, lifecycle: string, reservedTokens = 0, hardDeadlineAt?: string): string {
      const cardId = 400 + Math.floor(Math.random() * 1000);
      const now = new Date().toISOString();
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(399, "proj", "t", "running", "O", now, now);
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(cardId, "child", "t", "queued", "W", 399, now, now);
      const aid = `a_ts_${cardId}`;
      s.insertContract({ schema_version: 1, id: `c_ts_${cardId}`, digest: "d", goal: "test", criteria: [], expected_artifacts: [], verification_commands: [], required_capabilities: [], limits: {}, provenance: { root_card_id: 399, card_id: cardId, authored_by: "test", created_at: now } }, cardId);
      s.insertAttempt({ id: aid, card_id: cardId, contract_id: `c_ts_${cardId}`, ordinal: 1, executor_kind: "agent", executor_id: "spin-local", status: "pending", started_at: now });
      if (lifecycle !== "pending") {
        s.lifecycleTransition(aid, ["pending"], lifecycle as any);
      }
      if (reservedTokens > 0) {
        s.db.prepare("UPDATE worker_attempts SET reserved_tokens = ? WHERE id = ?").run(reservedTokens, aid);
      }
      if (hardDeadlineAt) {
        s.db.prepare("UPDATE worker_attempts SET hard_deadline_at = ? WHERE id = ?").run(hardDeadlineAt, aid);
      }
      return aid;
    }

    it("settles completed with usage charge", () => {
      const s = new Store();
      const aid = setupAttempt(s, "pending");
      s.lifecycleTransition(aid, ["pending"], "running");
      const result = s.terminalSettlement({
        attemptId: aid, expectedGeneration: 1, desiredState: "completed",
        stableReason: "test",
        normalizedUsage: { input: 100, output: 50, trustworthy: true },
      });
      expect(result.kind).toBe("settled");
      if (result.kind === "settled") {
        expect(result.chargedTokens).toBe(150);
      }
    });

    it("converts late completion to timed_out", () => {
      const s = new Store();
      const past = new Date(Date.now() - 10_000).toISOString();
      const aid = setupAttempt(s, "pending", 0, past);
      s.lifecycleTransition(aid, ["pending"], "running");
      const result = s.terminalSettlement({
        attemptId: aid, expectedGeneration: 1, desiredState: "completed",
        stableReason: "test",
      });
      expect(result.kind).toBe("settled");
      if (result.kind === "settled") {
        expect(result.lifecycle).toBe("timed_out");
      }
    });

    it("replays identical terminal state", () => {
      const s = new Store();
      const aid = setupAttempt(s, "pending");
      s.lifecycleTransition(aid, ["pending"], "running");
      s.terminalSettlement({
        attemptId: aid, expectedGeneration: 1, desiredState: "completed",
        stableReason: "test",
      });
      const replay = s.terminalSettlement({
        attemptId: aid, expectedGeneration: 1, desiredState: "completed",
        stableReason: "duplicate",
      });
      expect(replay.kind).toBe("replayed");
    });

    it("charges full reservation when usage is missing for capped attempt", () => {
      const s = new Store();
      const aid = setupAttempt(s, "pending", 5000);
      s.lifecycleTransition(aid, ["pending"], "running");
      const result = s.terminalSettlement({
        attemptId: aid, expectedGeneration: 1, desiredState: "failed",
        stableReason: "test_error",
      });
      expect(result.kind).toBe("settled");
      if (result.kind === "settled") {
        expect(result.chargedTokens).toBe(5000);
      }
    });

    it("returns stale for generation mismatch", () => {
      const s = new Store();
      const aid = setupAttempt(s, "pending");
      const result = s.terminalSettlement({
        attemptId: aid, expectedGeneration: 999, desiredState: "cancelled",
        stableReason: "test",
      });
      expect(result.kind).toBe("stale");
    });

    it("usage_charged_at prevents double charge", () => {
      const s = new Store();
      const aid = setupAttempt(s, "pending");
      s.lifecycleTransition(aid, ["pending"], "running");
      s.terminalSettlement({
        attemptId: aid, expectedGeneration: 1, desiredState: "completed",
        stableReason: "first",
        normalizedUsage: { input: 100, output: 50, trustworthy: true },
      });
      const chargedBefore = s.db.prepare("SELECT charged_tokens FROM worker_attempts WHERE id = ?").get(aid) as { charged_tokens: number };
      s.terminalSettlement({
        attemptId: aid, expectedGeneration: 1, desiredState: "completed",
        stableReason: "second",
        normalizedUsage: { input: 500, output: 500, trustworthy: true },
      });
      const chargedAfter = s.db.prepare("SELECT charged_tokens FROM worker_attempts WHERE id = ?").get(aid) as { charged_tokens: number };
      expect(chargedBefore.charged_tokens).toBe(150);
      expect(chargedAfter.charged_tokens).toBe(150);
    });

    // #1638 Task 1 characterization → Task 6 behavior: a supplied envelope
    // on a non-completed outcome is now PERSISTED (genuine failure evidence);
    // the absence envelope remains the fallback when none is supplied.
    it("non-completed settlement persists a supplied envelope (Task 6)", () => {
      const s = new Store();
      s.insertContract(TEST_CONTRACT, 101);
      const aid = setupAttempt(s, "pending");
      s.lifecycleTransition(aid, ["pending"], "running");
      const supplied: WorkerResultEnvelopeV1 = {
        schema_version: 1,
        attempt: {
          id: aid, ordinal: 1, contract_id: TEST_CONTRACT.id,
          contract_digest: TEST_CONTRACT.digest,
          executor_kind: "pi", executor_id: "pi-coding",
          started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        },
        outcome: "failed",
        criteria: [],
        checks: [],
        artifacts: [],
        worker_report: { summary: "real failure evidence", claims: [], unresolved_risks: [] },
        error: { code: "INPUT_REQUESTED", message: "question pending" },
      };
      const result = s.terminalSettlement({
        attemptId: aid, expectedGeneration: 1, desiredState: "failed",
        stableReason: "input_requested", envelope: supplied,
      });
      expect(result.kind).toBe("settled");
      const stored = s.getResultByAttempt(aid);
      expect(stored?.envelope.worker_report.summary).toBe("real failure evidence");
      expect(stored?.envelope.outcome).toBe("failed");
      expect(stored?.envelope.attempt.executor_kind).toBe("pi");
      expect(stored?.envelope.error?.code).toBe("INPUT_REQUESTED");
    });

    // #1638 Task 1 characterization: no-alias contract settles a failed
    // attempt with the absence envelope whose criteria are derived not_run.
    it("CHARACTERIZATION: no-alias failed attempt stores absence envelope with not_run criteria", () => {
      const s = new Store();
      const now = new Date().toISOString();
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(501, "proj", "t", "running", "O", now, now);
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(502, "child", "t", "queued", "W", 501, now, now);
      s.insertContract(TEST_CONTRACT, 502);
      s.insertAttempt({
        id: "a_noalias", card_id: 502, contract_id: TEST_CONTRACT.id, ordinal: 1,
        executor_kind: "agent", executor_id: "spin-local", status: "pending", started_at: now,
      });
      s.lifecycleTransition("a_noalias", ["pending"], "running");
      s.terminalSettlement({
        attemptId: "a_noalias", expectedGeneration: 1, desiredState: "failed",
        stableReason: "executor_unavailable",
      });
      const stored = s.getResultByAttempt("a_noalias");
      expect(stored?.envelope.attempt.executor_kind).toBe("agent");
      expect(stored?.envelope.criteria).toEqual([{ criterion_id: "c1", status: "not_run", evidence_ids: [] }]);
    });
  });

  describe("pruneTerminalAttempts (#1551)", () => {
    let ordinal = 0;
    function seedAttempt(store: InstanceType<typeof Store>, id: string, opts: { lifecycle: string; settledAt: string | null }) {
      ordinal += 1;
      store.db.prepare(`
        INSERT INTO worker_attempts
          (id, card_id, contract_id, ordinal, executor_kind, executor_id, status,
           lifecycle, started_at, settled_at)
        VALUES (?, 101, ?, ?, 'agent', 'spin', ?, ?, '2026-01-01T00:00:00.000Z', ?)
      `).run(id, TEST_CONTRACT.id, ordinal, opts.lifecycle, opts.lifecycle, opts.settledAt);
    }

    beforeEach((ctx) => {
      const store: InstanceType<typeof Store> = new Store();
      store.insertContract(TEST_CONTRACT, 101);
      (ctx as unknown as { store: InstanceType<typeof Store> }).store = store;
    });

    it("deletes a terminal attempt settled well before the cutoff", (ctx) => {
      const store = (ctx as unknown as { store: InstanceType<typeof Store> }).store;
      seedAttempt(store, "a_old", { lifecycle: "completed", settledAt: "2020-01-01T00:00:00.000Z" });

      const purged = store.pruneTerminalAttempts(7);

      expect(purged).toBe(1);
      expect(store.getAttempt("a_old")).toBeUndefined();
    });

    it("does not delete a terminal attempt settled inside the retention window", (ctx) => {
      const store = (ctx as unknown as { store: InstanceType<typeof Store> }).store;
      seedAttempt(store, "a_recent", { lifecycle: "completed", settledAt: new Date().toISOString() });

      const purged = store.pruneTerminalAttempts(7);

      expect(purged).toBe(0);
      expect(store.getAttempt("a_recent")).toBeDefined();
    });

    it("does not delete a non-terminal (still running) attempt regardless of age", (ctx) => {
      const store = (ctx as unknown as { store: InstanceType<typeof Store> }).store;
      seedAttempt(store, "a_running", { lifecycle: "running", settledAt: null });

      const purged = store.pruneTerminalAttempts(7);

      expect(purged).toBe(0);
      expect(store.getAttempt("a_running")).toBeDefined();
    });

    it("does not delete a terminal attempt with settled_at still NULL", (ctx) => {
      const store = (ctx as unknown as { store: InstanceType<typeof Store> }).store;
      // Defends the guard explicitly: terminal lifecycle alone is not sufficient.
      seedAttempt(store, "a_unsettled", { lifecycle: "failed", settledAt: null });

      const purged = store.pruneTerminalAttempts(7);

      expect(purged).toBe(0);
      expect(store.getAttempt("a_unsettled")).toBeDefined();
    });

    it("cascades to worker_results and released retry_budget_reservations for the pruned attempt", (ctx) => {
      const store = (ctx as unknown as { store: InstanceType<typeof Store> }).store;
      seedAttempt(store, "a_old", { lifecycle: "completed", settledAt: "2020-01-01T00:00:00.000Z" });
      store.db.prepare(`INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at) VALUES (?, '{}', 'd', '2020-01-01T00:00:00.000Z')`).run("a_old");
      store.db.prepare(`
        INSERT INTO retry_budget_reservations
          (source_attempt_id, target_attempt_id, reserved_attempts, reserved_tokens, reserved_cost, reserved_switches, status, created_at, updated_at)
        VALUES ('a_old', 'a_next', 1, 1000, 0, 0, 'released', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
      `).run();

      store.pruneTerminalAttempts(7);

      expect(store.db.prepare(`SELECT * FROM worker_results WHERE attempt_id = 'a_old'`).get()).toBeUndefined();
      expect(store.db.prepare(`SELECT * FROM retry_budget_reservations WHERE source_attempt_id = 'a_old'`).get()).toBeUndefined();
    });

    it("keeps an active reservation for a pruned source attempt (status guard, not just age)", (ctx) => {
      const store = (ctx as unknown as { store: InstanceType<typeof Store> }).store;
      seedAttempt(store, "a_old", { lifecycle: "completed", settledAt: "2020-01-01T00:00:00.000Z" });
      store.db.prepare(`
        INSERT INTO retry_budget_reservations
          (source_attempt_id, target_attempt_id, reserved_attempts, reserved_tokens, reserved_cost, reserved_switches, status, created_at, updated_at)
        VALUES ('a_old', 'a_next', 1, 1000, 0, 0, 'active', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
      `).run();

      store.pruneTerminalAttempts(7);

      // The reservation is still active (claimed by a live retry attempt) —
      // age alone must not delete it even though its source attempt is gone.
      expect(store.db.prepare(`SELECT * FROM retry_budget_reservations WHERE source_attempt_id = 'a_old'`).get()).toBeDefined();
    });
  });

  describe("executor identity migration (#1637)", () => {
    it("normalizes legacy attempt kinds and built-in Spin ID, and recomputes envelope digests", async () => {
      const store = new Store();
      store.insertContract(TEST_CONTRACT, 101);
      // Simulate a pre-#1637 database: the migration marker table does not
      // exist yet (a legacy deployment never had it), and legacy rows exist.
      store.db.exec(`DROP TABLE worker_supervision_migrations`);
      // Legacy rows as they existed before #1637: local_worker/spin attempt
      // plus an envelope whose embedded kind uses the old vocabulary.
      store.db.prepare(`
        INSERT INTO worker_attempts
          (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, lifecycle, started_at)
        VALUES ('a_legacy', 101, ?, 1, 'local_worker', 'spin', 'pending', 'pending', '2026-01-01T00:00:00.000Z')
      `).run(TEST_CONTRACT.id);
      store.db.prepare(`
        INSERT INTO worker_attempts
          (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, lifecycle, started_at)
        VALUES ('a_remote_legacy', 101, ?, 2, 'remote_worker', 'molty-x', 'pending', 'pending', '2026-01-01T00:00:00.000Z')
      `).run(TEST_CONTRACT.id);
      const legacyEnvelope = {
        schema_version: 1,
        attempt: {
          id: "a_legacy",
          ordinal: 1,
          contract_id: TEST_CONTRACT.id,
          contract_digest: TEST_CONTRACT.digest,
          executor_kind: "local_worker",
          executor_id: "spin",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:01:00.000Z",
        },
        outcome: "failed",
        criteria: [],
        checks: [],
        artifacts: [],
        worker_report: { summary: "legacy", claims: [], unresolved_risks: [] },
      };
      const legacyJson = JSON.stringify(legacyEnvelope);
      store.db.prepare(`
        INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at)
        VALUES ('a_legacy', ?, 'stale-digest', '2026-01-01T00:00:00.000Z')
      `).run(legacyJson);

      // A second constructor run is the migration trigger — same as a restart.
      const store2 = new Store();

      const local = store2.getAttempt("a_legacy");
      expect(local?.executor_kind).toBe("agent");
      expect(local?.executor_id).toBe("spin-local");
      const remote = store2.getAttempt("a_remote_legacy");
      expect(remote?.executor_kind).toBe("remote");
      expect(remote?.executor_id).toBe("molty-x");

      const result = store2.getResult("a_legacy");
      expect(result).toBeDefined();
      const migratedEnvelope = JSON.parse(result!.envelope_json) as WorkerResultEnvelopeV1;
      expect(migratedEnvelope.attempt.executor_kind).toBe("agent");
      expect(migratedEnvelope.attempt.executor_id).toBe("spin-local");
      // digest recomputed from the exact updated JSON, not the stale value
      // (the store hashes the raw envelope JSON string, sha256)
      const { createHash } = await import("node:crypto") as typeof import("node:crypto");
      const expectedDigest = createHash("sha256").update(result!.envelope_json, "utf-8").digest("hex");
      expect(result!.envelope_digest).toBe(expectedDigest);
      expect(result!.envelope_digest).not.toBe("stale-digest");

      // A second migration pass is a no-op: no legacy values remain.
      const store3 = new Store();
      const again = store3.getAttempt("a_legacy");
      expect(again?.executor_kind).toBe("agent");
      expect(store3.db.prepare(`SELECT COUNT(*) AS cnt FROM worker_attempts WHERE executor_kind IN ('local_worker','remote_worker') OR executor_id = 'spin'`).get()).toEqual({ cnt: 0 });
    });

    it("a pending pre-upgrade local_worker/spin attempt dispatches and its claim validates the stored pair", () => {
      const store = new Store();
      store.insertContract(TEST_CONTRACT, 101);
      store.db.prepare(`
        INSERT INTO worker_attempts
          (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, lifecycle, started_at)
        VALUES ('a_legacy2', 101, ?, 1, 'local_worker', 'spin', 'pending', 'pending', '2026-01-01T00:00:00.000Z')
      `).run(TEST_CONTRACT.id);

      const store2 = new Store();
      const migrated = store2.getAttempt("a_legacy2");
      expect(migrated?.executor_kind).toBe("agent");
      expect(migrated?.executor_id).toBe("spin-local");

      // Claiming with the canonical pair succeeds and does NOT rewrite the identity columns.
      const claim = store2.claimAttempt(101, TEST_CONTRACT.id, "agent", "spin-local", 1);
      expect(claim).not.toBeNull();
      const claimed = store2.getAttempt("a_legacy2");
      expect(claimed?.lifecycle).toBe("claimed");
      expect(claimed?.executor_kind).toBe("agent");
      expect(claimed?.executor_id).toBe("spin-local");
    });

    it("claim rejects a requested executor pair different from the stored pending pair", () => {
      const store = new Store();
      store.insertContract(TEST_CONTRACT, 101);
      store.insertAttempt({
        id: "a_pair", card_id: 101, contract_id: TEST_CONTRACT.id,
        ordinal: 1, executor_kind: "agent", executor_id: "spin-local",
        status: "pending", started_at: "2026-01-01T00:00:00.000Z",
      });
      expect(store.claimAttempt(101, TEST_CONTRACT.id, "agent", "other-id", 1)).toBeNull();
      expect(store.claimAttempt(101, TEST_CONTRACT.id, "pi", "pi-coding", 1)).toBeNull();
      const unchanged = store.getAttempt("a_pair");
      expect(unchanged?.lifecycle).toBe("pending");
      expect(unchanged?.executor_kind).toBe("agent");
      expect(unchanged?.executor_id).toBe("spin-local");
    });

    it("a canonical pi attempt's absence envelope reports executor_kind pi", () => {
      const store = new Store();
      store.insertContract(TEST_CONTRACT, 101);
      store.insertAttempt({
        id: "a_pi", card_id: 101, contract_id: TEST_CONTRACT.id,
        ordinal: 1, executor_kind: "pi", executor_id: "pi-coding",
        status: "pending", started_at: "2026-01-01T00:00:00.000Z",
      });
      store.db.prepare(`
        UPDATE worker_attempts SET lifecycle = 'running', status = 'running' WHERE id = 'a_pi'
      `).run();
      const settlement = store.terminalSettlement({
        attemptId: "a_pi",
        expectedGeneration: 1,
        desiredState: "failed",
        stableReason: "test",
      });
      expect(settlement.kind).toBe("settled");
      const result = store.getResultByAttempt("a_pi");
      expect(result?.envelope.attempt.executor_kind).toBe("pi");
      expect(result?.envelope.attempt.executor_id).toBe("pi-coding");
    });
  });

  describe("executor resource binding (#1638)", () => {
    function setupPiAttempt(s: InstanceType<typeof Store>, id = "a_bind"): void {
      s.insertContract(TEST_CONTRACT, 101);
      s.insertAttempt({
        id, card_id: 101, contract_id: TEST_CONTRACT.id,
        ordinal: 1, executor_kind: "pi", executor_id: "pi-coding",
        status: "pending", started_at: "2026-01-01T00:00:00.000Z",
      });
    }

    it("binds the first (attempt, generation) -> run tuple", () => {
      const s = new Store();
      setupPiAttempt(s);
      s.lifecycleTransition("a_bind", ["pending"], "claimed");
      const outcome = s.bindExecutorResource({
        attemptId: "a_bind", expectedAttemptGeneration: 1, executorKind: "pi",
        resourceId: "pirun_sup_1", resourceGeneration: 1, continuity: "initial",
      });
      expect(outcome).toBe("bound");
      const binding = s.getExecutorResourceBinding("a_bind");
      expect(binding).toEqual({ resourceId: "pirun_sup_1", resourceGeneration: 1, continuity: "initial" });
      const reverse = s.getAttemptForExecutorResource("pi", "pirun_sup_1", 1);
      expect(reverse?.id).toBe("a_bind");
    });

    it("an exact repeated bind is idempotent; a different tuple conflicts", () => {
      const s = new Store();
      setupPiAttempt(s);
      s.lifecycleTransition("a_bind", ["pending"], "claimed");
      s.bindExecutorResource({
        attemptId: "a_bind", expectedAttemptGeneration: 1, executorKind: "pi",
        resourceId: "pirun_sup_1", resourceGeneration: 1, continuity: "initial",
      });
      expect(s.bindExecutorResource({
        attemptId: "a_bind", expectedAttemptGeneration: 1, executorKind: "pi",
        resourceId: "pirun_sup_1", resourceGeneration: 1, continuity: "initial",
      })).toBe("idempotent");
      expect(s.bindExecutorResource({
        attemptId: "a_bind", expectedAttemptGeneration: 1, executorKind: "pi",
        resourceId: "pirun_sup_2", resourceGeneration: 1, continuity: "initial",
      })).toBe("conflict");
    });

    it("rejects binding for a stale attempt generation or lifecycle", () => {
      const s = new Store();
      setupPiAttempt(s);
      s.lifecycleTransition("a_bind", ["pending"], "claimed");
      expect(s.bindExecutorResource({
        attemptId: "a_bind", expectedAttemptGeneration: 99, executorKind: "pi",
        resourceId: "pirun_sup_1", resourceGeneration: 1, continuity: "initial",
      })).toBe("stale");
      expect(s.bindExecutorResource({
        attemptId: "a_bind", expectedAttemptGeneration: 1, executorKind: "pi",
        resourceId: "pirun_sup_1", resourceGeneration: 1, continuity: "initial",
      })).toBe("bound");
      s.lifecycleTransition("a_bind", ["claimed"], "running");
      // idempotency holds only in claimed|starting; a running attempt is stale
      expect(s.bindExecutorResource({
        attemptId: "a_bind", expectedAttemptGeneration: 1, executorKind: "pi",
        resourceId: "pirun_sup_1", resourceGeneration: 1, continuity: "initial",
      })).toBe("stale");
    });

    it("rejects binding across executor kinds and wrong resource generation lookup", () => {
      const s = new Store();
      setupPiAttempt(s);
      s.lifecycleTransition("a_bind", ["pending"], "claimed");
      expect(s.bindExecutorResource({
        attemptId: "a_bind", expectedAttemptGeneration: 1, executorKind: "agent",
        resourceId: "pirun_sup_1", resourceGeneration: 1, continuity: "initial",
      })).toBe("conflict");
      expect(s.getAttemptForExecutorResource("pi", "pirun_sup_1", 5)).toBeUndefined();
    });
  });

  describe("proven-no-start deferral (#1638)", () => {
    function setupStartingAttempt(s: InstanceType<typeof Store>, reservedTokens = 100): string {
      const now = new Date().toISOString();
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, ?)`).run(800, "proj", "t", now, now);
      s.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'W', ?, ?, ?)`).run(801, "child", "t", 800, now, now);
      s.insertContract({ schema_version: 1, id: "c_def", digest: "d", goal: "test", criteria: [], expected_artifacts: [], verification_commands: [], required_capabilities: [], limits: {}, provenance: { root_card_id: 800, card_id: 801, authored_by: "test", created_at: now } }, 801);
      s.insertAttempt({ id: "a_def", card_id: 801, contract_id: "c_def", ordinal: 1, executor_kind: "pi", executor_id: "pi-coding", status: "pending", started_at: now });
      s.lifecycleTransition("a_def", ["pending"], "claimed");
      s.lifecycleTransition("a_def", ["claimed"], "starting");
      if (reservedTokens > 0) s.db.prepare("UPDATE worker_attempts SET reserved_tokens = ? WHERE id = ?").run(reservedTokens, "a_def");
      s.db.prepare("UPDATE worker_attempts SET hard_deadline_at = ? WHERE id = ?").run(new Date(Date.now() + 60000).toISOString(), "a_def");
      return "a_def";
    }

    it("returns a starting attempt to pending without settling or charging", () => {
      const s = new Store();
      const aid = setupStartingAttempt(s);
      const outcome = s.deferClaimAfterProvenNoStart({ attemptId: aid, expectedGeneration: 1, reason: "resource_busy" });
      expect(outcome).toBe("deferred");
      const attempt = s.getAttempt(aid);
      expect(attempt?.lifecycle).toBe("pending");
      expect(attempt?.status).toBe("pending");
      expect(attempt?.claimed_at).toBeNull();
      expect(attempt?.hard_deadline_at).toBeNull();
      expect(attempt?.reserved_tokens).toBe(0);
      expect(s.getResultByAttempt(aid)).toBeUndefined();
    });

    it("restores a claimed retry reservation to active", () => {
      const s = new Store();
      s.insertContract(TEST_CONTRACT, 101);
      s.insertAttempt({
        id: "a_src", card_id: 101, contract_id: TEST_CONTRACT.id, ordinal: 1,
        executor_kind: "pi", executor_id: "pi-coding", status: "failed", started_at: "2026-01-01T00:00:00.000Z",
      });
      s.db.prepare(`
        INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, lifecycle, started_at, source_attempt_id, earliest_claim_at)
        VALUES ('a_retry_def', 101, ?, 2, 'pi', 'pi-coding', 'pending', 'pending', ?, 'a_src', ?)
      `).run(TEST_CONTRACT.id, "2026-01-01T00:01:00.000Z", "2026-01-01T00:01:00.000Z");
      s.db.prepare(`
        INSERT INTO retry_budget_reservations (source_attempt_id, target_attempt_id, reserved_attempts, reserved_tokens, reserved_cost, reserved_switches, status, created_at, updated_at)
        VALUES ('a_src', 'a_retry_def', 1, 100, 0, 0, 'claimed', ?, ?)
      `).run("2026-01-01T00:01:00.000Z", "2026-01-01T00:01:00.000Z");
      s.lifecycleTransition("a_retry_def", ["pending"], "claimed");
      s.lifecycleTransition("a_retry_def", ["claimed"], "starting");
      expect(s.deferClaimAfterProvenNoStart({ attemptId: "a_retry_def", expectedGeneration: 1, reason: "capacity" })).toBe("deferred");
      expect(s.getReservation("a_src")?.status).toBe("active");
    });

    it("rejects deferral for a stale generation or a running attempt", () => {
      const s = new Store();
      const aid = setupStartingAttempt(s);
      expect(s.deferClaimAfterProvenNoStart({ attemptId: aid, expectedGeneration: 99, reason: "capacity" })).toBe("stale");
      expect(s.deferClaimAfterProvenNoStart({ attemptId: aid, expectedGeneration: 1, reason: "capacity" })).toBe("deferred");
      expect(s.deferClaimAfterProvenNoStart({ attemptId: aid, expectedGeneration: 1, reason: "capacity" })).toBe("stale");
    });
  });
});
