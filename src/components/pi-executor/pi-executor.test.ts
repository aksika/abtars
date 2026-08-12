/**
 * pi-executor.test.ts — #1647 executor lifecycle integration tests.
 *
 * Uses a controllable fake SupervisedPiRpcClient (module-mocked), a real
 * in-memory store with real session files, and a real workspace dir. Asserts
 * on durable rows, outbound RPC commands, and cleanup — not private call
 * order inside the executor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PiRunStore } from "./pi-run-store.js";
import { PiExecutor, type EndExternalSession } from "./pi-executor.js";
import type { PiExecutorConfig } from "./config.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { ensureKanbanBoardSchema } from "../tasks/kanban-board.js";

// ── controllable RPC fake (module-mocked into ./pi-rpc-client.js) ───────────

const fake = vi.hoisted(() => {
  type Call = { method: string; args: unknown[] };
  class FakeClient {
    static instances: FakeClient[] = [];
    /** Scripted initial state every new client reports. */
    static defaultState: { sessionId: string; sessionFile?: string; isStreaming: boolean; isCompacting: boolean } = {
      sessionId: "fresh-process", sessionFile: undefined, isStreaming: false, isCompacting: false,
    };
    /** When set, getState throws (wedged process simulation). */
    static getStateError: Error | null = null;
    /** Called after a switch_session write; tests flip the live state here. */
    static onSwitch: ((file: string, client: FakeClient) => void) | null = null;
    pid = 4242;
    closed = false;
    calls: Call[] = [];
    prompts: string[] = [];
    followUps: string[] = [];
    switches: string[] = [];
    state: { sessionId: string; sessionFile?: string; isStreaming: boolean; isCompacting: boolean };
    private subs = new Set<(e: unknown) => void>();
    private termCbs = new Set<(e: unknown) => void>();
    private uiCbs = new Set<(e: unknown) => void>();
    constructor() {
      this.state = { ...FakeClient.defaultState };
      FakeClient.instances.push(this);
    }
    record(method: string, args: unknown[] = []): void { this.calls.push({ method, args }); }
    async launch(...args: unknown[]): Promise<void> { this.record("launch", args); }
    async getState(): Promise<{ sessionId: string; sessionFile?: string; isStreaming: boolean; isCompacting: boolean }> {
      this.record("getState");
      if (FakeClient.getStateError) throw FakeClient.getStateError;
      return this.state;
    }
    async getAvailableModels(): Promise<Array<{ id: string }>> { return [{ id: "model-x" }]; }
    async setModel(...args: unknown[]): Promise<void> { this.record("setModel", args); }
    async prompt(text: string): Promise<void> { this.record("prompt", [text]); this.prompts.push(text); }
    async followUp(text: string): Promise<void> { this.record("followUp", [text]); this.followUps.push(text); }
    async switchSession(file: string): Promise<{ cancelled: boolean }> {
      this.record("switchSession", [file]); this.switches.push(file);
      FakeClient.onSwitch?.(file, this);
      return { cancelled: false };
    }
    async steer(...args: unknown[]): Promise<void> { this.record("steer", args); }
    async respondToUi(...args: unknown[]): Promise<{ ok: boolean }> { this.record("respondToUi", args); return { ok: true }; }
    async abort(): Promise<void> { this.record("abort"); }
    async close(): Promise<void> { this.record("close"); this.closed = true; }
    onTermination(cb: (e: unknown) => void): () => void { this.termCbs.add(cb); return () => this.termCbs.delete(cb); }
    subscribe(cb: (e: unknown) => void): () => void { this.subs.add(cb); return () => this.subs.delete(cb); }
    onUiRequest(cb: (e: unknown) => void): () => void { this.uiCbs.add(cb); return () => this.uiCbs.delete(cb); }
    emitTermination(e: unknown): void { for (const cb of [...this.termCbs]) cb(e); }
    emitEvent(e: unknown): void { for (const cb of [...this.subs]) cb(e); }
    static reset(): void {
      FakeClient.instances = [];
      FakeClient.defaultState = { sessionId: "fresh-process", sessionFile: undefined, isStreaming: false, isCompacting: false };
      FakeClient.getStateError = null;
      FakeClient.onSwitch = null;
    }
  }
  class PiRpcError extends Error {
    code = "unknown";
  }
  return { FakeClient, PiRpcError };
});

vi.mock("./pi-rpc-client.js", () => ({
  SupervisedPiRpcClient: fake.FakeClient,
  PiRpcError: fake.PiRpcError,
}));

const _require = createRequire(import.meta.url);
const sharedPath = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
const Database: typeof import("better-sqlite3") = _require(sharedPath);

function createTestDb(): TaskDatabase {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  raw.exec(`CREATE TABLE IF NOT EXISTS kanban_board (
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

interface Harness {
  store: PiRunStore;
  executor: PiExecutor;
  db: TaskDatabase;
  root: string;
  wsPath: string;
  ended: Array<{ sessionId: string; runId: string; generation: number }>;
  cleanup: () => void;
}

let harness: Harness;

function makeHarness(sessionRoot?: string): Harness {
  const root = mkdtempSync(join(tmpdir(), "pi-exec-test-"));
  const wsPath = join(root, "ws");
  mkdirSync(wsPath, { recursive: true });
  const db = createTestDb();
  const store = new PiRunStore({ db, sessionStorageRoot: sessionRoot ?? root });
  const config: PiExecutorConfig = {
    enabled: true, command: "fake-pi", fixedArgs: [],
    workspaceAliases: { "repo-a": { path: wsPath } },
    allowedEnv: [], maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000,
    projectTrust: "never", sessionStorageRoot: sessionRoot ?? root,
  };
  const executor = new PiExecutor(config, store);
  const ended: Array<{ sessionId: string; runId: string; generation: number }> = [];
  const closer: EndExternalSession = (sessionId, expected) => {
    ended.push({ sessionId, runId: expected.runId, generation: expected.generation });
    return true;
  };
  executor.setExternalSessionCloser(closer);
  return {
    store, executor, db, root, wsPath, ended,
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

function writeSession(root: string, file: string, id: string): string {
  const path = join(root, file);
  writeFileSync(path, JSON.stringify({ type: "session", id }) + "\n", "utf-8");
  return path;
}

/** Create + claim a fresh standalone run (card queued→running, run queued→starting). */
function createClaimedRun(h: Harness, goal: string): { runId: string; cardId: number } {
  const created = h.store.createPiCardAndRun({
    runId: h.store.generateId(), sessionId: "c-1", title: `Pi: ${goal.slice(0, 40)}`,
    goal, workspaceAlias: "repo-a", ownerPrincipalId: "usr-1", origin: "user",
  });
  const claim = h.store.claimQueuedGeneration(created.cardId, h.wsPath);
  if (!claim.claimed) throw new Error("claim failed");
  return { runId: created.runId, cardId: created.cardId };
}

/** Seed a resume generation directly: run starting, card running, intent resume. */
function seedResumeRun(h: Harness, runId: string, cardId: number, piSessionId: string, sessionFile: string | undefined, capability = "available"): void {
  h.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type) VALUES (?, ?, 'pi', 'running', 'pi')`).run(cardId, `pi-${cardId}`);
  h.db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id,
    origin, execution_generation, generation_intent, current_session_id, status,
    pi_session_id, pi_session_file, resume_capability)
    VALUES (?, ?, 'repo-a', 'resume goal', 'usr-1', 'user', 2, 'resume', 'c-2', 'starting', ?, ?, ?)`).run(
    runId, cardId, piSessionId ?? null, sessionFile ?? null, capability,
  );
}

function runRecord(h: Harness, runId: string) {
  return h.store.get(runId)!;
}

beforeEach(() => {
  fake.FakeClient.reset();
  harness = makeHarness();
});

afterEach(() => {
  harness.cleanup();
});

describe("PiExecutor #1647 — start state machine", () => {
  it("initial generation submits the operational goal exactly once and persists the fresh identity truthfully", async () => {
    const h = harness;
    const savedFile = writeSession(h.root, "fresh.jsonl", "fresh-1");
    const { runId } = createClaimedRun(h, "build the thing");
    fake.FakeClient.defaultState = { sessionId: "fresh-1", sessionFile: savedFile, isStreaming: false, isCompacting: false };

    const result = await h.executor.startWithClaim(runId, 1, "c-1");
    expect(result).toBe("started");

    const client = fake.FakeClient.instances[0]!;
    expect(client.prompts).toEqual(["build the thing"]);
    expect(client.followUps).toEqual([]);
    const run = runRecord(h, runId);
    expect(run.status).toBe("running");
    expect(run.piSessionId).toBe("fresh-1");
    expect(run.resumeCapability).toBe("available");
  });

  it("initial generation records session_missing when Pi reported an id but not a flushed file", async () => {
    const h = harness;
    const { runId } = createClaimedRun(h, "unflushed run");
    fake.FakeClient.defaultState = { sessionId: "unflushed-1", sessionFile: undefined, isStreaming: false, isCompacting: false };

    const result = await h.executor.startWithClaim(runId, 1, "c-1");
    expect(result).toBe("started");
    const run = runRecord(h, runId);
    expect(run.status).toBe("running");
    expect(run.resumeCapability).toBe("session_missing");
  });

  it("resume switches the saved file, verifies identity, persists the SAVED tuple, and sends one continuation — never the goal", async () => {
    const h = harness;
    const savedFile = writeSession(h.root, "saved.jsonl", "sess-saved");
    const runId = "res-ok";
    seedResumeRun(h, runId, 9121, "sess-saved", savedFile);
    // Fresh process reports its OWN empty identity first; after the switch it
    // reports the saved identity.
    fake.FakeClient.defaultState = { sessionId: "fresh-process", sessionFile: undefined, isStreaming: false, isCompacting: false };
    fake.FakeClient.onSwitch = (_file, client) => {
      client.state = { sessionId: "sess-saved", sessionFile: savedFile, isStreaming: false, isCompacting: false };
    };

    const result = await h.executor.startWithClaim(runId, 2, "c-2");
    expect(result).toBe("started");
    const client = fake.FakeClient.instances[0]!;
    expect(client.switches).toEqual([savedFile]);
    expect(client.followUps).toEqual(["Continue where we left off"]);
    expect(client.prompts).toEqual([]);

    // A fresh store instance observes the SAVED identity — never the fresh
    // process identity that lived only in memory during the switch.
    const fresh = new PiRunStore({ db: h.db, sessionStorageRoot: h.root });
    const run = fresh.get(runId)!;
    expect(run.status).toBe("running");
    expect(run.piSessionId).toBe("sess-saved");
    expect(run.piSessionFile).toBe(savedFile);
    expect(run.generationIntent).toBe("resume");
    expect(run.resumeCapability).toBe("available");
  });

  it("a resume generation with an absent target fails closed with zero prompt and zero continuation", async () => {
    const h = harness;
    const runId = "res-gone";
    seedResumeRun(h, runId, 9122, "sess-gone", undefined);

    const result = await h.executor.startWithClaim(runId, 2, "c-2");
    expect(result).toBe("error");
    const client = fake.FakeClient.instances[0]!;
    expect(client.prompts).toEqual([]);
    expect(client.followUps).toEqual([]);
    expect(client.switches).toEqual([]);
    const run = runRecord(h, runId);
    expect(run.status).toBe("failed");
    // The exact generation's C session is closed on the failed resume.
    expect(h.ended.some(e => e.runId === runId && e.generation === 2 && e.sessionId === "c-2")).toBe(true);
  });

  it("a resume with an identity mismatch after switch settles failed with no continuation", async () => {
    const h = harness;
    const savedFile = writeSession(h.root, "saved2.jsonl", "sess-saved2");
    const otherFile = writeSession(h.root, "other.jsonl", "sess-other");
    const runId = "res-mismatch";
    seedResumeRun(h, runId, 9123, "sess-saved2", savedFile);
    // After the switch the process reports a DIFFERENT session id.
    fake.FakeClient.onSwitch = (_file, client) => {
      client.state = { sessionId: "sess-other", sessionFile: otherFile, isStreaming: false, isCompacting: false };
    };

    const result = await h.executor.startWithClaim(runId, 2, "c-2");
    expect(result).toBe("error");
    const client = fake.FakeClient.instances[0]!;
    expect(client.followUps).toEqual([]);
    expect(client.prompts).toEqual([]);
    const run = runRecord(h, runId);
    expect(run.status).toBe("failed");
  });

  it("a lost running CAS on the resume path closes the process and C session without followUp", async () => {
    const h = harness;
    const savedFile = writeSession(h.root, "saved3.jsonl", "sess-saved3");
    const runId = "res-caslost";
    seedResumeRun(h, runId, 9124, "sess-saved3", savedFile);
    // After the switch the process reports the saved identity — and a
    // concurrent winner moves the run terminal BEFORE the running CAS.
    fake.FakeClient.onSwitch = (_file, client) => {
      client.state = { sessionId: "sess-saved3", sessionFile: savedFile, isStreaming: false, isCompacting: false };
      h.db.prepare(`UPDATE pi_runs SET status = 'interrupted' WHERE id = ?`).run(runId);
    };

    const result = await h.executor.startWithClaim(runId, 2, "c-2");
    expect(result).toBe("error");
    const client = fake.FakeClient.instances[0]!;
    expect(client.followUps).toEqual([]);
    expect(client.prompts).toEqual([]);
    // The owned process was closed and the exact C session ended.
    expect(client.closed).toBe(true);
    expect(h.ended.some(e => e.runId === runId && e.generation === 2 && e.sessionId === "c-2")).toBe(true);
    // The interrupted winner state is untouched by the loser.
    expect(runRecord(h, runId).status).toBe("interrupted");
  });
});

describe("PiExecutor #1647 — interruption and exact-generation cleanup", () => {
  it("interruptAll pairs run/card interruption with truthful proof and ends the exact C session", async () => {
    const h = harness;
    const savedFile = writeSession(h.root, "live.jsonl", "sess-live");
    const { runId, cardId } = createClaimedRun(h, "interrupt me");
    fake.FakeClient.defaultState = { sessionId: "sess-live", sessionFile: savedFile, isStreaming: false, isCompacting: false };
    await h.executor.startWithClaim(runId, 1, "c-1");
    expect(runRecord(h, runId).status).toBe("running");

    await h.executor.interruptAll();

    const run = runRecord(h, runId);
    expect(run.status).toBe("interrupted");
    expect(run.resumeCapability).toBe("available");
    expect(run.piSessionId).toBe("sess-live");
    const card = h.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(cardId) as { status: string };
    expect(card.status).toBe("failed");
    const claims = h.db.prepare(`SELECT COUNT(*) as cnt FROM pi_workspace_claims`).get() as { cnt: number };
    expect(claims.cnt).toBe(0);
    expect(h.ended.some(e => e.runId === runId && e.generation === 1 && e.sessionId === "c-1")).toBe(true);
  });

  it("interruptAll records a non-available capability when the live probe fails and still cleans up", async () => {
    const h = harness;
    const { runId, cardId } = createClaimedRun(h, "unprobeable");
    await h.executor.startWithClaim(runId, 1, "c-1");
    // The process wedges AFTER start: the shutdown probe cannot obtain proof.
    fake.FakeClient.getStateError = new Error("process wedged");

    await h.executor.interruptAll();

    const run = runRecord(h, runId);
    expect(run.status).toBe("interrupted");
    expect(run.resumeCapability).toBe("session_missing");
    const card = h.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(cardId) as { status: string };
    expect(card.status).toBe("failed");
    expect(h.ended.some(e => e.runId === runId && e.generation === 1)).toBe(true);
  });

  it("a terminal observation that loses to interruption changes no durable state and only cleans resources", async () => {
    const h = harness;
    const savedFile = writeSession(h.root, "race.jsonl", "sess-race");
    const { runId, cardId } = createClaimedRun(h, "race me");
    fake.FakeClient.defaultState = { sessionId: "sess-race", sessionFile: savedFile, isStreaming: false, isCompacting: false };
    await h.executor.startWithClaim(runId, 1, "c-1");

    await h.executor.interruptAll();
    const endedBefore = h.ended.filter(e => e.runId === runId).length;

    // Late unexpected termination for the SAME generation arrives after the
    // interruption committed.
    fake.FakeClient.instances[0]!.emitTermination({ kind: "exit", code: 1, signal: null, error: undefined });

    const run = runRecord(h, runId);
    expect(run.status).toBe("interrupted");
    const card = h.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(cardId) as { status: string };
    expect(card.status).toBe("failed");
    // Cleanup repeated is harmless and exact-generation.
    expect(h.ended.filter(e => e.runId === runId && e.generation === 1).length).toBeGreaterThanOrEqual(endedBefore);
  });

  it("a supervised run without a router interrupts the run row only, never the W card", async () => {
    const h = harness;
    const runId = "sup-live";
    h.db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type) VALUES (?, ?, 'agent', 'running', 'W')`).run(9131, "w-card");
    h.db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id,
      origin, execution_generation, generation_intent, current_session_id, status)
      VALUES (?, ?, 'repo-a', 'sup goal', 'usr-1', 'supervised', 1, 'initial', 'c-sup', 'starting')`).run(runId, 9131);
    await h.executor.startWithClaim(runId, 1, "c-sup");
    expect(runRecord(h, runId).status).toBe("running");

    await h.executor.interruptAll();

    const run = runRecord(h, runId);
    expect(run.status).toBe("interrupted");
    const card = h.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(9131) as { status: string };
    expect(card.status).toBe("running");
    expect(h.ended.some(e => e.runId === runId && e.generation === 1)).toBe(true);
  });
});
