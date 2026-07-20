/**
 * peer-transport/remote-pi-integration.test.ts — Integration tests (#1358).
 *
 * Tests for event contract/hashing, gap handling, command idempotency,
 * resume approval enforcement, and control operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { resolveNativeDep } from "../../utils/lazy-require.js";

type SqliteDb = { prepare(sql: string): any; exec(sql: string): void; pragma(s: string): void; transaction<T>(fn: () => T): () => T };

import { RemotePiEventProducer, buildPublicProjection } from "./remote-pi-event-producer.js";
import { RemotePiControlHandler } from "./remote-pi-control-handler.js";
import { RemotePiDeliveryManager } from "./remote-pi-delivery.js";
import { RemotePiOriginReducer, SqliteProjectionStore } from "./remote-pi-origin-projection.js";
import { PiRunStore } from "../pi-executor/pi-run-store.js";
import type { PiRunService } from "../pi-executor/pi-run-service.js";
import {
  computeEventHash,
  computeControlRequestHash,
  canonicalApprovalStatement,
  deriveEventId,
  validateEventV1,
  validatePublicProjection,
  REMOTE_PI_BOUNDS,
  type RemotePiEventV1,
  type RemotePiControlRequestV1,
  type ResumeApprovalV1,
} from "./remote-pi-types.js";
import type { PiRunRecord, PiRunStatus } from "../pi-executor/types.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

/** Build a valid event envelope with correct hash. */
function buildEvent(partial: Partial<RemotePiEventV1> & Pick<RemotePiEventV1, "run_id" | "sequence" | "kind" | "origin_peer" | "origin_request_id">): RemotePiEventV1 {
  const card_id = partial.card_id ?? 42;
  const generation = partial.generation ?? 1;
  const occurred_at = partial.occurred_at ?? new Date().toISOString();
  const event_id = deriveEventId(partial.run_id, partial.sequence);
  const projection = partial.projection ?? { status: "running", generation, last_activity_at: occurred_at };
  const { content_sha256, ...rest } = { ...partial, version: 1 as const, event_id, card_id, generation, occurred_at, projection };
  const hash = computeEventHash(rest);
  return { ...rest, content_sha256: hash };
}

/** Build a valid resume approval with correct statement hash. */
function buildApproval(partial: Partial<ResumeApprovalV1> & Pick<ResumeApprovalV1, "approval_id" | "run_id" | "origin_peer" | "command_id">): ResumeApprovalV1 {
  const base: Omit<ResumeApprovalV1, "approval_statement_sha256"> = {
    approval_id: partial.approval_id,
    run_id: partial.run_id,
    origin_peer: partial.origin_peer,
    command_id: partial.command_id,
    approving_principal: partial.approving_principal ?? "operator",
    issued_at: partial.issued_at ?? new Date(Date.now() - 1000).toISOString(),
    expires_at: partial.expires_at ?? new Date(Date.now() + 3600000).toISOString(),
    interrupted_generation: partial.interrupted_generation ?? 1,
  };
  const hash = require("node:crypto").createHash("sha256").update(canonicalApprovalStatement(base), "utf-8").digest("hex");
  return { ...base, approval_statement_sha256: hash };
}

describe("Remote Pi Integration (#1358)", () => {
  let db: SqliteDb;
  let taskDb: TaskDatabase;
  let store: PiRunStore;
  let producer: RemotePiEventProducer;
  let deliveryManager: RemotePiDeliveryManager;
  let originReducer: RemotePiOriginReducer;
  let controlHandler: RemotePiControlHandler;

  beforeEach(() => {
    const Database = resolveNativeDep("better-sqlite3") as typeof import("better-sqlite3");
    db = new Database(":memory:");
    taskDb = createTaskDatabase(db);
    store = new PiRunStore({ db: taskDb });
    producer = new RemotePiEventProducer({ store });
    deliveryManager = new RemotePiDeliveryManager({ store, producer, localPeerName: "origin-peer" });
    originReducer = new RemotePiOriginReducer(new SqliteProjectionStore(taskDb));

    const mockService = {
      reply: async () => ({ claimed: true }),
      steer: async () => true,
      cancel: async () => true,
      resume: async () => ({ runId: "test", cardId: 1, generation: 2, sessionId: "s2" }),
    } as unknown as PiRunService;

    controlHandler = new RemotePiControlHandler({ store, service: mockService });
  });

  afterEach(() => { db.close(); });

  function createTaskDatabase(db: SqliteDb): TaskDatabase {
    // The PiRunStore references kanban_board from createPiCardAndRun; create
    // a minimal table so the new "Review fixes" tests can use that path.
    db.exec(`CREATE TABLE IF NOT EXISTS kanban_board (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'pi',
      source_id TEXT,
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      type TEXT NOT NULL DEFAULT 'pi',
      notes TEXT,
      delivery_mode TEXT NOT NULL DEFAULT 'silent',
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      error TEXT,
      result_summary TEXT,
      result_path TEXT
    )`);
    return {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        return {
          run(...params: unknown[]) { return stmt.run(...params); },
          get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
          all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
        };
      },
      exec(sql: string) { db.exec(sql); },
      transaction<T>(fn: () => T): T { return db.transaction(fn)() as T; },
    };
  }

  function createMockRun(overrides: Partial<PiRunRecord> = {}): PiRunRecord {
    return {
      id: randomUUID().slice(0, 12),
      cardId: 42,
      workspaceAlias: "default",
      operationalGoal: "Test goal",
      ownerPrincipalId: "peer:origin-peer",
      origin: "peer",
      originPeer: "origin-peer",
      executionGeneration: 1,
      currentSessionId: randomUUID(),
      status: "running",
      resumeCapability: "available",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    } as PiRunRecord;
  }

  // ── Task 1: Event contract and hashing ──────────────────────────────────

  describe("Task 1: Event contract and hashing", () => {
    it("should validate a correctly hashed event", () => {
      const event = buildEvent({ run_id: "run-abc", sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-123" });
      expect(() => validateEventV1(event)).not.toThrow();
    });

    it("should reject event with tampered content (hash mismatch)", () => {
      const event = buildEvent({ run_id: "run-abc", sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-123" });
      // Tamper with projection after hashing
      event.projection.status = "completed";
      expect(() => validateEventV1(event)).toThrow("Content hash mismatch");
    });

    it("should reject event with card_id 0", () => {
      const event = buildEvent({ run_id: "run-abc", sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-123", card_id: 0 });
      expect(() => validateEventV1(event)).toThrow("invalid identifiers");
    });

    it("should reject oversized projection strings", () => {
      const event = buildEvent({
        run_id: "run-abc", sequence: 1, kind: "completed", origin_peer: "origin-peer", origin_request_id: "req-123",
        projection: { status: "completed", generation: 1, result_summary: "x".repeat(REMOTE_PI_BOUNDS.MAX_PROJECTION_STRING + 1) },
      });
      expect(() => validateEventV1(event)).toThrow("exceeds");
    });
  });

  // ── Task 2: Durable transaction domain ──────────────────────────────────

  describe("Task 2: Durable transaction domain", () => {
    it("should allocate monotonically increasing sequence numbers", () => {
      // allocateNextSequence is a read-only MAX(sequence)+1 query.
      // It returns the next sequence to use; the increment happens when
      // an event is actually appended.
      expect(store.allocateNextSequence("r1")).toBe(1);
      store.appendEvent({
        runId: "r1", cardId: 42, generation: 1, sequence: 1,
        eventId: deriveEventId("r1", 1), contentSha256: "a".repeat(64),
        originPeer: "p", originRequestId: "req-1", kind: "accepted",
        occurredAt: new Date().toISOString(), projectionJson: "{}",
      });
      expect(store.allocateNextSequence("r1")).toBe(2);
    });

    it("should allocate independent sequences per run", () => {
      expect(store.allocateNextSequence("run-a")).toBe(1);
      expect(store.allocateNextSequence("run-b")).toBe(1);
      store.appendEvent({
        runId: "run-a", cardId: 42, generation: 1, sequence: 1,
        eventId: deriveEventId("run-a", 1), contentSha256: "a".repeat(64),
        originPeer: "p", originRequestId: "req-1", kind: "accepted",
        occurredAt: new Date().toISOString(), projectionJson: "{}",
      });
      expect(store.allocateNextSequence("run-a")).toBe(2);
      expect(store.allocateNextSequence("run-b")).toBe(1); // still no events
    });

    it("should reject conflicting events with same sequence", () => {
      const appended = store.appendEvent({
        runId: "r1", cardId: 42, generation: 1, sequence: 1,
        eventId: deriveEventId("r1", 1), contentSha256: "a".repeat(64),
        originPeer: "p", originRequestId: "req-1", kind: "accepted",
        occurredAt: new Date().toISOString(), projectionJson: "{}",
      });
      expect(appended).toBe(true);

      const conflict = store.appendEvent({
        runId: "r1", cardId: 42, generation: 1, sequence: 1,
        eventId: deriveEventId("r1", 1), contentSha256: "b".repeat(64),
        originPeer: "p", originRequestId: "req-1", kind: "accepted",
        occurredAt: new Date().toISOString(), projectionJson: "{}",
      });
      expect(conflict).toBe(false);
    });

    it("should idempotently accept identical event replays", () => {
      const input = {
        runId: "r1", cardId: 42, generation: 1, sequence: 1,
        eventId: deriveEventId("r1", 1), contentSha256: "a".repeat(64),
        originPeer: "p", originRequestId: "req-1", kind: "accepted",
        occurredAt: new Date().toISOString(), projectionJson: "{}",
      };
      expect(store.appendEvent(input)).toBe(true);
      expect(store.appendEvent(input)).toBe(true); // idempotent
    });
  });

  // ── Task 3: Owner-side lifecycle events ─────────────────────────────────

  describe("Task 3: Owner-side lifecycle events", () => {
    it("should build safe public projection with bounded fields", () => {
      const run = createMockRun({
        status: "awaiting_input" as PiRunStatus,
        pendingRequestId: "req-1",
        pendingRequestType: "select",
      });
      const projection = buildPublicProjection(run);
      expect(projection.status).toBe("awaiting_input");
      expect(projection.pending_input).toEqual({ request_id: "req-1", type: "select" });
    });

    it("should include usage only in terminal projections", () => {
      const run = createMockRun({
        status: "completed" as PiRunStatus,
        usageJson: JSON.stringify({ input_tokens: 100, output_tokens: 200 }),
      });
      const projection = buildPublicProjection(run);
      expect(projection.usage).toEqual({ input_tokens: 100, output_tokens: 200 });
    });

    it("should produce valid events with correct card_id and hash", async () => {
      const run = createMockRun({ status: "running" });
      const result = await producer.produceEvent({
        run, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1",
      });
      expect(result).not.toBeNull();

      // Verify the stored event builds a valid envelope
      const events = store.getEventsAfter({ runId: run.id, afterSequence: 0, limit: 1 });
      const envelope = producer.buildEventEnvelope(events[0]);
      expect(() => validateEventV1(envelope)).not.toThrow();
      expect(envelope.card_id).toBe(42);
    });

    it("should skip events for runs without origin_peer", async () => {
      const run = createMockRun({ originPeer: undefined });
      const result = await producer.produceEvent({
        run, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1",
      });
      expect(result).toBeNull();
    });
  });

  // ── Task 4 & 6: Delivery and origin ownership ───────────────────────────

  describe("Task 4/6: Delivery and origin ownership", () => {
    it("should accept event pushed by owner when origin_peer matches local", async () => {
      const event = buildEvent({ run_id: "r1", sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      // authenticatedPeer is the OWNER ("some-owner"), origin_peer is us ("origin-peer")
      const result = await deliveryManager.handleInboundEvent("some-owner", event);
      expect(result.accepted).toBe(true);
    });

    it("should reject event when origin_peer does not match local", async () => {
      const event = buildEvent({ run_id: "r1", sequence: 1, kind: "accepted", origin_peer: "wrong-peer", origin_request_id: "req-1" });
      const result = await deliveryManager.handleInboundEvent("some-owner", event);
      expect(result.accepted).toBe(false);
    });

    it("should retrieve events after a sequence for catch-up", () => {
      const runId = "catchup-run";
      for (let i = 1; i <= 5; i++) {
        store.appendEvent({
          runId, cardId: 42, generation: 1, sequence: i,
          eventId: deriveEventId(runId, i), contentSha256: "a".repeat(64),
          originPeer: "p", originRequestId: `req-${i}`, kind: "progress",
          occurredAt: new Date().toISOString(), projectionJson: "{}",
        });
      }
      const events = store.getEventsAfter({ runId, afterSequence: 2, limit: 10 });
      expect(events).toHaveLength(3);
      expect(events[0].sequence).toBe(3);
    });
  });

  // ── Task 5: Origin projection reducer with gap handling ─────────────────

  describe("Task 5: Origin projection reducer (gap handling)", () => {
    it("should reduce contiguous events", () => {
      const runId = "gap-run";
      const e1 = buildEvent({ run_id: runId, sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e2 = buildEvent({ run_id: runId, sequence: 2, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1" });

      expect(originReducer.reduce(e1)).toBe(true);
      expect(originReducer.reduce(e2)).toBe(true);
      expect(originReducer.getProjection(runId)?.latest_sequence).toBe(2);
    });

    it("should reject events that create a gap (not advance past them)", () => {
      const runId = "gap-run-2";
      const e1 = buildEvent({ run_id: runId, sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e5 = buildEvent({ run_id: runId, sequence: 5, kind: "progress", origin_peer: "origin-peer", origin_request_id: "req-1" });

      expect(originReducer.reduce(e1)).toBe(true);
      // Gap: sequence jumps 1 → 5. Must reject so catch-up can fill 2-4.
      expect(originReducer.reduce(e5)).toBe(false);
      expect(originReducer.getProjection(runId)?.latest_sequence).toBe(1);
    });

    it("should accept previously-rejected event after gap is filled", () => {
      const runId = "gap-run-3";
      const e1 = buildEvent({ run_id: runId, sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e3 = buildEvent({ run_id: runId, sequence: 3, kind: "progress", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e2 = buildEvent({ run_id: runId, sequence: 2, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1" });

      expect(originReducer.reduce(e1)).toBe(true);
      expect(originReducer.reduce(e3)).toBe(false); // gap
      expect(originReducer.reduce(e2)).toBe(true);  // fills gap
      expect(originReducer.reduce(e3)).toBe(true);  // now accepted
      expect(originReducer.getProjection(runId)?.latest_sequence).toBe(3);
    });

    it("should reject stale events (sequence already processed)", () => {
      const runId = "stale-run";
      const e1 = buildEvent({ run_id: runId, sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e2 = buildEvent({ run_id: runId, sequence: 2, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1" });

      expect(originReducer.reduce(e1)).toBe(true);
      expect(originReducer.reduce(e2)).toBe(true);
      expect(originReducer.reduce(e1)).toBe(false); // stale
    });

    it("should update acknowledged cursor", () => {
      const runId = "ack-run";
      const e1 = buildEvent({ run_id: runId, sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      originReducer.reduce(e1);
      expect(originReducer.acknowledgeCursor(runId, 1)).toBe(true);
      expect(originReducer.getCursor(runId)?.sequence).toBe(1);
    });
  });

  // ── Task 6: Owner-authorized controls ───────────────────────────────────

  describe("Task 6: Owner-authorized controls", () => {
    it("should handle status command", async () => {
      const run = createMockRun({ status: "running" });
      store.get = () => run;

      const request: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-1", run_id: run.id, expected_generation: 1,
        command: { action: "status" },
      };
      const response = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);
      expect(response.outcome).toBe("succeeded");
      expect(response.projection?.status).toBe("running");
    });

    it("should reject command from wrong peer", async () => {
      const run = createMockRun({ status: "running", originPeer: "other-peer" });
      store.get = () => run;

      const request: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-2", run_id: run.id, expected_generation: 1,
        command: { action: "status" },
      };
      const response = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);
      expect(response.outcome).toBe("rejected");
      expect(response.error?.code).toBe("FORBIDDEN_PEER");
    });

    it("should reject command with stale generation", async () => {
      const run = createMockRun({ status: "running", executionGeneration: 2 });
      store.get = () => run;

      const request: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-3", run_id: run.id, expected_generation: 1,
        command: { action: "status" },
      };
      const response = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);
      expect(response.outcome).toBe("rejected");
      expect(response.error?.code).toBe("STALE_GENERATION");
    });

    it("should return outcome_unknown for replayed side-effecting command after dispatch_started", async () => {
      const run = createMockRun({ status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });
      store.get = () => run;

      const request: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-reply", run_id: run.id, expected_generation: 1,
        command: { action: "reply", request_id: "req-1", value: "yes" },
      };

      // First dispatch — mark as dispatch_started (simulating crash before response)
      await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);

      // Simulate crash: set state back to dispatch_started
      store.updateCommand({ originPeer: "origin-peer", commandId: "cmd-reply", state: "dispatch_started", responseJson: undefined });

      // Replay — must NOT re-dispatch, must return outcome_unknown
      store.get = () => run; // still the same run
      const response = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);
      expect(response.outcome).toBe("outcome_unknown");
    });

    it("should return cached response for completed replay", async () => {
      const run = createMockRun({ status: "running" });
      store.get = () => run;

      const request: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-status-2", run_id: run.id, expected_generation: 1,
        command: { action: "status" },
      };

      const r1 = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);
      const r2 = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);
      expect(r1.outcome).toBe(r2.outcome);
    });

    it("should reject conflicting payload for same command_id", async () => {
      const run = createMockRun({ status: "running" });
      store.get = () => run;

      const req1: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-conflict", run_id: run.id, expected_generation: 1,
        command: { action: "status" },
      };
      const req2: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-conflict", run_id: "different-run", expected_generation: 1,
        command: { action: "status" },
      };

      await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, req1);
      // Different run_id → different payload hash → conflict
      const r2 = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, req2);
      expect(r2.outcome).toBe("rejected");
      expect(r2.error?.code).toBe("CONFLICTING_COMMAND");
    });
  });

  // ── Task 7: Operator-gated resume ───────────────────────────────────────

  describe("Task 7: Operator-gated resume", () => {
    it("should accept resume with valid approval and consume approval_id", async () => {
      const run = createMockRun({ status: "interrupted", executionGeneration: 1 });
      store.get = () => run;

      const approval = buildApproval({
        approval_id: "app-1", run_id: run.id, origin_peer: "origin-peer", command_id: "cmd-resume",
        interrupted_generation: 1,
      });

      const request: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-resume", run_id: run.id, expected_generation: 1,
        command: { action: "resume", approval },
      };
      const response = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);
      expect(response.outcome).toBe("succeeded");

      // Approval must be consumed
      expect(store.isApprovalConsumed("app-1")).toBe(true);
    });

    it("should reject resume with tampered approval statement hash", async () => {
      const run = createMockRun({ status: "interrupted", executionGeneration: 1 });
      store.get = () => run;

      const approval = buildApproval({
        approval_id: "app-2", run_id: run.id, origin_peer: "origin-peer", command_id: "cmd-resume-2",
        interrupted_generation: 1,
      });
      approval.approval_statement_sha256 = "0".repeat(64); // tamper

      const request: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-resume-2", run_id: run.id, expected_generation: 1,
        command: { action: "resume", approval },
      };
      const response = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);
      expect(response.outcome).toBe("rejected");
      expect(response.error?.code).toBe("INVALID_APPROVAL");
    });

    it("should reject resume reusing a consumed approval with different command", async () => {
      const run = createMockRun({ status: "interrupted", executionGeneration: 1 });
      store.get = () => run;

      const approval = buildApproval({
        approval_id: "app-3", run_id: run.id, origin_peer: "origin-peer", command_id: "cmd-a",
        interrupted_generation: 1,
      });

      const reqA: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-a", run_id: run.id, expected_generation: 1,
        command: { action: "resume", approval },
      };
      await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, reqA);

      // Try to reuse the same approval_id with a different command_id
      const approval2 = buildApproval({
        approval_id: "app-3", run_id: run.id, origin_peer: "origin-peer", command_id: "cmd-b",
        interrupted_generation: 1,
      });
      const reqB: RemotePiControlRequestV1 = {
        version: 1, command_id: "cmd-b", run_id: run.id, expected_generation: 1,
        command: { action: "resume", approval: approval2 },
      };
      const response = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, reqB);
      expect(response.outcome).toBe("rejected");
      expect(response.error?.code).toBe("INVALID_APPROVAL");
    });
  });

  // ── Task 8: Delivery policy projection ──────────────────────────────────

  describe("Task 8: Delivery policy projection", () => {
    it("should include delivery outcome in terminal projections", () => {
      const run = createMockRun({
        status: "completed",
        resultSummary: "Success",
        changedFilesSummary: "3 files changed",
      });
      const projection = buildPublicProjection(run);
      expect(projection.delivery).toBeDefined();
      expect(projection.delivery?.policy).toBe("leave_remote");
      expect(projection.changed_files_summary).toBe("3 files changed");
    });
  });

  // ── Integration: full event flow ────────────────────────────────────────

  describe("Integration: full event flow", () => {
    it("should complete full owner→origin event lifecycle", async () => {
      const run = createMockRun({ status: "running" });

      // Owner produces event
      const produced = await producer.produceEvent({
        run, kind: "progress", originPeer: "origin-peer", originRequestId: "req-int",
        progressPayload: JSON.stringify({ step: "test", percent: 50 }),
      });
      expect(produced).not.toBeNull();

      // Build envelope for delivery
      const events = store.getEventsAfter({ runId: run.id, afterSequence: 0, limit: 10 });
      expect(events).toHaveLength(1);
      const envelope = producer.buildEventEnvelope(events[0]);

      // Origin reduces
      expect(originReducer.reduce(envelope)).toBe(true);
      expect(originReducer.getProjection(run.id)?.latest_sequence).toBe(1);

      // Acknowledge
      expect(originReducer.acknowledgeCursor(run.id, 1)).toBe(true);
    });
  });

  // ── Regression tests for #1358 review fixes ──────────────────────────────

  describe("Review fixes: race condition, projection fields, awaiting_input, control ordering", () => {
    it("appendEventAuto: concurrent producers never drop events (race fix #1)", async () => {
      // Two concurrent producers for the same run must both succeed with
      // distinct sequences. The pre-fix allocateNextSequence + appendEvent
      // pair had a race window that could silently drop one of them.
      const run = createMockRun({ status: "running" });
      store.createPiCardAndRun({
        runId: run.id, sessionId: run.currentSessionId!,
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      const fresh = store.get(run.id)!;

      const [a, b, c] = await Promise.all([
        producer.produceEvent({ run: fresh, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1" }),
        producer.produceEvent({ run: fresh, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1" }),
        producer.produceEvent({ run: fresh, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1" }),
      ]);

      const sequences = [a, b, c].filter(r => r !== null).map(r => r!.sequence).sort((x, y) => x - y);
      expect(sequences).toEqual([1, 2, 3]);

      // Verify all three are persisted
      const stored = store.getEventsAfter({ runId: run.id, afterSequence: 0, limit: 10 });
      expect(stored).toHaveLength(3);
    });

    it("progress events use dedicated `progress` field, never result_summary (fix #2)", async () => {
      const run = createMockRun({ status: "running" });
      store.createPiCardAndRun({
        runId: run.id, sessionId: run.currentSessionId!,
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      const fresh = store.get(run.id)!;

      const progressPayload = JSON.stringify({ step: "running tests", message: "all green", percent: 75 });
      const result = await producer.produceEvent({
        run: fresh, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1",
        progressPayload,
      });
      expect(result).not.toBeNull();

      // Build the envelope and verify the projection has progress, NOT result_summary
      const events = store.getEventsAfter({ runId: run.id, afterSequence: 0, limit: 1 });
      const envelope = producer.buildEventEnvelope(events[0]);
      expect(envelope.projection.progress).toBeDefined();
      expect(envelope.projection.progress?.step).toBe("running tests");
      expect(envelope.projection.progress?.message).toBe("all green");
      expect(envelope.projection.progress?.percent).toBe(75);
      // The critical fix: result_summary must NOT contain progress data
      expect(envelope.projection.result_summary).toBeUndefined();
    });

    it("awaiting_input events include title, prompt, options from UI request (fix #4)", async () => {
      const run = createMockRun({ status: "running" });
      store.createPiCardAndRun({
        runId: run.id, sessionId: run.currentSessionId!,
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      // Move the run from queued → running so setPendingUi can flip it to
      // awaiting_input. Mirrors the real flow: queued runs are claimed
      // before they can receive a UI request.
      store.casTransition(run.id, "queued", "running");

      // Simulate the UI event being persisted in progress BEFORE the
      // awaiting_input transition. The setPendingUi call mirrors what
      // pi-executor does when an RPC "ui" event arrives.
      store.addProgress(run.id, "ui", JSON.stringify({
        requestId: "ui-req-1",
        type: "select",
        title: "Choose a deployment target",
        description: "Pick the environment to deploy to",
        options: [
          { id: "staging", label: "Staging" },
          { id: "prod", label: "Production" },
        ],
      }));
      const setResult = store.setPendingUi({
        runId: run.id, generation: 1, requestId: "ui-req-1", requestType: "select",
      });
      expect(setResult.ok).toBe(true);

      const fresh = store.get(run.id)!;
      expect(fresh.status).toBe("awaiting_input");
      expect(fresh.pendingRequestId).toBe("ui-req-1");

      const result = await producer.produceEvent({
        run: fresh, kind: "awaiting_input", originPeer: "origin-peer", originRequestId: "req-1",
      });
      expect(result).not.toBeNull();

      const events = store.getEventsAfter({ runId: run.id, afterSequence: 0, limit: 1 });
      const envelope = producer.buildEventEnvelope(events[0]);
      expect(envelope.projection.pending_input).toBeDefined();
      expect(envelope.projection.pending_input?.request_id).toBe("ui-req-1");
      expect(envelope.projection.pending_input?.type).toBe("select");
      expect(envelope.projection.pending_input?.title).toBe("Choose a deployment target");
      expect(envelope.projection.pending_input?.prompt).toBe("Pick the environment to deploy to");
      expect(envelope.projection.pending_input?.options).toEqual([
        { id: "staging", label: "Staging" },
        { id: "prod", label: "Production" },
      ]);
    });

    it("stale-generation control commands are rejected without polluting the ledger (fix #5)", async () => {
      const run = createMockRun({ status: "running" });
      store.createPiCardAndRun({
        runId: run.id, sessionId: run.currentSessionId!,
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      // Move the run to a status that allows a control request, then bump
      // the generation so the request at generation 1 is provably stale.
      store.casTransition(run.id, "queued", "running");
      const bumped = store.casTransition(run.id, "running", "running", { executionGeneration: 2 });
      expect(bumped).toBe(true);

      const request = {
        version: 1 as const,
        command_id: "cmd-stale-1",
        run_id: run.id,
        expected_generation: 1, // wrong — run is at generation 2
        command: { action: "cancel" as const },
      };

      const result = await controlHandler.handleControlRequest({ peerName: "origin-peer", principalId: "peer:origin-peer" }, request);

      expect(result.outcome).toBe("rejected");
      expect(result.error?.code).toBe("STALE_GENERATION");

      // The command ledger must be in a terminal state without a
      // dispatch_started residue — pre-fix, dispatch_started was written
      // before the generation check, leaving a row that had to be cleaned up.
      const cmd = store.getCommand("origin-peer", "cmd-stale-1");
      expect(cmd?.state).toBe("rejected");
    });

    it("buildPublicProjection uses byte-count truncation consistently (fix #7)", () => {
      // A 5000-character string with multi-byte UTF-8 is 15,000 bytes.
      // The shared projection builder must use byte-count, not char-count,
      // so re-validating the projection doesn't fail.
      const run = createMockRun({
        status: "completed",
        resultSummary: "ñ".repeat(5000), // each "ñ" is 2 bytes
      });

      const projection = buildPublicProjection(run);
      expect(projection.result_summary).toBeDefined();
      // The summary must be bounded by MAX_PROJECTION_STRING (5000) bytes.
      const bytes = Buffer.byteLength(projection.result_summary!, "utf-8");
      expect(bytes).toBeLessThanOrEqual(5000);
      // validatePublicProjection must accept it without throwing.
      expect(() => validatePublicProjection(projection)).not.toThrow();
    });

    it("findRunsWithUnacknowledgedEvents (renamed from fallsWith...) returns pending runs (fix #3)", async () => {
      const run = createMockRun({ status: "running" });
      store.createPiCardAndRun({
        runId: run.id, sessionId: run.currentSessionId!,
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      const fresh = store.get(run.id)!;

      // Produce a non-acked event
      await producer.produceEvent({
        run: fresh, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1",
      });

      const pending = store.findRunsWithUnacknowledgedEvents();
      expect(pending.some(r => r.run_id === run.id)).toBe(true);
    });
  });

  // ── #1455: Remote-Pi delivery drain — route interface contract ────────────

  describe("Remote-Pi delivery drain (#1455)", () => {
    beforeEach(() => {
      deliveryManager = new RemotePiDeliveryManager({ store, producer, localPeerName: "origin-peer" });
    });

    it("pushEvents returns 0 when route is null", async () => {
      const result = await deliveryManager.pushEvents("run-nonexistent", "other-peer");
      expect(result).toBe(0);
    });

    it("pushEvents returns 0 and requests connection when hasRoute returns false", async () => {
      const mockRoute = {
        hasRoute: () => false,
        sendPush: vi.fn(),
        requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(mockRoute);

      const result = await deliveryManager.pushEvents("run-nonexistent", "other-peer");
      expect(result).toBe(0);
      expect(mockRoute.requestConnection).toHaveBeenCalledWith("other-peer", "outbox");
    });

    it("pushEvents returns 0 when there are no events for the given run", async () => {
      const mockRoute = {
        hasRoute: () => true,
        sendPush: vi.fn().mockReturnValue(true),
        requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(mockRoute);

      const result = await deliveryManager.pushEvents("run-without-events", "origin-peer");
      expect(result).toBe(0);
    });

    it("drainPeer does not error when no unacknowledged events exist", async () => {
      const mockRoute = {
        hasRoute: () => true,
        sendPush: vi.fn(),
        requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(mockRoute);

      await expect(deliveryManager.drainPeer("origin-peer")).resolves.toBeUndefined();
    });

    it("drainPeer coalesces concurrent calls for the same peer", async () => {
      const drainInFlight = (deliveryManager as any).drainInFlight as Map<string, Promise<void>>;
      expect(drainInFlight.size).toBe(0);

      // First call populates the map
      const p1 = deliveryManager.drainPeer("origin-peer");
      // The drainInFlight map should have an entry immediately (before await)
      expect(drainInFlight.size).toBe(1);

      // Second call reuses the same drainInFlight entry
      const p2 = deliveryManager.drainPeer("origin-peer");
      expect(drainInFlight.size).toBe(1);

      // Wait for both to complete
      await Promise.all([p1, p2]);
      expect(drainInFlight.size).toBe(0);
    });
  });
});
