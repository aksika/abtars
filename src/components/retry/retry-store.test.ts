import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let RetryStore: typeof import("./retry-store.js").RetryStore;
let WorkerSupervisionStore: typeof import("../worker-supervision-store.js").WorkerSupervisionStore;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `retry-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  ({ RetryStore } = await import("./retry-store.js"));
  ({ WorkerSupervisionStore } = await import("../worker-supervision-store.js"));
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

describe("RetryStore", () => {
  it("creates tables on first use", () => {
    const store = new RetryStore();
    expect(store).toBeInstanceOf(RetryStore);
  });

  describe("pruneTerminalAttempts (#1551)", () => {
    let ordinal = 0;
    // worker_attempts is owned by WorkerSupervisionStore's migration; both
    // stores share one TaskDatabase connection (same convention as the
    // production wiring in heartbeat-housekeeping.ts).
    function makeSharedDb() {
      const supStore = new WorkerSupervisionStore();
      const retryStore = new RetryStore(supStore.db);
      supStore.insertContract({
        schema_version: 1, id: "c1", digest: "d".repeat(64), goal: "g",
        criteria: [], expected_artifacts: [], verification_commands: [],
        required_capabilities: [], limits: {},
        provenance: { root_contract_id: undefined, card_id: 101, authored_by: "orc", created_at: "2026-01-01T00:00:00.000Z" } as never,
      }, 101);
      return { supStore, retryStore };
    }
    function seedAttempt(supStore: InstanceType<typeof WorkerSupervisionStore>, id: string, opts: { lifecycle: string; settledAt: string | null }) {
      ordinal += 1;
      supStore.db.prepare(`
        INSERT INTO worker_attempts
          (id, card_id, contract_id, ordinal, executor_kind, executor_id, status,
           lifecycle, started_at, settled_at)
        VALUES (?, 101, 'c1', ?, 'agent', 'spin', ?, ?, '2026-01-01T00:00:00.000Z', ?)
      `).run(id, ordinal, opts.lifecycle, opts.lifecycle, opts.settledAt);
    }

    it("deletes a failure classification for a terminal attempt settled before the cutoff", () => {
      const { supStore, retryStore } = makeSharedDb();
      seedAttempt(supStore, "a_old", { lifecycle: "completed", settledAt: "2020-01-01T00:00:00.000Z" });
      supStore.db.prepare(`INSERT INTO attempt_failure_classifications (id, attempt_id, input_digest, classification_json, created_at) VALUES ('cl1', 'a_old', 'h', '{}', '2020-01-01T00:00:00.000Z')`).run();

      const purged = retryStore.pruneTerminalAttempts(7);

      expect(purged).toBe(1);
      expect(supStore.db.prepare(`SELECT * FROM attempt_failure_classifications WHERE attempt_id = 'a_old'`).get()).toBeUndefined();
    });

    it("does not delete a classification for a non-terminal attempt", () => {
      const { supStore, retryStore } = makeSharedDb();
      seedAttempt(supStore, "a_running", { lifecycle: "running", settledAt: null });
      supStore.db.prepare(`INSERT INTO attempt_failure_classifications (id, attempt_id, input_digest, classification_json, created_at) VALUES ('cl1', 'a_running', 'h', '{}', '2020-01-01T00:00:00.000Z')`).run();

      const purged = retryStore.pruneTerminalAttempts(7);

      expect(purged).toBe(0);
      expect(supStore.db.prepare(`SELECT * FROM attempt_failure_classifications WHERE attempt_id = 'a_running'`).get()).toBeDefined();
    });

    it("deletes a retry_directive keyed by either source or target attempt id", () => {
      const { supStore, retryStore } = makeSharedDb();
      seedAttempt(supStore, "a_old", { lifecycle: "completed", settledAt: "2020-01-01T00:00:00.000Z" });
      supStore.db.prepare(`INSERT INTO retry_directives (id, source_attempt_id, target_attempt_id, directive_json, directive_digest, created_at) VALUES ('d1', 'a_old', 'a_next', '{}', 'x', '2020-01-01T00:00:00.000Z')`).run();

      const purged = retryStore.pruneTerminalAttempts(7);

      expect(purged).toBe(1);
      expect(supStore.db.prepare(`SELECT * FROM retry_directives WHERE id = 'd1'`).get()).toBeUndefined();
    });

    it("excludes a review_required retry_policy_decision even when its source attempt is old and terminal", () => {
      const { supStore, retryStore } = makeSharedDb();
      seedAttempt(supStore, "a_old", { lifecycle: "completed", settledAt: "2020-01-01T00:00:00.000Z" });
      supStore.db.prepare(`INSERT INTO retry_policy_decisions (id, source_attempt_id, decision_json, status, updated_at) VALUES ('p1', 'a_old', '{}', 'review_required', '2020-01-01T00:00:00.000Z')`).run();

      const purged = retryStore.pruneTerminalAttempts(7);

      expect(purged).toBe(0);
      expect(supStore.db.prepare(`SELECT * FROM retry_policy_decisions WHERE id = 'p1'`).get()).toBeDefined();
    });

    it("deletes a decided (non-review) retry_policy_decision for an old terminal attempt", () => {
      const { supStore, retryStore } = makeSharedDb();
      seedAttempt(supStore, "a_old", { lifecycle: "completed", settledAt: "2020-01-01T00:00:00.000Z" });
      supStore.db.prepare(`INSERT INTO retry_policy_decisions (id, source_attempt_id, decision_json, status, updated_at) VALUES ('p1', 'a_old', '{}', 'retry', '2020-01-01T00:00:00.000Z')`).run();

      const purged = retryStore.pruneTerminalAttempts(7);

      expect(purged).toBe(1);
      expect(supStore.db.prepare(`SELECT * FROM retry_policy_decisions WHERE id = 'p1'`).get()).toBeUndefined();
    });
  });
});
