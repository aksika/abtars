/**
 * peer-transport/remote-pi-integration.test.ts — Integration tests (#1358).
 *
 * Tests for disconnect/reconnect, event gap handling, command idempotency,
 * and control operations across the remote Pi protocol.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { resolveNativeDep } from "../../utils/lazy-require.js";

// better-sqlite3 is external (native module)
type SqliteDb = { prepare(sql: string): any; exec(sql: string): void; pragma(s: string): void; transaction<T>(fn: () => T): () => T };
import {
  RemotePiEventProducer,
  buildPublicProjection,
} from "./remote-pi-event-producer.js";
import { RemotePiControlHandler } from "./remote-pi-control-handler.js";
import { RemotePiDeliveryManager } from "./remote-pi-delivery.js";
import { RemotePiOriginReducer, SqliteProjectionStore } from "./remote-pi-origin-projection.js";
import { PiRunStore } from "../pi-executor/pi-run-store.js";
import { PiRunService } from "../pi-executor/pi-run-service.js";
import { PiExecutor } from "../pi-executor/pi-executor.js";
import { computeSha256, deriveEventId, validateEventV1, REMOTE_PI_BOUNDS } from "./remote-pi-types.js";
import type { PiRunRecord, PiRunStatus } from "../pi-executor/types.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

describe("Remote Pi Integration (#1358)", () => {
  let db: SqliteDb;
  let store: PiRunStore;
  let producer: RemotePiEventProducer;
  let deliveryManager: RemotePiDeliveryManager;
  let originReducer: RemotePiOriginReducer;
  let projectionStore: SqliteProjectionStore;
  let controlHandler: RemotePiControlHandler;

  beforeEach(() => {
    const Database = resolveNativeDep("better-sqlite3") as typeof import("better-sqlite3");
    db = new Database(":memory:");
    const taskDb = createTaskDatabase(db);
    store = new PiRunStore({ db: taskDb });
    producer = new RemotePiEventProducer({ store });
    deliveryManager = new RemotePiDeliveryManager({ store, producer });
    projectionStore = new SqliteProjectionStore(taskDb);
    producer = new RemotePiEventProducer({ store });
    deliveryManager = new RemotePiDeliveryManager({ store, producer });
    projectionStore = new SqliteProjectionStore(db);
    originReducer = new RemotePiOriginReducer(projectionStore);

    // Mock PiRunService for control handler
    const mockService = {
      get: (runId: string) => {
        const run = store.get(runId);
        return run ? store.toView(run, "test-peer") : null;
      },
      reply: async () => ({ claimed: true }),
      steer: async () => true,
      cancel: async () => true,
      resume: async () => ({ runId: "test", cardId: 1, generation: 2, sessionId: "s2" }),
    } as unknown as PiRunService;

    controlHandler = new RemotePiControlHandler({ store, service: mockService });
  });

  afterEach(() => {
    db.close();
  });

  function createTaskDatabase(db: SqliteDb): TaskDatabase {
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
      cardId: 42, // Fixed for tests
      workspaceAlias: "default",
      operationalGoal: "Test goal",
      ownerPrincipalId: "test-user",
      origin: "peer" as const,
      originPeer: "origin-peer",
      executionGeneration: 1,
      currentSessionId: randomUUID(),
      status: "queued",
      resumeCapability: "available",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      piSessionId: undefined,
      piSessionFile: undefined,
      observedPid: undefined,
      modelProvider: undefined,
      modelId: undefined,
      thinking: undefined,
      pendingRequestId: undefined,
      pendingRequestType: undefined,
      lastUiReplyRequestId: undefined,
      lastUiReplyGeneration: undefined,
      lastUiReplyOutcome: undefined,
      lastRpcActivityAt: undefined,
      resultSummary: undefined,
      changedFilesSummary: undefined,
      usageJson: undefined,
      error: undefined,
      ...overrides,
    };
  }

  describe("Task 1: Type validation and bounds", () => {
    it("should validate a complete event envelope", () => {
      const runId = "run-abc";
      const sequence = 1;
      const event = {
        version: 1 as const,
        event_id: deriveEventId(runId, sequence),
        content_sha256: "a".repeat(64),
        origin_peer: "origin-peer",
        origin_request_id: "req-123",
        run_id: runId,
        card_id: 42,
        generation: 1,
        sequence,
        kind: "accepted" as const,
        occurred_at: new Date().toISOString(),
        projection: {
          status: "queued",
          generation: 1,
          last_activity_at: new Date().toISOString(),
        },
      };
      expect(() => validateEventV1(event)).not.toThrow();
    });

    it("should reject event with mismatched event_id", () => {
      const runId = "run-abc";
      const event = {
        version: 1 as const,
        event_id: "evt_wrong",
        content_sha256: "a".repeat(64),
        origin_peer: "origin-peer",
        origin_request_id: "req-123",
        run_id: runId,
        card_id: 42,
        generation: 1,
        sequence: 1,
        kind: "accepted" as const,
        occurred_at: new Date().toISOString(),
        projection: {
          status: "queued",
          generation: 1,
          last_activity_at: new Date().toISOString(),
        },
      };
      expect(() => validateEventV1(event)).toThrow("Event ID mismatch");
    });

    it("should reject oversized projection strings", () => {
      const projection = {
        status: "queued",
        generation: 1,
        result_summary: "x".repeat(REMOTE_PI_BOUNDS.MAX_PROJECTION_STRING + 1),
      };
      expect(() => {
        const { validateBoundedString } = require("./remote-pi-types.js");
        validateBoundedString(projection.result_summary, "result_summary");
      }).toThrow();
    });
  });

  describe("Task 2: Durable transaction domain", () => {
    it("should allocate monotonically increasing sequence numbers", () => {
      const runId = "test-run-1";
      expect(store.allocateNextSequence(runId)).toBe(1);
      expect(store.allocateNextSequence(runId)).toBe(2);
      expect(store.allocateNextSequence(runId)).toBe(3);
    });

    it("should allocate independent sequences per run", () => {
      expect(store.allocateNextSequence("run-a")).toBe(1);
      expect(store.allocateNextSequence("run-b")).toBe(1);
      expect(store.allocateNextSequence("run-a")).toBe(2);
      expect(store.allocateNextSequence("run-b")).toBe(2);
    });

    it("should append events atomically", () => {
      const appended = store.appendEvent({
        runId: "test-run",
        generation: 1,
        sequence: 1,
        eventId: "evt_test_1",
        contentSha256: "a".repeat(64),
        originPeer: "origin-peer",
        originRequestId: "req-1",
        kind: "accepted",
        projectionJson: JSON.stringify({ status: "queued", generation: 1 }),
      });
      expect(appended).toBe(true);
    });

    it("should reject conflicting events with same sequence", () => {
      const eventId = deriveEventId("test-run", 1);
      store.appendEvent({
        runId: "test-run",
        generation: 1,
        sequence: 1,
        eventId,
        contentSha256: "a".repeat(64),
        originPeer: "origin-peer",
        originRequestId: "req-1",
        kind: "accepted",
        projectionJson: JSON.stringify({ status: "queued", generation: 1 }),
      });

      const conflict = store.appendEvent({
        runId: "test-run",
        generation: 1,
        sequence: 1,
        eventId,
        contentSha256: "b".repeat(64), // Different hash
        originPeer: "origin-peer",
        originRequestId: "req-1",
        kind: "accepted",
        projectionJson: JSON.stringify({ status: "running", generation: 1 }),
      });
      expect(conflict).toBe(false);
    });

    it("should reserve command slots for idempotency", () => {
      const reserved = store.reserveCommand({
        originPeer: "origin-peer",
        commandId: "cmd-1",
        runId: "test-run",
        payloadHash: "hash1",
      });
      expect(reserved).toBe(true);

      // Duplicate with same hash succeeds
      const duplicate = store.reserveCommand({
        originPeer: "origin-peer",
        commandId: "cmd-1",
        runId: "test-run",
        payloadHash: "hash1",
      });
      expect(duplicate).toBe(true);

      // Conflicting hash fails
      const conflict = store.reserveCommand({
        originPeer: "origin-peer",
        commandId: "cmd-1",
        runId: "test-run",
        payloadHash: "hash2",
      });
      expect(conflict).toBe(false);
    });
  });

  describe("Task 3: Owner-side lifecycle events", () => {
    it("should build safe public projection", () => {
      const run = createMockRun({
        status: "awaiting_input" as PiRunStatus,
        pendingRequestId: "req-1",
        pendingRequestType: "select",
        resultSummary: "Result",
        usageJson: JSON.stringify({ input_tokens: 100, output_tokens: 200 }),
      });
      const projection = buildPublicProjection(run);
      expect(projection.status).toBe("awaiting_input");
      expect(projection.generation).toBe(1);
      expect(projection.pending_input).toEqual({
        request_id: "req-1",
        type: "select",
      });
      expect(projection.usage).toEqual({
        input_tokens: 100,
        output_tokens: 200,
      });
    });

    it("should produce and append lifecycle events", async () => {
      const run = createMockRun({ status: "queued" });
      const result = await producer.produceEvent({
        run,
        kind: "accepted",
        originPeer: "origin-peer",
        originRequestId: "req-1",
      });
      expect(result).not.toBeNull();
      expect(result?.sequence).toBe(1);
      expect(result?.eventId).toBe(deriveEventId(run.id, 1));
    });

    it("should reject events for runs without origin_peer", async () => {
      const run = createMockRun({ originPeer: undefined });
      const result = await producer.produceEvent({
        run,
        kind: "accepted",
        originPeer: "origin-peer",
        originRequestId: "req-1",
      });
      expect(result).toBeNull();
    });
  });

  describe("Task 4: Push, catch-up, and acknowledgement", () => {
    it("should retrieve events after a sequence", async () => {
      const runId = "test-run-1";
      // Create some events
      for (let i = 1; i <= 5; i++) {
        store.appendEvent({
          runId,
          generation: 1,
          sequence: i,
          eventId: deriveEventId(runId, i),
          contentSha256: "a".repeat(64),
          originPeer: "origin-peer",
          originRequestId: `req-${i}`,
          kind: "progress",
          projectionJson: JSON.stringify({ status: "running", generation: 1 }),
        });
      }

      const events = store.getEventsAfter({ runId, afterSequence: 2, limit: 10 });
      expect(events).toHaveLength(3); // sequences 3, 4, 5
      expect(events[0].sequence).toBe(3);
    });

    it("should acknowledge events", () => {
      const runId = "test-run-2";
      store.appendEvent({
        runId,
        generation: 1,
        sequence: 1,
        eventId: deriveEventId(runId, 1),
        contentSha256: "a".repeat(64),
        originPeer: "origin-peer",
        originRequestId: "req-1",
        kind: "progress",
        projectionJson: JSON.stringify({ status: "running", generation: 1 }),
      });

      const count = store.acknowledgeEvents(runId, 1);
      expect(count).toBe(1);
      expect(store.getLatestAcknowledgedSequence(runId)).toBe(1);
    });

    it("should limit list results", () => {
      const runId = "test-run-3";
      for (let i = 1; i <= 150; i++) {
        store.appendEvent({
          runId,
          generation: 1,
          sequence: i,
          eventId: deriveEventId(runId, i),
          contentSha256: "a".repeat(64),
          originPeer: "origin-peer",
          originRequestId: `req-${i}`,
          kind: "progress",
          projectionJson: JSON.stringify({ status: "running", generation: 1 }),
        });
      }

      const events = store.getEventsAfter({ runId, afterSequence: 0, limit: 50 });
      expect(events).toHaveLength(50);
    });
  });

  describe("Task 5: Origin projection reducer", () => {
    it("should reduce events into projection", () => {
      const runId = "test-run";
      const sequence = 1;
      const event = {
        version: 1 as const,
        event_id: deriveEventId(runId, sequence),
        content_sha256: "a".repeat(64),
        origin_peer: "origin-peer",
        origin_request_id: "req-1",
        run_id: runId,
        card_id: 42,
        generation: 1,
        sequence,
        kind: "accepted" as const,
        occurred_at: new Date().toISOString(),
        projection: {
          status: "queued",
          generation: 1,
          last_activity_at: new Date().toISOString(),
        },
      };

      const reduced = originReducer.reduce(event);
      expect(reduced).toBe(true);

      const projection = originReducer.getProjection("test-run");
      expect(projection).not.toBeNull();
      expect(projection?.latest_sequence).toBe(1);
      expect(projection?.latest_status).toBe("queued");
    });

    it("should reject stale events", () => {
      const runId = "test-run";
      const event1 = {
        version: 1 as const,
        event_id: deriveEventId(runId, 1),
        content_sha256: "a".repeat(64),
        origin_peer: "origin-peer",
        origin_request_id: "req-1",
        run_id: runId,
        card_id: 42,
        generation: 1,
        sequence: 1,
        kind: "accepted" as const,
        occurred_at: new Date().toISOString(),
        projection: {
          status: "queued",
          generation: 1,
          last_activity_at: new Date().toISOString(),
        },
      };

      const event2 = {
        version: 1 as const,
        event_id: deriveEventId(runId, 2),
        content_sha256: "b".repeat(64),
        origin_peer: "origin-peer",
        origin_request_id: "req-1",
        run_id: runId,
        card_id: 42,
        generation: 1,
        sequence: 2,
        kind: "running" as const,
        occurred_at: new Date().toISOString(),
        projection: {
          status: "running",
          generation: 1,
          last_activity_at: new Date().toISOString(),
        },
      };

      expect(originReducer.reduce(event1)).toBe(true);
      expect(originReducer.reduce(event2)).toBe(true);
      expect(originReducer.reduce(event1)).toBe(false); // Stale
    });

    it("should update cursor on acknowledgement", () => {
      const runId = "test-run";
      const event = {
        version: 1 as const,
        event_id: deriveEventId(runId, 1),
        content_sha256: "a".repeat(64),
        origin_peer: "origin-peer",
        origin_request_id: "req-1",
        run_id: runId,
        card_id: 42,
        generation: 1,
        sequence: 1,
        kind: "accepted" as const,
        occurred_at: new Date().toISOString(),
        projection: {
          status: "queued",
          generation: 1,
          last_activity_at: new Date().toISOString(),
        },
      };

      originReducer.reduce(event);
      expect(originReducer.acknowledgeCursor("test-run", 1)).toBe(true);
      expect(originReducer.getCursor("test-run")?.sequence).toBe(1);
    });
  });

  describe("Task 6: Owner-authorized controls", () => {
    it("should handle status command", async () => {
      const runId = "test-run-status";
      const run = createMockRun({ id: runId, status: "running" });
      // Store the run
      store.get = () => run;

      const request = {
        version: 1 as const,
        command_id: "cmd-status",
        run_id: runId,
        expected_generation: 1,
        command: { action: "status" as const },
      };

      const response = await controlHandler.handleControlRequest(
        { peerName: "origin-peer", principalId: "test-user" },
        request
      );

      expect(response.outcome).toBe("succeeded");
      expect(response.projection?.status).toBe("running");
    });

    it("should reject command from wrong peer", async () => {
      const runId = "test-run-wrong";
      const run = createMockRun({ id: runId, status: "running", originPeer: "other-peer" });
      store.get = () => run;

      const request = {
        version: 1 as const,
        command_id: "cmd-wrong",
        run_id: runId,
        expected_generation: 1,
        command: { action: "status" as const },
      };

      const response = await controlHandler.handleControlRequest(
        { peerName: "origin-peer", principalId: "test-user" },
        request
      );

      expect(response.outcome).toBe("rejected");
      expect(response.error?.code).toBe("FORBIDDEN_PEER");
    });

    it("should reject command with stale generation", async () => {
      const runId = "test-run-stale";
      const run = createMockRun({ id: runId, status: "running", executionGeneration: 2 });
      store.get = () => run;

      const request = {
        version: 1 as const,
        command_id: "cmd-stale",
        run_id: runId,
        expected_generation: 1,
        command: { action: "status" as const },
      };

      const response = await controlHandler.handleControlRequest(
        { peerName: "origin-peer", principalId: "test-user" },
        request
      );

      expect(response.outcome).toBe("rejected");
      expect(response.error?.code).toBe("STALE_GENERATION");
    });
  });

  describe("Task 7: Operator-gated resume", () => {
    it("should validate resume approval", () => {
      const approval = {
        approval_id: "app-1",
        run_id: "test-run",
        origin_peer: "origin-peer",
        command_id: "cmd-1",
        approving_principal: "operator",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        interrupted_generation: 1,
        approval_statement_sha256: "a".repeat(64),
      };

      expect(() => validateResumeApproval(approval)).not.toThrow();
    });

    it("should reject expired approval", () => {
      const approval = {
        approval_id: "app-1",
        run_id: "test-run",
        origin_peer: "origin-peer",
        command_id: "cmd-1",
        approving_principal: "operator",
        issued_at: new Date(Date.now() - 7200000).toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
        interrupted_generation: 1,
        approval_statement_sha256: "a".repeat(64),
      };

      expect(() => validateResumeApproval(approval)).toThrow("expired");
    });
  });

  describe("Task 8: Delivery policy projection", () => {
    it("should include delivery outcome in terminal events", async () => {
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

  describe("Integration: Event flow from owner to origin", () => {
    it("should complete full event lifecycle", async () => {
      const runId = "integration-run";
      const run = createMockRun({ id: runId, status: "running" as PiRunStatus });

      // Produce event on owner side
      const produced = await producer.produceEvent({
        run,
        kind: "progress",
        originPeer: "origin-peer",
        originRequestId: "req-integration",
        progressPayload: JSON.stringify({ step: "test", percent: 50 }),
      });
      expect(produced).not.toBeNull();

      // Retrieve event for delivery
      const events = store.getEventsAfter({ runId: run.id, afterSequence: 0, limit: 10 });
      expect(events).toHaveLength(1);

      // Build event envelope
      const event = await producer.buildEventEnvelope(events[0]);

      // Reduce on origin side
      const reduced = originReducer.reduce(event);
      expect(reduced).toBe(true);

      // Verify projection
      const projection = originReducer.getProjection(run.id);
      expect(projection?.latest_sequence).toBe(1);
      expect(projection?.latest_status).toBe("running");

      // Acknowledge
      const acked = originReducer.acknowledgeCursor(run.id, 1);
      expect(acked).toBe(true);
    });
  });

  describe("Integration: Command idempotency", () => {
    it("should return same response for duplicate command", async () => {
      const runId = "idem-run";
      const run = createMockRun({ id: runId, status: "running" });
      store.get = () => run;

      const request = {
        version: 1 as const,
        command_id: "cmd-idem",
        run_id: runId,
        expected_generation: 1,
        command: { action: "status" as const },
      };

      const response1 = await controlHandler.handleControlRequest(
        { peerName: "origin-peer", principalId: "test-user" },
        request
      );

      const response2 = await controlHandler.handleControlRequest(
        { peerName: "origin-peer", principalId: "test-user" },
        request
      );

      expect(response1.command_id).toBe(response2.command_id);
      expect(response1.outcome).toBe(response2.outcome);
    });
  });
});