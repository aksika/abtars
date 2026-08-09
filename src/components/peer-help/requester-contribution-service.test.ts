import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PeerHelpRequestV1, PeerHelpResponseV1 } from "./contract.js";
import { ContributionStore } from "./contribution-store.js";
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import { RequesterContributionService } from "./requester-contribution-service.js";

let db: import("better-sqlite3").Database;
let dbPath: string;
let TEST_HOME: string;

function createKanbanTable(d: import("better-sqlite3").Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS kanban_board (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      status TEXT NOT NULL DEFAULT 'queued',
      type TEXT,
      goal TEXT,
      notes TEXT,
      parent_id INTEGER,
      delivery_mode TEXT DEFAULT 'deliver',
      source_peer TEXT,
      next_retry_at TEXT,
      max_tokens INTEGER,
      tokens_used INTEGER,
      result_summary TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function makeWrapper(d: import("better-sqlite3").Database) {
  return {
    prepare: (sql: string) => {
      const stmt = d.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...p),
        get: (...p: unknown[]) => stmt.get(...p) as Record<string, unknown> | undefined,
        all: (...p: unknown[]) => stmt.all(...p) as Record<string, unknown>[],
      };
    },
    exec: (sql: string) => d.exec(sql),
    transaction: <T>(fn: () => T): T => d.transaction(fn)(),
  };
}

interface Env {
  service: import("./requester-contribution-service.js").RequesterContributionService;
  sends: Array<{ peer: string; request: PeerHelpRequestV1 }>;
  wakes: number[];
  nextResponse: PeerHelpResponseV1;
  nextError?: Error;
}

function makeEnv(): Env {
  const wrapper = makeWrapper(db);
  const contributionStore = new ContributionStore(wrapper as any, {
    kanbanGetCard: (id: number) => db.prepare("SELECT id, status, result_summary, error FROM kanban_board WHERE id = ?").get(id) as any,
    kanbanUpdate: (id: number, updates: Record<string, unknown>) => {
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(", ");
      db.prepare(`UPDATE kanban_board SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
    },
    kanbanComplete: () => {},
    kanbanFail: () => {},
  });
  const reviewStore = new ProjectReviewStore(wrapper as any);
  const env: Env = {
    sends: [],
    wakes: [],
    nextResponse: { version: 1, request_id: "req_1", decision: "declined", reason_code: "policy" },
  };
  env.service = new RequesterContributionService({
    contributionStore,
    taskDb: wrapper as any,
    reviewStore,
    askHelp: async (peer, request) => {
      env.sends.push({ peer, request });
      if (env.nextError) throw env.nextError;
      return { ...env.nextResponse, request_id: request.request_id };
    },
    wakeProject: (cardId) => { env.wakes.push(cardId); },
    kanbanUpdate: (id: number, updates: Record<string, unknown>) => {
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(", ");
      db.prepare(`UPDATE kanban_board SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
    },
    kanbanFail: () => {},
  });
  return env;
}

function makeRequest(overrides?: Partial<PeerHelpRequestV1>): PeerHelpRequestV1 {
  return {
    version: 1,
    request_id: "req_1",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    goal: "Reply with exactly: ok",
    priority: "MEDIUM",
    required_capabilities: [],
    ...overrides,
  };
}

beforeEach(async () => {
  const { resolveNativeDep } = await import("../../utils/lazy-require.js") as typeof import("../../utils/lazy-require.js");
  const Database = resolveNativeDep("better-sqlite3");
  TEST_HOME = join(tmpdir(), `req-contribution-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  dbPath = join(TEST_HOME, "test.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  createKanbanTable(db);
});

afterEach(() => {
  db.close();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

describe("RequesterContributionService", () => {
  it("create_cli_project: root, supervision, and proxy exist before the transport is invoked", async () => {
    const env = makeEnv();
    env.nextResponse = { version: 1, request_id: "req_1", decision: "accepted", contribution_ref: "help_abc" };
    const result = await env.service.delegate({
      peer: "molty",
      request: makeRequest(),
      binding: { kind: "create_cli_project", title: "delegate x", goal: "Reply with exactly: ok" },
    });

    expect(env.sends).toHaveLength(1);
    expect(env.wakes).toHaveLength(1);

    const root = db.prepare("SELECT * FROM kanban_board WHERE source = 'cli'").get() as any;
    expect(root).toBeDefined();
    expect(root.type).toBe("O");
    expect(root.status).toBe("queued");
    expect(root.goal).toContain("req_1");

    const sup = db.prepare("SELECT state FROM project_supervision WHERE project_card_id = ?").get(root.id) as any;
    expect(sup.state).toBe("awaiting_contract");

    const proxy = db.prepare("SELECT * FROM kanban_board WHERE type = 'contribution'").get() as any;
    expect(proxy).toBeDefined();
    expect(proxy.parent_id).toBe(root.id);
    expect(proxy.status).toBe("running");

    const ledger = db.prepare("SELECT * FROM peer_contributions WHERE peer = 'molty'").get() as any;
    expect(ledger).toBeDefined();
    expect(ledger.project_card_id).toBe(root.id);
    expect(ledger.proxy_card_id).toBe(proxy.id);

    expect(result.projectCardId).toBe(root.id);
    expect(result.proxyCardId).toBe(proxy.id);
    expect(result.decision).toBe("accepted");
    expect(result.contributionRef).toBe("help_abc");
  });

  it("accepted response adopts the receiver contribution reference", async () => {
    const env = makeEnv();
    env.nextResponse = { version: 1, request_id: "req_1", decision: "accepted", contribution_ref: "help_xyz", remote_run_id: "run_9" };
    const result = await env.service.delegate({
      peer: "molty",
      request: makeRequest(),
      binding: { kind: "create_cli_project", title: "delegate x", goal: "g" },
    });

    const ledger = db.prepare("SELECT * FROM peer_contributions WHERE peer = 'molty'").get() as any;
    expect(ledger.state).toBe("accepted");
    expect(ledger.contribution_ref).toBe("help_xyz");
    const proxy = db.prepare("SELECT notes FROM kanban_board WHERE id = ?").get(result.proxyCardId) as any;
    expect(proxy.notes).toContain("help_xyz");
    expect(proxy.notes).toContain("run_9");
  });

  it("declined decision projects a non-started terminal outcome", async () => {
    const env = makeEnv();
    env.nextResponse = { version: 1, request_id: "req_1", decision: "declined", reason_code: "busy" };
    const result = await env.service.delegate({
      peer: "molty",
      request: makeRequest(),
      binding: { kind: "create_cli_project", title: "delegate x", goal: "g" },
    });
    expect(result.decision).toBe("declined");
    const ledger = db.prepare("SELECT state FROM peer_contributions WHERE peer = 'molty'").get() as any;
    expect(ledger.state).toBe("declined");
  });

  it("transport failure projects unknown and a replay never resends", async () => {
    const env = makeEnv();
    env.nextError = new Error("connection lost");
    const first = await env.service.delegate({
      peer: "molty",
      request: makeRequest(),
      binding: { kind: "create_cli_project", title: "delegate x", goal: "g" },
    });
    expect(first.decision).toBe("unknown");
    const ledger = db.prepare("SELECT state FROM peer_contributions WHERE peer = 'molty'").get() as any;
    expect(ledger.state).toBe("unknown");

    // same request ID, recoverable — replay without a resend
    env.nextError = undefined;
    const second = await env.service.delegate({
      peer: "molty",
      request: makeRequest(),
      binding: { kind: "create_cli_project", title: "delegate x", goal: "g" },
    });
    expect(env.sends).toHaveLength(1);
    expect(second.decision).toBe("unknown");
  });

  it("rejects a conflicting request with different content under the same request id", async () => {
    const env = makeEnv();
    env.nextResponse = { version: 1, request_id: "req_1", decision: "declined" };
    await env.service.delegate({
      peer: "molty",
      request: makeRequest(),
      binding: { kind: "create_cli_project", title: "delegate x", goal: "g" },
    });

    await expect(env.service.delegate({
      peer: "molty",
      request: makeRequest({ goal: "DIFFERENT GOAL" }),
      binding: { kind: "create_cli_project", title: "delegate x", goal: "g" },
    })).rejects.toThrow(/conflicts/);
    const rows = db.prepare("SELECT COUNT(*) as cnt FROM peer_contributions WHERE peer = 'molty'").get() as any;
    expect(rows.cnt).toBe(1);
  });

  it("existing binding creates the proxy under the active project with criterion validation", async () => {
    const env = makeEnv();
    env.nextResponse = { version: 1, request_id: "req_1", decision: "accepted", contribution_ref: "help_keep" };
    const result = await env.service.delegate({
      peer: "molty",
      request: makeRequest(),
      binding: { kind: "existing", projectCardId: 42, rootCriteria: ["c1"] },
    });
    expect(result.projectCardId).toBe(42);
    const proxy = db.prepare("SELECT * FROM kanban_board WHERE type = 'contribution'").get() as any;
    expect(proxy.parent_id).toBe(42);
    const ledger = db.prepare("SELECT root_criteria_json FROM peer_contributions WHERE peer = 'molty'").get() as any;
    expect(JSON.parse(ledger.root_criteria_json)).toEqual(["c1"]);
    expect(env.wakes).toHaveLength(0);
  });

  it("fallback reuse rebinds the same proxy card to a second peer without duplicates", async () => {
    const env = makeEnv();
    env.nextResponse = { version: 1, request_id: "req_1", decision: "declined" };
    const first = await env.service.delegate({
      peer: "molty",
      request: makeRequest(),
      binding: { kind: "create_cli_project", title: "delegate x", goal: "g" },
    });
    expect(first.decision).toBe("declined");

    // fallback to a second peer reusing the same proxy card
    env.nextResponse = { version: 1, request_id: "req_2", decision: "accepted", contribution_ref: "help_fb" };
    const second = await env.service.delegate({
      peer: "other",
      request: makeRequest({ request_id: "req_2" }),
      binding: { kind: "existing", projectCardId: first.projectCardId, rootCriteria: [] },
      proxyCardId: first.proxyCardId,
    });
    expect(second.decision).toBe("accepted");
    expect(second.proxyCardId).toBe(first.proxyCardId);

    const proxies = db.prepare("SELECT COUNT(*) as cnt FROM kanban_board WHERE type = 'contribution'").get() as any;
    expect(proxies.cnt).toBe(1);
    const ledgers = db.prepare("SELECT COUNT(*) as cnt FROM peer_contributions").get() as any;
    expect(ledgers.cnt).toBe(2); // one per peer, both pointing at the same proxy
    const proxy = db.prepare("SELECT parent_id FROM kanban_board WHERE id = ?").get(first.proxyCardId) as any;
    expect(proxy.parent_id).toBe(first.projectCardId);
  });
});
