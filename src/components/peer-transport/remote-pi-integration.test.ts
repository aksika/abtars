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
import { handlePushLifecycleEvent } from "./remote-pi-agent-api-integration.js";
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
  const remote_card_id = partial.remote_card_id ?? 42;
  const generation = partial.generation ?? 1;
  const occurred_at = partial.occurred_at ?? new Date().toISOString();
  const event_id = deriveEventId(partial.run_id, partial.sequence);
  const projection = partial.projection ?? { status: "running", generation, last_activity_at: occurred_at };
  const { content_sha256, ...rest } = { ...partial, version: 1 as const, event_id, remote_card_id, generation, occurred_at, projection };
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
    deliveryManager = new RemotePiDeliveryManager({ store, eventProducer: producer, localPeerName: "origin-peer" });
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

    it("should reject event with remote_card_id 0", () => {
      const event = buildEvent({ run_id: "run-abc", sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-123", remote_card_id: 0 });
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

    it("should produce valid events with correct remote_card_id and hash", async () => {
      const run = createMockRun({ status: "running" });
      const result = await producer.produceEvent({
        run, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1",
      });
      expect(result).not.toBeNull();

      // Verify the stored event builds a valid envelope
      const events = store.getEventsAfter({ runId: run.id, afterSequence: 0, limit: 1 });
      const envelope = producer.buildEventEnvelope(events[0]);
      expect(() => validateEventV1(envelope)).not.toThrow();
      expect(envelope.remote_card_id).toBe(42);
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

    it("rejects a changed payload replay for an already committed sequence", () => {
      const runId = "conflict-origin-" + randomUUID().slice(0, 6);
      const first = buildEvent({ run_id: runId, sequence: 1, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const changed = buildEvent({
        run_id: runId, sequence: 1, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1",
        projection: { status: "completed", generation: 1, result_summary: "different" },
      });
      expect(originReducer.reduce(first)).toBe(true);
      expect(originReducer.reduce(changed)).toBe(false);
      expect(originReducer.getProjection(runId)?.latest_status).toBe("running");
    });

    it("invokes the card projector only for accepted contiguous events", () => {
      const projected: number[] = [];
      const reducer = new RemotePiOriginReducer(new SqliteProjectionStore(taskDb), (p) => projected.push(p.latest_sequence));
      const e1 = buildEvent({ run_id: "project-card", sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e3 = buildEvent({ run_id: "project-card", sequence: 3, kind: "progress", origin_peer: "origin-peer", origin_request_id: "req-1" });
      expect(reducer.reduce(e1)).toBe(true);
      expect(reducer.reduce(e3)).toBe(false);
      expect(projected).toEqual([1]);
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
      deliveryManager = new RemotePiDeliveryManager({ store, eventProducer: producer, localPeerName: "origin-peer" });
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

    it("drainPeer sends events for runs with unacknowledged events", async () => {
      const runId = "drain-event-test-" + randomUUID().slice(0, 6);
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(),
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      expect(store.get(runId)).not.toBeNull();

      const event = buildEvent({ run_id: runId, sequence: 1, kind: "progress", origin_peer: "origin-peer", origin_request_id: "req-1" });
      store.appendEvent({
        runId, cardId: 42, generation: 1, sequence: 1,
        eventId: event.event_id, contentSha256: event.content_sha256,
        originPeer: "origin-peer", originRequestId: "req-1", kind: "progress",
        occurredAt: event.occurred_at, projectionJson: JSON.stringify(event.projection),
      });

      // Verify event is in unacknowledged list
      const pending = store.findRunsWithUnacknowledgedEvents();
      expect(pending.length).toBeGreaterThanOrEqual(1);
      const ourRun = pending.find(r => r.run_id === runId);
      expect(ourRun).toBeDefined();
      expect(ourRun!.origin_peer).toBe("origin-peer");

      const sent: Array<{ method: string; payload: unknown }> = [];
      const mockRoute = {
        hasRoute: () => true,
        sendPush: vi.fn((_peer: string, method: string, _payload: unknown) => { sent.push({ method, payload: _payload }); return true; }),
        requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(mockRoute);

      await deliveryManager.drainPeer("origin-peer");
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent[0].method).toBe("pi.lifecycle.v1");
    });
  });

  // ── Recovery tests: restart and disconnect scenarios ─────────────────────

  describe("Recovery: restart and disconnect", () => {
    it("reconstructs queued after a crash between accepted and queued append", async () => {
      const runId = "accepted-only-" + randomUUID().slice(0, 6);
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(), title: "Pi: test", goal: "test",
        workspaceAlias: "test-ws", ownerPrincipalId: "peer:origin-peer",
        origin: "peer", originPeer: "origin-peer", originRequestId: "req-1",
      });
      const run = store.get(runId)!;
      await producer.produceEvent({ run: { ...run, status: "queued" }, kind: "accepted", originPeer: "origin-peer", originRequestId: "req-1" });

      expect(await producer.recoverMissingEvents("origin-peer")).toBe(1);
      expect(store.getEventsAfter({ runId, afterSequence: 0, limit: 10 }).map(e => e.kind)).toEqual(["accepted", "queued"]);
    });

    it("unacknowledged events survive a 'restart' (new delivery manager with same store)", async () => {
      const runId = "restart-test-" + randomUUID().slice(0, 6);
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(),
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });

      // Produce events with valid hashes before "crash"
      const e1 = buildEvent({ run_id: runId, sequence: 1, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1" });
      store.appendEvent({
        runId, cardId: 42, generation: 1, sequence: 1,
        eventId: e1.event_id, contentSha256: e1.content_sha256,
        originPeer: "origin-peer", originRequestId: "req-1", kind: "running",
        occurredAt: e1.occurred_at, projectionJson: JSON.stringify(e1.projection),
      });
      const e2 = buildEvent({ run_id: runId, sequence: 2, kind: "progress", origin_peer: "origin-peer", origin_request_id: "req-1" });
      store.appendEvent({
        runId, cardId: 42, generation: 1, sequence: 2,
        eventId: e2.event_id, contentSha256: e2.content_sha256,
        originPeer: "origin-peer", originRequestId: "req-1", kind: "progress",
        occurredAt: e2.occurred_at, projectionJson: JSON.stringify(e2.projection),
      });

      // "Restart": create fresh delivery manager using same store
      const newDelivery = new RemotePiDeliveryManager({ store, eventProducer: producer, localPeerName: "origin-peer" });
      const pending = store.findRunsWithUnacknowledgedEvents();
      expect(pending.some(r => r.run_id === runId && r.origin_peer === "origin-peer")).toBe(true);

      // After restart, drain should push unacknowledged events
      const sent: Array<{ method: string; payload: unknown }> = [];
      const mockRoute = {
        hasRoute: () => true,
        sendPush: vi.fn((_peer: string, method: string, payload: unknown) => { sent.push({ method, payload }); return true; }),
        requestConnection: vi.fn(),
      };
      newDelivery.setRouteInterface(mockRoute);
      await newDelivery.drainPeer("origin-peer");
      expect(sent.length).toBe(2);
    });

    it("origin restarts from committed cursor — ignores already-acked events", async () => {
      const runId = "origin-restart-run";
      const originReducer2 = new RemotePiOriginReducer(new SqliteProjectionStore(taskDb));

      // Produce events from owner perspective
      for (let i = 1; i <= 3; i++) {
        store.appendEvent({
          runId, cardId: 42, generation: 1, sequence: i,
          eventId: deriveEventId(runId, i), contentSha256: "a".repeat(64),
          originPeer: "p", originRequestId: `req-${i}`, kind: "progress",
          occurredAt: new Date().toISOString(), projectionJson: JSON.stringify({ status: "running", generation: 1 }),
        });
      }

      // Origin reduces events 1-2 and acks
      const e1 = buildEvent({ run_id: runId, sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e2 = buildEvent({ run_id: runId, sequence: 2, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1" });
      expect(originReducer2.reduce(e1)).toBe(true);
      expect(originReducer2.reduce(e2)).toBe(true);
      expect(originReducer2.acknowledgeCursor(runId, 2)).toBe(true);
      expect(originReducer2.getCursor(runId)?.sequence).toBe(2);

      // "Restart" — create fresh reducer with same store
      const originReducerRecovered = new RemotePiOriginReducer(new SqliteProjectionStore(taskDb));
      const cursor = originReducerRecovered.getCursor(runId);
      expect(cursor).not.toBeNull();
      expect(cursor!.sequence).toBe(2);

      // After restart, origin should fetch events after cursor 2 and reduce seq 3
      const e3 = buildEvent({ run_id: runId, sequence: 3, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-3" });
      expect(originReducerRecovered.reduce(e3)).toBe(true);
      expect(originReducerRecovered.getProjection(runId)?.latest_sequence).toBe(3);

      // Stale event from before cursor is rejected
      expect(originReducerRecovered.reduce(e1)).toBe(false);
    });

    it("events produced during disconnect are pushed on reconnect", async () => {
      const run = createMockRun({ status: "running" });
      store.createPiCardAndRun({
        runId: run.id, sessionId: run.currentSessionId!,
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      const fresh = store.get(run.id)!;

      // Produce events while origin is disconnected (no route)
      const noRoute = {
        hasRoute: () => false, sendPush: vi.fn(), requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(noRoute);
      await deliveryManager.pushEvents(fresh.id, "origin-peer");

      await producer.produceEvent({
        run: fresh, kind: "running", originPeer: "origin-peer", originRequestId: "req-1",
      });
      await producer.produceEvent({
        run: fresh, kind: "progress", originPeer: "origin-peer", originRequestId: "req-1",
      });

      // Verify events accumulated
      const events = store.getEventsAfter({ runId: fresh.id, afterSequence: 0, limit: 10 });
      expect(events.length).toBe(2);

      // Reconnect: route becomes available, drain pushes pending events
      const sent: Array<{ method: string; payload: unknown }> = [];
      const reconnectedRoute = {
        hasRoute: () => true,
        sendPush: vi.fn((_peer: string, method: string, payload: unknown) => { sent.push({ method, payload }); return true; }),
        requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(reconnectedRoute);

      await deliveryManager.drainPeer("origin-peer");
      expect(sent.length).toBe(2);
      expect(sent.every(s => s.method === "pi.lifecycle.v1")).toBe(true);
    });

    it("ack flow via handlePushLifecycleEvent: first push acks, duplicate re-acks, acked event not resent", async () => {
      const runId = "via-handler-" + randomUUID().slice(0, 6);
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(),
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });

      // Owner produces event
      const event = buildEvent({ run_id: runId, sequence: 1, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1" });
      store.appendEvent({
        runId, cardId: 42, generation: 1, sequence: 1,
        eventId: event.event_id, contentSha256: event.content_sha256,
        originPeer: "origin-peer", originRequestId: "req-1", kind: "running",
        occurredAt: event.occurred_at, projectionJson: JSON.stringify(event.projection),
      });

      // First push through the production handler
      const r1 = await handlePushLifecycleEvent({ originReducer, localPeerName: "origin-peer" }, "some-owner", event);
      expect(r1.success).toBe(true);
      expect(r1.runId).toBe(runId);
      expect(r1.sequence).toBe(1);
      expect("duplicate" in r1 ? r1.duplicate : false).toBe(false);

      // Origin acknowledges (the ack that push handler would send via broker)
      store.acknowledgeEvents(runId, r1.sequence);

      // Event is no longer unacknowledged — drain sends nothing
      expect(store.getUnacknowledgedEvents(runId, 10).length).toBe(0);
      const sent: Array<{ method: string }> = [];
      deliveryManager.setRouteInterface({
        hasRoute: () => true,
        sendPush: vi.fn((_p: string, m: string) => { sent.push({ method: m }); return true; }),
        requestConnection: vi.fn(),
      });
      await deliveryManager.drainPeer("origin-peer");
      expect(sent.length).toBe(0);

      // Simulate lost ack: owner resends same event.
      // Handler must return success with duplicate:true so the caller
      // re-sends the cumulative ack.
      const r2 = await handlePushLifecycleEvent({ originReducer, localPeerName: "origin-peer" }, "some-owner", event);
      expect(r2.success).toBe(true);
      expect("duplicate" in r2 ? r2.duplicate : false).toBe(true);
      expect(r2.runId).toBe(runId);
      expect(r2.sequence).toBe(1);
    });

    it("gap detection via handlePushLifecycleEvent: seq 3 rejected with gapDetected, seq 2 fills gap, seq 3 succeeds", async () => {
      const runId = "via-gap-handler-" + randomUUID().slice(0, 6);
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(),
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });

      const e1 = buildEvent({ run_id: runId, sequence: 1, kind: "accepted", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e2 = buildEvent({ run_id: runId, sequence: 2, kind: "running", origin_peer: "origin-peer", origin_request_id: "req-1" });
      const e3 = buildEvent({ run_id: runId, sequence: 3, kind: "progress", origin_peer: "origin-peer", origin_request_id: "req-1" });

      store.appendEvent({
        runId, cardId: 42, generation: 1, sequence: 1,
        eventId: e1.event_id, contentSha256: e1.content_sha256,
        originPeer: "origin-peer", originRequestId: "req-1", kind: "accepted",
        occurredAt: e1.occurred_at, projectionJson: JSON.stringify(e1.projection),
      });
      store.appendEvent({
        runId, cardId: 42, generation: 1, sequence: 2,
        eventId: e2.event_id, contentSha256: e2.content_sha256,
        originPeer: "origin-peer", originRequestId: "req-1", kind: "running",
        occurredAt: e2.occurred_at, projectionJson: JSON.stringify(e2.projection),
      });
      store.appendEvent({
        runId, cardId: 42, generation: 1, sequence: 3,
        eventId: e3.event_id, contentSha256: e3.content_sha256,
        originPeer: "origin-peer", originRequestId: "req-1", kind: "progress",
        occurredAt: e3.occurred_at, projectionJson: JSON.stringify(e3.projection),
      });

      // Seq 1: first push succeeds
      const r1 = await handlePushLifecycleEvent({ originReducer, localPeerName: "origin-peer" }, "some-owner", e1);
      expect(r1.success).toBe(true);
      expect(r1.sequence).toBe(1);

      // Seq 3 before seq 2: detected as gap
      const r3 = await handlePushLifecycleEvent({ originReducer, localPeerName: "origin-peer" }, "some-owner", e3);
      expect(r3.success).toBe(false);
      expect("gapDetected" in r3 ? r3.gapDetected : false).toBe(true);

      // Seq 2 fills the gap
      const r2 = await handlePushLifecycleEvent({ originReducer, localPeerName: "origin-peer" }, "some-owner", e2);
      expect(r2.success).toBe(true);
      expect(r2.sequence).toBe(2);

      // Now seq 3 succeeds (no longer a gap)
      const r3b = await handlePushLifecycleEvent({ originReducer, localPeerName: "origin-peer" }, "some-owner", e3);
      expect(r3b.success).toBe(true);
      expect(r3b.sequence).toBe(3);
    });
  });

  // ── 2026-08-10 review invariants: mechanism A, namespacing, drain budget ─

  describe("Review invariant #1: transition/outbox atomicity (mechanism A)", () => {
    beforeEach(() => {
      // Wire the in-transaction emitter so every public transition appends
      // its outbox event in the SAME transaction.
      store.setRemoteEventEmitter(producer);
    });

    const createDelegatedRun = (runId: string) => {
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(),
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      return store.get(runId)!;
    };

    const kindsFor = (runId: string): string[] =>
      store.getEventsAfter({ runId, afterSequence: 0, limit: 100 }).map(e => e.kind);

    it("creation commits accepted + queued inside the creation transaction", () => {
      const runId = "atomic-create-" + randomUUID().slice(0, 6);
      createDelegatedRun(runId);
      expect(kindsFor(runId)).toEqual(["accepted", "queued"]);
    });

    it("emits the transient fact chain exactly once, in order: awaiting_input → input_cleared → interrupted → resumed", () => {
      const runId = "atomic-chain-" + randomUUID().slice(0, 6);
      const run = createDelegatedRun(runId);

      // queued → starting → running
      expect(store.casTransition(runId, "queued", "starting")).toBe(true);
      expect(store.casTransition(runId, "starting", "running")).toBe(true);

      // running → awaiting_input (dialog enter)
      expect(store.setPendingUi({ runId, generation: 1, requestId: "req-9", requestType: "select" }).ok).toBe(true);
      expect(store.get(runId)!.status).toBe("awaiting_input");

      // awaiting_input → running (reply accepted → input_cleared)
      const claim = store.claimPendingUi({ runId, generation: 1, requestId: "req-9" });
      expect(claim.claimed).toBe(true);

      // running → interrupted (shutdown / cancellation path)
      expect(store.casTransition(runId, "running", "interrupted")).toBe(true);

      // interrupted → queued with generation bump (approved resume)
      const resume = store.queueResumeGeneration({
        runId, expectedGeneration: 1, newSessionId: "s2", sessionFile: "/tmp/x.json",
      });
      expect(resume.committed).toBe(true);
      expect(resume.newGeneration).toBe(2);

      // Every transient fact is durable in order; none can be reconstructed
      // from a snapshot of current run state, so they must be in the outbox.
      expect(kindsFor(runId)).toEqual([
        "accepted", "queued", "starting", "running", "awaiting_input",
        "input_cleared", "interrupted", "resumed",
      ]);
      // Resumed event carries the new generation.
      const resumedEvent = store.getEventsAfter({ runId, afterSequence: 0, limit: 100 }).find(e => e.kind === "resumed")!;
      const resumedProjection = JSON.parse(resumedEvent.projection_json) as { generation: number; status: string };
      expect(resumedProjection.generation).toBe(2);
      expect(resumedProjection.status).toBe("queued");
      void run;
    });

    it("settleTerminal commits the terminal event with the transition", () => {
      const runId = "atomic-term-" + randomUUID().slice(0, 6);
      createDelegatedRun(runId);
      expect(store.casTransition(runId, "queued", "starting")).toBe(true);
      expect(store.casTransition(runId, "starting", "running")).toBe(true);

      const settlement = store.settleTerminal({
        runId, generation: 1, expectedStatuses: ["running"],
        outcome: "completed",
        metadata: { resultSummary: "done!", usageJson: JSON.stringify({ total_tokens: 10 }) },
      });
      expect(settlement.committed).toBe(true);

      const kinds = kindsFor(runId);
      expect(kinds[kinds.length - 1]).toBe("completed");
      const terminal = store.getEventsAfter({ runId, afterSequence: 0, limit: 100 }).find(e => e.kind === "completed")!;
      const proj = JSON.parse(terminal.projection_json) as { result_summary: string; usage: { total_tokens: number } };
      expect(proj.result_summary).toBe("done!");
      expect(proj.usage.total_tokens).toBe(10);
    });

    it("aborts the transition when the event append fails (crash-injection proof)", () => {
      const runId = "atomic-abort-" + randomUUID().slice(0, 6);
      createDelegatedRun(runId);
      expect(store.casTransition(runId, "queued", "starting")).toBe(true);
      expect(store.casTransition(runId, "starting", "running")).toBe(true);

      // Inject a failing append: the transition transaction must roll back
      // entirely — neither the status change nor any event may survive.
      store.setRemoteEventEmitter({ emitTransitionInTx: () => { throw new Error("injected append failure"); } });
      expect(() => store.casTransition(runId, "running", "interrupted")).toThrow("injected append failure");
      expect(store.get(runId)!.status).toBe("running");
      expect(kindsFor(runId)).not.toContain("interrupted");
    });

    it("aborts run creation when the creation events cannot be appended", () => {
      store.setRemoteEventEmitter({ emitTransitionInTx: () => { throw new Error("injected append failure"); } });
      const runId = "atomic-abort-create-" + randomUUID().slice(0, 6);
      expect(() => createDelegatedRun(runId)).toThrow("injected append failure");
      expect(store.get(runId)).toBeNull();
    });
  });

  describe("Review invariant #4: identifier namespace separation", () => {
    it("never serializes a bare card_id on the event path", () => {
      const runId = "ns-" + randomUUID().slice(0, 6);
      store.setRemoteEventEmitter(producer);
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(),
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      const events = store.getEventsAfter({ runId, afterSequence: 0, limit: 100 });
      for (const row of events) {
        expect(Object.keys(row)).not.toContain("card_id");
        const envelope = producer.buildEventEnvelope(row);
        expect(Object.keys(envelope)).not.toContain("card_id");
        expect(envelope.remote_card_id).toBeGreaterThan(0);
      }
    });

    it("origin projection store has no index or key over the remote card ID", () => {
      const projection = new SqliteProjectionStore(taskDb);
      void projection;
      const indexes = (taskDb.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'remote_pi_origin_projections'`
      ).all() as Array<{ name: string }>);
      expect(indexes.map(i => i.name)).not.toContain("idx_remote_projections_card");
      // A remote card ID colliding with an unrelated local card ID cannot
      // corrupt a projection: lookups are keyed by run_id, never by the ID.
      const runId = "ns-collide-" + randomUUID().slice(0, 6);
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(),
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      const run = store.get(runId)!;
      const event = {
        version: 1 as const,
        event_id: deriveEventId(runId, 1),
        origin_peer: "origin-peer",
        origin_request_id: "req-ns",
        run_id: runId,
        remote_card_id: run.cardId,
        generation: 1,
        sequence: 1,
        kind: "accepted" as const,
        occurred_at: new Date().toISOString(),
        projection: { status: "queued", generation: 1, last_activity_at: new Date().toISOString() },
      };
      const hash = computeEventHash(event);
      const fullEvent = { ...event, content_sha256: hash };
      const reducer = new RemotePiOriginReducer(new SqliteProjectionStore(taskDb));
      expect(reducer.reduce(fullEvent)).toBe(true);
      // Another run whose remote_card_id equals a local card ID cannot be
      // bound to that card: the projection row is keyed by run_id only.
      const projectionRow = (taskDb.prepare(
        `SELECT run_id, remote_card_id FROM remote_pi_origin_projections WHERE run_id = ?`
      ).get(runId));
      expect(projectionRow).toEqual({ run_id: runId, remote_card_id: run.cardId });
    });
  });

  describe("Review invariant #2: remote-pi-drain budget", () => {
    it("caps runs drained per peer per pass", async () => {
      const sent: string[] = [];
      const mockRoute = {
        hasRoute: () => true,
        sendPush: vi.fn((_peer: string, method: string, payload: { run_id: string }) => { sent.push(payload.run_id); return true; }),
        requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(mockRoute);

      for (let i = 0; i < 3; i++) {
        const runId = `budget-r${i}-${randomUUID().slice(0, 4)}`;
        store.createPiCardAndRun({
          runId, sessionId: randomUUID(),
          title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
          ownerPrincipalId: "peer:origin-peer", origin: "peer",
          originPeer: "origin-peer",
        });
        const ev = buildEvent({ run_id: runId, sequence: 1, kind: "progress", origin_peer: "origin-peer", origin_request_id: "req" });
        store.appendEvent({
          runId, cardId: 42, generation: 1, sequence: 1,
          eventId: ev.event_id, contentSha256: ev.content_sha256,
          originPeer: "origin-peer", originRequestId: "req", kind: "progress",
          occurredAt: ev.occurred_at, projectionJson: JSON.stringify(ev.projection),
        });
      }

      await deliveryManager.drainPeer("origin-peer", { maxRunsPerPeer: 2, deadlineMs: Date.now() + 5000 });
      // 3 runs exist but the cap is 2 → only 2 runs pushed.
      expect(new Set(sent).size).toBe(2);
    });

    it("honors the deadline: nothing is pushed after expiry", async () => {
      const sent: string[] = [];
      const mockRoute = {
        hasRoute: () => true,
        sendPush: vi.fn((_peer: string, _method: string, payload: { run_id: string }) => { sent.push(payload.run_id); return true; }),
        requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(mockRoute);
      const runId = "budget-deadline-" + randomUUID().slice(0, 4);
      store.createPiCardAndRun({
        runId, sessionId: randomUUID(),
        title: "Pi: test", goal: "test", workspaceAlias: "test-ws",
        ownerPrincipalId: "peer:origin-peer", origin: "peer",
        originPeer: "origin-peer",
      });
      const ev = buildEvent({ run_id: runId, sequence: 1, kind: "progress", origin_peer: "origin-peer", origin_request_id: "req" });
      store.appendEvent({
        runId, cardId: 42, generation: 1, sequence: 1,
        eventId: ev.event_id, contentSha256: ev.content_sha256,
        originPeer: "origin-peer", originRequestId: "req", kind: "progress",
        occurredAt: ev.occurred_at, projectionJson: JSON.stringify(ev.projection),
      });

      await deliveryManager.drainPeer("origin-peer", { deadlineMs: Date.now() - 1 });
      expect(sent).toHaveLength(0);
    });

    it("persists the round-robin cursor across delivery-manager restarts", () => {
      deliveryManager.setDrainCursor(3);
      expect(deliveryManager.getDrainCursor()).toBe(3);
      // A new manager over the same store sees the same cursor.
      const fresh = new RemotePiDeliveryManager({ store, eventProducer: producer, localPeerName: "origin-peer" });
      expect(fresh.getDrainCursor()).toBe(3);
    });

    it("skips an overlapping drain instead of queueing it", async () => {
      const mockRoute = {
        hasRoute: () => true,
        sendPush: vi.fn(() => { return true; }),
        requestConnection: vi.fn(),
      };
      deliveryManager.setRouteInterface(mockRoute);
      const p1 = deliveryManager.drainPeer("origin-peer");
      // Second call while the first is in flight must not await the first.
      const p2 = deliveryManager.drainPeer("origin-peer");
      await Promise.all([p1, p2]);
      expect((deliveryManager as any).drainInFlight.size).toBe(0);
    });
  });
});
