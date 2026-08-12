/**
 * supervised-pi-settlement.test.ts — #1638 Task 6: the supervised/standalone
 * terminal router and the no-card supervised run transition.
 *
 * The canonical Worker settlement body must be invoked INSIDE the same
 * transaction as the Pi run transition; the standalone settleTerminal (which
 * transitions the Pi card) must never run for a supervised binding.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { PiRunStore } from "./pi-run-store.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { SupervisedPiSettlement } from "./supervised-pi-settlement.js";
import { ensureKanbanBoardSchema } from "../tasks/kanban-board.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

const _require = createRequire(import.meta.url);
const sharedPath = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
const Database: typeof import("better-sqlite3") = _require(sharedPath);

let TEST_HOME: string;
let mod: any;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `sup-pi-settle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  mod = await import("./supervised-pi-settlement.js");
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

function createTestDb(): TaskDatabase {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  // #1631: the production board schema helper — the fixture can never drift.
  ensureKanbanBoardSchema(raw);
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]) { return stmt.run(...params); },
        get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
        all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { raw.exec(sql); },
    transaction<T>(fn: () => T): T { return raw.transaction(fn)(); },
  };
}

function setupSupervisedAttempt(workerStore: WorkerSupervisionStore, piStore: PiRunStore): { cardId: number; attemptId: string; runId: string } {
  const now = new Date().toISOString();
  workerStore.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, created_at, updated_at) VALUES (?, ?, 't', 'running', 'O', ?, ?)`).run(900, "proj", now, now);
  workerStore.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type, parent_id, created_at, updated_at) VALUES (?, ?, 't', 'queued', 'W', ?, ?, ?)`).run(901, "child", 900, now, now);
  workerStore.insertContract({ schema_version: 1, id: "c_sup", digest: "d", goal: "g", criteria: [{ id: "c1", description: "d" }], expected_artifacts: [{ id: "a1", kind: "file", ref: "out.md", required: true, criterion_ids: ["c1"] }], verification_commands: [{ id: "v1", argv: ["true"], timeout_ms: 5000, criterion_ids: ["c1"] }], required_capabilities: [], limits: {}, provenance: { root_card_id: 900, card_id: 901, authored_by: "t", created_at: now } }, 901);
  workerStore.insertAttempt({ id: "a_sup", card_id: 901, contract_id: "c_sup", ordinal: 1, executor_kind: "pi", executor_id: "pi-coding", status: "pending", started_at: now });
  workerStore.lifecycleTransition("a_sup", ["pending"], "claimed");
  workerStore.lifecycleTransition("a_sup", ["claimed"], "starting");
  const run = piStore.createSupervisedRun({ cardId: 901, workspaceAlias: "repo-a", goal: "g", ownerPrincipalId: "p", sessionId: "s" });
  // the adapter claims the shared workspace before launch — run queued->starting
  const wsClaim = piStore.claimSupervisedGeneration({ runId: run.runId, expectedGeneration: run.generation, canonicalPath: "/tmp/repo-a" });
  if (wsClaim.kind !== "claimed") throw new Error("setup: workspace claim failed");
  workerStore.bindExecutorResource({ attemptId: "a_sup", expectedAttemptGeneration: 1, executorKind: "pi", resourceId: run.runId, resourceGeneration: run.generation, continuity: "initial" });
  return { cardId: 901, attemptId: "a_sup", runId: run.runId };
}

describe("SupervisedPiSettlement (#1638)", () => {
  it("routes a bound terminal observation through Worker settlement without touching the W card", () => {
    const db = createTestDb();
    const piStore = new PiRunStore({ db });
    const workerStore = new WorkerSupervisionStore(db);
    const { cardId, attemptId, runId } = setupSupervisedAttempt(workerStore, piStore);

    const coordinator = new SupervisedPiSettlement(piStore, workerStore, { enabled: true, command: "pi", fixedArgs: [], workspaceAliases: { "repo-a": { path: "/tmp/repo-a" } }, allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000, projectTrust: "never", sessionStorageRoot: "/tmp/sessions" } as any);
    const observation = coordinator.settlePiExecution({
      runId, generation: 1, outcome: "completed", metadata: { resultSummary: "done" },
    });
    expect(observation.kind).toBe("settled");
    if (observation.kind === "settled") {
      expect(observation.supervised).toBe(true);
    }
    // attempt settled through the canonical body
    const attempt = workerStore.getAttempt(attemptId);
    expect(attempt?.lifecycle).toBe("completed");
    expect(attempt?.status).toBe("settled");
    // W card NOT transitioned by the Pi lane
    const card = db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(cardId) as { status: string };
    expect(card.status).toBe("queued");
    // run row terminal
    const run = piStore.get(runId);
    expect(run?.status).toBe("completed");
  });

  it("persists a supplied structured failure envelope for an input_requested settlement", () => {
    const db = createTestDb();
    const piStore = new PiRunStore({ db });
    const workerStore = new WorkerSupervisionStore(db);
    const { cardId, attemptId, runId } = setupSupervisedAttempt(workerStore, piStore);

    const coordinator = new SupervisedPiSettlement(piStore, workerStore, { enabled: true, command: "pi", fixedArgs: [], workspaceAliases: { "repo-a": { path: "/tmp/repo-a" } }, allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000, projectTrust: "never", sessionStorageRoot: "/tmp/sessions" } as any);
    const observation = coordinator.settlePiExecution({
      runId, generation: 1, outcome: "failed", metadata: { error: "input requested" },
      envelope: {
        schema_version: 1,
        attempt: { id: attemptId, ordinal: 1, contract_id: "c_sup", contract_digest: "d", executor_kind: "pi", executor_id: "pi-coding", started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
        outcome: "failed",
        criteria: [],
        checks: [],
        artifacts: [],
        worker_report: { summary: "question", claims: [], unresolved_risks: [] },
        error: { code: "INPUT_REQUESTED", message: "what next?" },
      },
    });
    expect(observation.kind).toBe("settled");
    const result = workerStore.getResultByAttempt(attemptId);
    expect(result?.envelope.error?.code).toBe("INPUT_REQUESTED");
    expect(result?.envelope.worker_report.summary).toBe("question");
    const attempt = workerStore.getAttempt(attemptId);
    expect(attempt?.lifecycle).toBe("failed");
  });

  it("exact replay of an identical terminal observation returns replayed without double settlement", () => {
    const db = createTestDb();
    const piStore = new PiRunStore({ db });
    const workerStore = new WorkerSupervisionStore(db);
    const { cardId, attemptId, runId } = setupSupervisedAttempt(workerStore, piStore);
    const coordinator = new SupervisedPiSettlement(piStore, workerStore, { enabled: true, command: "pi", fixedArgs: [], workspaceAliases: { "repo-a": { path: "/tmp/repo-a" } }, allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000, projectTrust: "never", sessionStorageRoot: "/tmp/sessions" } as any);
    const input = { runId, generation: 1, outcome: "completed" as const, metadata: { resultSummary: "done" } };
    expect(coordinator.settlePiExecution(input).kind).toBe("settled");
    const second = coordinator.settlePiExecution(input);
    expect(second.kind).toBe("replayed");
  });

  it("a stale Pi generation cannot settle the latest attempt", () => {
    const db = createTestDb();
    const piStore = new PiRunStore({ db });
    const workerStore = new WorkerSupervisionStore(db);
    const { cardId, attemptId, runId } = setupSupervisedAttempt(workerStore, piStore);
    const coordinator = new SupervisedPiSettlement(piStore, workerStore, { enabled: true, command: "pi", fixedArgs: [], workspaceAliases: { "repo-a": { path: "/tmp/repo-a" } }, allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000, projectTrust: "never", sessionStorageRoot: "/tmp/sessions" } as any);
    const observation = coordinator.settlePiExecution({
      runId, generation: 99, outcome: "failed", metadata: {},
    });
    expect(observation.kind).toBe("stale");
    const attempt = workerStore.getAttempt(attemptId);
    expect(attempt?.lifecycle).toBe("starting");
  });

  it("an unbounded (standalone) run uses the standalone settleTerminal path", () => {
    const db = createTestDb();
    const piStore = new PiRunStore({ db });
    const workerStore = new WorkerSupervisionStore(db);
    const runId = piStore.generateId();
    db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type) VALUES (?, 'pi card', 'pi', 'running', 'pi')`).run(910);
    db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id, origin, execution_generation, current_session_id, status) VALUES (?, ?, 'ws', 'g', 'p', 'user', 1, 's', 'running')`).run(runId, 910);
    const coordinator = new SupervisedPiSettlement(piStore, workerStore, { enabled: true, command: "pi", fixedArgs: [], workspaceAliases: { "repo-a": { path: "/tmp/repo-a" } }, allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000, projectTrust: "never", sessionStorageRoot: "/tmp/sessions" } as any);
    const observation = coordinator.settlePiExecution({ runId, generation: 1, outcome: "completed", metadata: { resultSummary: "ok" } });
    expect(observation.kind).toBe("settled");
    if (observation.kind === "settled") {
      expect(observation.supervised).toBe(false);
    }
    // standalone path transitions the Pi card
    const card = db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(910) as { status: string };
    expect(card.status).toBe("done");
  });

  it("suspendForInput settles the attempt as input_requested with zero charge and interrupted run", () => {
    const db = createTestDb();
    const piStore = new PiRunStore({ db });
    const workerStore = new WorkerSupervisionStore(db);
    const { cardId, attemptId, runId } = setupSupervisedAttempt(workerStore, piStore);
    workerStore.db.prepare("UPDATE worker_attempts SET reserved_tokens = 500 WHERE id = ?").run(attemptId);
    // durable session file + workspace dir inside the configured roots
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync("/tmp/sessions", { recursive: true });
    writeFileSync("/tmp/sessions/s1.md", "session", "utf-8");
    mkdirSync("/tmp/repo-a", { recursive: true });

    const coordinator = new SupervisedPiSettlement(piStore, workerStore, { enabled: true, command: "pi", fixedArgs: [], workspaceAliases: { "repo-a": { path: "/tmp/repo-a" } }, allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000, projectTrust: "never", sessionStorageRoot: "/tmp/sessions" } as any);
    const outcome = coordinator.suspendForInput({
      runId, generation: 1, question: "which schema should I use?", requestId: "req-1",
      sessionFile: "/tmp/sessions/s1.md",
    });
    expect(outcome.suspended).toBe(true);

    const attempt = workerStore.getAttempt(attemptId);
    expect(attempt?.lifecycle).toBe("failed");
    expect(attempt?.charged_tokens).toBe(0);
    const result = workerStore.getResultByAttempt(attemptId);
    expect(result?.envelope.error?.code).toBe("INPUT_REQUESTED");
    expect(result?.envelope.worker_report.summary).toContain("which schema");
    // run interrupted + resumable when the session file is durable
    const run = piStore.get(runId);
    expect(run?.status).toBe("interrupted");
    expect(run?.resumeCapability).toBe("available");
    // workspace released
    expect(piStore.listWorkspaceClaims()).toHaveLength(0);
    // W card untouched by the Pi lane
    const card = db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(cardId) as { status: string };
    expect(card.status).toBe("queued");
  });

  it("suspendForInput marks the run non-resumable when the session file is missing", () => {
    const db = createTestDb();
    const piStore = new PiRunStore({ db });
    const workerStore = new WorkerSupervisionStore(db);
    const { attemptId, runId } = setupSupervisedAttempt(workerStore, piStore);
    const coordinator = new SupervisedPiSettlement(piStore, workerStore, { enabled: true, command: "pi", fixedArgs: [], workspaceAliases: { "repo-a": { path: "/tmp/repo-a" } }, allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000, projectTrust: "never", sessionStorageRoot: "/tmp/sessions" } as any);
    const outcome = coordinator.suspendForInput({ runId, generation: 1, question: "q", requestId: "req-2", sessionFile: undefined });
    expect(outcome.suspended).toBe(true);
    const run = piStore.get(runId);
    expect(run?.status).toBe("interrupted");
    expect(run?.resumeCapability).toBe("never_started");
    expect(workerStore.getAttempt(attemptId)?.lifecycle).toBe("failed");
  });
});
