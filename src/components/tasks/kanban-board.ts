/**
 * kanban-board.ts — Local Kanban board backed by SQLite.
 *
 * Workers write completion; main agent polls and delivers.
 * DB lives at ~/.abtars/kanban/kanban.db
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { abtarsHome } from "../../paths.js";
import { resolveNativeDep } from "../../utils/lazy-require.js";
import { logWarn, logDebug, redactSecrets } from "../logger.js";
import { isValidSessionType } from "../spin-profiles.js";
import { initTaskStateSchema } from "./task-state-schema.js";

// better-sqlite3 is external (native module, resolved from ~/.local/lib/node_modules/)
type SqliteDb = { prepare(sql: string): any; exec(sql: string): void; pragma(s: string): void; transaction<T>(fn: () => T): () => T };

/** #1393 — Typed capability for components that need durable SQLite access alongside kanban. */
export interface TaskDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

/** #1393 — Get the canonical task database. Throws if unavailable (fail-explicit for Pi). */
export function requireTaskDatabase(): TaskDatabase {
  const d = db();
  if (!d) throw new Error("Kanban database unavailable — better-sqlite3 not installed");
  return {
    prepare(sql: string) {
      const stmt = d.prepare(sql);
      return {
          run(...params: unknown[]) { return stmt.run(...params); },
          get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
          all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { d.exec(sql); },
    transaction<T>(fn: () => T): T { return d.transaction(fn)(); },
  };
}

export interface KanbanCard {
  id: number;
  title: string;
  source: string;
  source_id: string | null;
  assignee: string;
  priority: string;
  status: string;
  type: string | null;
  goal: string | null;
  notes: string | null;
  result_summary: string | null;
  result_path: string | null;
  error: string | null;
  delivery_attempts: number;
  approval: string | null;
  due_at: string | null;
  labels: string | null;
  parent_id: number | null;
  blocked_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  delivered_at: string | null;
  max_tokens: number | null;
  max_cost: number | null;
  tokens_used: number | null;
  delivery_mode: string;
  chat_id: string | null;
  source_peer: string | null;
  delivery_claimed_at: string | null;
  delivery_result: string | null;
  delivery_receipt: string | null;
  /** #1516: scheduled project delivery stays blocked until shared validation settles. */
  delivery_ready: number;
  /** #1516: total agent budget (1 Orc + workers) for scheduled projects. */
  max_agents: number | null;
  /** #1539: durable retry backoff marker; only cleared by the promotion helper. */
  next_retry_at: string | null;
}

let _db: SqliteDb | null = null;
let _dbAttempted = false;

/**
 * #1631: the production kanban_board bootstrap, extracted so test fixtures can
 * mirror the real schema without opening the production database. Owns exactly
 * the board CREATE statement and the idempotent ALTER migrations, verbatim
 * from the original db() open path. Performs only `exec` on the caller's
 * database — never calls db()/requireTaskDatabase() and never resolves a
 * native dependency. Transition-journal and task-state initialization stay in
 * db(); they are not board schema.
 */
export function ensureKanbanBoardSchema(database: { exec(sql: string): void }): void {
  database.exec(`CREATE TABLE IF NOT EXISTS kanban_board (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      assignee TEXT DEFAULT 'local',
      priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK(priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','delivering','delivered')),
      type TEXT,
      notes TEXT,
      result_summary TEXT,
      result_path TEXT,
      error TEXT,
      delivery_attempts INTEGER DEFAULT 0,
      approval TEXT CHECK(approval IS NULL OR approval IN ('pending','approved','rejected')),
      due_at TEXT,
      labels TEXT,
      parent_id INTEGER REFERENCES kanban_board(id),
      blocked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      delivered_at TEXT
    )`);
    // Migrations — safe to re-run (silently skip if column exists)
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN max_tokens INTEGER`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN max_cost REAL`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN tokens_used INTEGER DEFAULT 0`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN progress TEXT`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN delivery_mode TEXT DEFAULT 'deliver'`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN retry_count INTEGER DEFAULT 0`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN next_retry_at TEXT`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN chat_id TEXT`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN source_peer TEXT`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN goal TEXT`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN delivery_claimed_at TEXT`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN delivery_result TEXT CHECK(delivery_result IS NULL OR delivery_result IN ('sent','definitely_not_sent','unknown'))`); } catch {}
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN delivery_receipt TEXT`); } catch {}
    // #1516: durable per-project agent cap (scheduled orchestration policy)
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN max_agents INTEGER`); } catch {}
    // #1516: project acceptance happens before scheduled artifact validation.
    try { database.exec(`ALTER TABLE kanban_board ADD COLUMN delivery_ready INTEGER NOT NULL DEFAULT 1`); } catch {}
}

function db(): SqliteDb | null {
  if (_dbAttempted) return _db;
  _dbAttempted = true;
  const dir = join(abtarsHome(), "kanban");
  mkdirSync(dir, { recursive: true });
  try {
    const Database = resolveNativeDep("better-sqlite3");
    _db = new Database(join(dir, "kanban.db")) as SqliteDb;
    _db.pragma("journal_mode = WAL");
    // #1631: production board schema via the shared helper (verbatim DDL +
    // migrations moved here from the inline block).
    ensureKanbanBoardSchema(_db);
    // #1590: append-only status-transition journal (same transaction as the CAS).
    _db.exec(`CREATE TABLE IF NOT EXISTS kanban_card_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      attempt_id TEXT,
      claim_generation INTEGER,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_card_transitions_card
      ON kanban_card_transitions(card_id, id)`);
    // #1601: durable scheduled-run state lives in the same shared database.
    // Idempotent DDL + one-time JSON migration, inside the same open path.
    initTaskStateSchema(wrapTaskDatabase(_db));
  } catch {
    logWarn("kanban", "better-sqlite3 not available — kanban features disabled (run: abtars deps install)");
    _db = null;
  }
  return _db;
}

import { nerve } from "../nerve.js";

/** Return db or null (with warning logged once). */
function dbOrNull(): SqliteDb | null {
  return db();
}

import type { Delivery, DeliveryMode } from "./task-types.js";
import { MAX_SCHEDULED_AGENTS } from "./task-types.js";

// ── #1590: single status-transition choke point ───────────────────────────────
//
// kanbanTransition is the ONLY code allowed to write kanban_board.status. It
// performs a single-statement compare-and-set against an explicit expected-from
// set and appends one row to the append-only kanban_card_transitions journal in
// the same transaction. Illegal DECLARED pairs throw (coding bug); a lost CAS
// is a normal no-op.

export type CardStatus = "queued" | "running" | "done" | "failed" | "delivering" | "delivered";

/** Why the board moved. One value per production call site — not free text. */
export type TransitionActor =
  | "dispatch"              // kanbanRunning, sleep-card start
  | "retry_promotion"       // kanbanPromoteDueRetry
  | "retry_backoff"         // kanbanRetryOrFail
  | "settle_done"           // kanbanComplete
  | "settle_failed"         // kanbanFail, cascadeFail
  | "delivery_claim"        // kanbanClaimDelivery
  | "delivery_settle"       // kanban-delivery markSent/markUnknown/markDefinitelyNotSent
  | "project_acceptance"    // project-review-store 552/610
  | "pi_run_settle"         // pi-run-store 317/322
  | "pi_run_dispatch"       // pi-run-store 518
  | "pi_resume_generation"  // pi-run-store 574 (queueResumeGeneration)
  | "restart_recovery"      // pi-run-store 626
  | "pi_origin_projection"  // boot/phase-pi-executor 105
  | "budget_enforcement"    // reconciler 1015
  | "stale_repair"          // doctor-fixes 166
  | "retry_requeue";        // retry-store successor allocation (#1644)

export interface TransitionRequest {
  readonly cardId: number;
  /** CAS predicate. Must be non-empty. `to` may appear here for reassertion. */
  readonly from: readonly CardStatus[];
  readonly to: CardStatus;
  readonly actor: TransitionActor;
  /** Bounded to 300 chars and redacted before storage. */
  readonly reason: string;
  /** Correlates to worker_attempts when the mover is a supervised attempt. */
  readonly attemptId?: string;
  readonly claimGeneration?: number;
  /**
   * Columns co-written in the SAME statement as the status change. Keys are
   * restricted to the whitelist; values are bound parameters, never
   * interpolated.
   */
  readonly fields?: Readonly<Partial<Record<CoWritableColumn, unknown>>>;
  /**
   * Fixed internal SQL fragment appended to the CAS WHERE clause (allowlisted
   * module constants only — never caller text). Used when a bound cannot be
   * expressed through `from` alone (e.g. delivery_attempts < 5).
   */
  readonly extraPredicate?: string;
  /** Bound parameters for `extraPredicate`. */
  readonly extraPredicateParams?: readonly unknown[];
  /**
   * Default true: fire the STATUS_EVENT nerve event and notifyKanbanDueChanged
   * after commit, exactly like the pre-#1590 board helpers did. Callers whose
   * own layer already fires the event (pi-executor, project-review-service,
   * pi-run-service) or that fired nothing before must pass false to preserve
   * today's wire behavior.
   */
  readonly emit?: boolean;
}

export type CoWritableColumn =
  | "error" | "result_path" | "result_summary" | "retry_count" | "next_retry_at"
  | "delivery_attempts" | "delivery_result" | "delivery_receipt"
  | "completed_at" | "delivered_at";

export type TransitionOutcome =
  /** Status changed. Exactly one journal row written. Events fired. */
  | { readonly kind: "applied"; readonly from: CardStatus }
  /** observed === to. `fields` applied, no status change, NO journal row, no events. */
  | { readonly kind: "reasserted"; readonly observed: CardStatus }
  /** CAS lost, or card absent, or database unavailable. Nothing written. */
  | { readonly kind: "no_op"; readonly observed: CardStatus | null };

const CO_WRITABLE_COLUMNS = new Set<string>([
  "error", "result_path", "result_summary", "retry_count", "next_retry_at",
  "delivery_attempts", "delivery_result", "delivery_receipt",
  "completed_at", "delivered_at",
]);

/**
 * #1590 — Legal transition matrix, Task-1 derived from every production writer
 * (see specs/1590/requirements.md). Each pair cites a real call site; no
 * speculative pairs. `delivered` is terminal: it appears only as a `to`.
 * Deviations from the design draft, both verified against code:
 * - `done → queued` and `failed → queued` are legal because
 *   pi-run-store.ts:574 (queueResumeGeneration) re-queues cards from
 *   `failed|done` — a writer missed by the original enumeration.
 * - `done → running` / `failed → running` (design's "resumed" rows) are NOT
 *   legal: the remote producer sets run.status="queued" on resumed events, so
 *   the origin projection targets `queued`, never `running`.
 */
const LEGAL_TRANSITIONS: Readonly<Record<CardStatus, ReadonlySet<CardStatus>>> = {
  // queued → running: kanbanRunning, kanbanPromoteDueRetry, pi-run-store:518
  // queued → failed:  cascadeFail/kanbanFail, pi-run-store:626, reconciler:1015
  // queued → done:    task-run-settler settles one-shot K/T cards that were
  //                    enqueued but never dispatched (system-task runner path)
  queued: new Set(["running", "failed", "done"]),
  // running → done:   kanbanComplete, pi-run-store:317, project-review-store:552
  // running → failed: kanbanFail, pi-run-store:322/626, project-review-store:610,
  //                   reconciler:1015, doctor-fixes:166
  // running → queued: kanbanRetryOrFail
  running: new Set(["done", "failed", "queued"]),
  // done → delivering: kanbanClaimDelivery, kanbanSetDelivering
  // done → queued:     pi-run-store:574 (queueResumeGeneration)
  // done → failed:     task-run-settler fails an accepted-but-stale project
  //                     when artifact validation runs after acceptance
  done: new Set(["delivering", "queued", "failed"]),
  // failed → queued: pi-run-store:574 (queueResumeGeneration)
  failed: new Set(["queued"]),
  // delivering → delivered: kanbanMarkDelivered, kanban-delivery markSent
  // delivering → done:      kanban-delivery markUnknown/markDefinitelyNotSent
  delivering: new Set(["delivered", "done"]),
  delivered: new Set(),
};

/** #1590 — per-target nerve event, reproducing today's emissions exactly. */
const STATUS_EVENT: Readonly<Record<CardStatus, string | null>> = {
  queued: "card:queued",
  running: "card:running",
  done: "card:done",
  failed: "card:failed",
  delivering: null, // no card:delivering exists today — do not invent one
  delivered: "card:delivered",
};

const MAX_TRANSITIONS_PER_CARD = 200;
const MAX_JOURNAL_REASON = 300;

/**
 * #1590 — allowlisted extra CAS predicates. Callers reference these fixed
 * internal strings only; caller-supplied SQL text is rejected in
 * kanbanTransition.
 */
const EXTRA_PREDICATES = new Set<string>([
  "COALESCE(delivery_attempts, 0) < 5",                    // kanbanClaimDelivery
  "next_retry_at IS NOT NULL AND unixepoch(next_retry_at) <= ?", // kanbanPromoteDueRetry
  "delivery_result IS NULL",                                // kanban-delivery markUnknown
  // #1644: scheduled-project delivery claim — exact root/run/generation,
  // accepted supervision, terminal successful task run, delivery released.
  "COALESCE(delivery_attempts, 0) < 5 AND delivery_ready = 1 AND source_id = ? AND EXISTS (SELECT 1 FROM project_supervision ps WHERE ps.project_card_id = kanban_board.id AND ps.state = 'accepted' AND ps.generation = ?) AND EXISTS (SELECT 1 FROM task_runs tr WHERE tr.run_id = ? AND tr.finished_at IS NOT NULL AND tr.outcome = 'success')",
  // #1644: non-scheduled project delivery claim — accepted supervision at the
  // exact generation, delivery released.
  "COALESCE(delivery_attempts, 0) < 5 AND delivery_ready = 1 AND EXISTS (SELECT 1 FROM project_supervision ps WHERE ps.project_card_id = kanban_board.id AND ps.state = 'accepted' AND ps.generation = ?)",
]);

/** SQLite datetime('now')-compatible UTC timestamp for co-written columns. */
export function sqliteNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** Wrap a raw better-sqlite3 connection as a TaskDatabase (out-of-process callers). */
export function wrapTaskDatabase(db: {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): unknown;
}): TaskDatabase {
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
    transaction<T>(fn: () => T): T { return (db.transaction(fn) as () => T)(); },
  };
}

/** #1590 — the single permitted writer of kanban_board.status. */
export function kanbanTransition(req: TransitionRequest, database?: TaskDatabase): TransitionOutcome {
  if (req.from.length === 0) {
    throw new Error(`illegal kanban transition: empty from-set (${req.to}) (${req.actor})`);
  }
  for (const from of req.from) {
    if (from === req.to) continue; // reassertion intent — same-status, no journal
    if (!LEGAL_TRANSITIONS[from]?.has(req.to)) {
      throw new Error(`illegal kanban transition: ${from} -> ${req.to} (${req.actor})`);
    }
  }
  for (const key of Object.keys(req.fields ?? {})) {
    if (!CO_WRITABLE_COLUMNS.has(key)) {
      throw new Error(`illegal kanban transition: field "${key}" not co-writable (${req.actor})`);
    }
  }
  if (req.extraPredicate !== undefined && !EXTRA_PREDICATES.has(req.extraPredicate)) {
    throw new Error(`illegal kanban transition: extraPredicate not allowlisted (${req.actor})`);
  }

  let tx: TaskDatabase | null = database ?? null;
  if (!tx) {
    const d = dbOrNull();
    if (d) tx = wrapTaskDatabase(d);
  }
  if (!tx) return { kind: "no_op", observed: null };

  // Out-of-process connections (doctor-fixes) may not have run the module
  // bootstrap; ensure the journal schema idempotently.
  if (database) {
    tx.exec(`CREATE TABLE IF NOT EXISTS kanban_card_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      attempt_id TEXT,
      claim_generation INTEGER,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    tx.exec(`CREATE INDEX IF NOT EXISTS idx_card_transitions_card
      ON kanban_card_transitions(card_id, id)`);
  }

  const reason = redactSecrets(req.reason).slice(0, MAX_JOURNAL_REASON);
  const fields = req.fields ?? {};
  const fieldEntries = Object.entries(fields);
  const extraPredicate = req.extraPredicate;

  const outcome = tx.transaction<TransitionOutcome>(() => {
    const row = tx.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(req.cardId) as { status: string } | undefined;
    const observed = row?.status as CardStatus | undefined;

    if (observed === undefined) return { kind: "no_op", observed: null };

    // Reassertion: observed === to AND the caller declared reassertion intent
    // by including `to` in the from-set. Keep the status predicate in the
    // write: the diagnostic SELECT is not the CAS, and a projection must not
    // apply fields to a card that changed status after that read. No journal
    // row is written. Callers that do NOT include `to` (kanbanComplete,
    // claimDelivery) get a lost-CAS no_op instead — nothing written, matching
    // the old guards.
    if (observed === req.to && req.from.includes(req.to)) {
      const sets = [`status = ?`, `updated_at = datetime('now')`];
      const vals: unknown[] = [req.to];
      for (const [k, v] of fieldEntries) { sets.push(`${k} = ?`); vals.push(v); }
      let where = `WHERE id = ? AND status = ?`;
      if (extraPredicate) where += ` AND ${extraPredicate}`;
      const params: unknown[] = [...vals, req.cardId, req.to, ...(req.extraPredicateParams ?? [])];
      const result = tx.prepare(`UPDATE kanban_board SET ${sets.join(", ")} ${where}`).run(...params);
      if (result.changes === 1) {
        return { kind: "reasserted", observed };
      }
      const current = tx.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(req.cardId) as { status: string } | undefined;
      return { kind: "no_op", observed: (current?.status as CardStatus | undefined) ?? null };
    }

    const sets = [`status = ?`, `updated_at = datetime('now')`];
    const vals: unknown[] = [req.to];
    for (const [k, v] of fieldEntries) { sets.push(`${k} = ?`); vals.push(v); }
    const placeholders = req.from.map(() => "?").join(", ");
    let where = `WHERE id = ? AND status IN (${placeholders})`;
    if (extraPredicate) where += ` AND ${extraPredicate}`;
    const params: unknown[] = [...vals, req.cardId, ...req.from, ...(req.extraPredicateParams ?? [])];

    const result = tx.prepare(`UPDATE kanban_board SET ${sets.join(", ")} ${where}`).run(...params);

    if (result.changes === 1) {
      tx.prepare(
        `INSERT INTO kanban_card_transitions (card_id, from_status, to_status, actor, reason, attempt_id, claim_generation)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        req.cardId, observed, req.to, req.actor, reason,
        req.attemptId ?? null, req.claimGeneration ?? null,
      );
      // Bounded growth without a timer: prune the oldest rows per card.
      tx.prepare(
        `DELETE FROM kanban_card_transitions
         WHERE card_id = ? AND id NOT IN (
           SELECT id FROM kanban_card_transitions WHERE card_id = ? ORDER BY id DESC LIMIT ?
         )`
      ).run(req.cardId, req.cardId, MAX_TRANSITIONS_PER_CARD);
      return { kind: "applied", from: observed };
    }

    // CAS lost — re-read for an accurate observed value.
    const current = tx.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(req.cardId) as { status: string } | undefined;
    return { kind: "no_op", observed: (current?.status as CardStatus | undefined) ?? null };
  });

  if (outcome.kind === "applied" && req.emit !== false) {
    const event = STATUS_EVENT[req.to];
    if (event) nerve.fire(event as "card:queued" | "card:running" | "card:done" | "card:failed" | "card:delivered", req.cardId);
    notifyKanbanDueChanged();
  }
  return outcome;
}


export type KanbanPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

const VALID_PRIORITIES = new Set<KanbanPriority>(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export function normalizePriority(raw: string | undefined | null): KanbanPriority {
  if (!raw) return "MEDIUM";
  const upper = raw.toUpperCase();
  return VALID_PRIORITIES.has(upper as KanbanPriority) ? upper as KanbanPriority : "MEDIUM";
}

export function kanbanEnqueue(title: string, source: string, sourceId?: string, opts?: { priority?: string; type?: string; goal?: string; labels?: string; due_at?: string; parent_id?: number; notes?: string; deliveryMode?: DeliveryMode; delivery?: Delivery; blocked_by?: string; chatId?: string; sourcePeer?: string; maxAgents?: number; deliveryReady?: boolean }): number {
  const d = dbOrNull();
  if (!d) return 0;
  const raw = opts?.delivery ?? opts?.deliveryMode ?? "deliver";
  const deliveryMode = raw === "report" ? "deliver" : raw;
  const priority = normalizePriority(opts?.priority);
  // #1516: validate the durable agent cap at the write boundary.
  const maxAgents = opts?.maxAgents;
  if (maxAgents !== undefined && (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > MAX_SCHEDULED_AGENTS)) {
    logWarn("kanban", `rejected invalid max_agents=${String(maxAgents)} (must be an integer 1..${MAX_SCHEDULED_AGENTS})`);
    return 0;
  }
  const stmt = d.prepare(
    `INSERT INTO kanban_board (title, source, source_id, priority, type, goal, labels, due_at, parent_id, notes, delivery_mode, blocked_by, chat_id, source_peer, max_agents, delivery_ready)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = stmt.run(title, source, sourceId ?? null, priority, opts?.type ?? null, opts?.goal ?? null, opts?.labels ?? null, opts?.due_at ?? null, opts?.parent_id ?? null, opts?.notes ?? null, deliveryMode, opts?.blocked_by ?? null, opts?.chatId ?? null, opts?.sourcePeer ?? null, maxAgents ?? null, opts?.deliveryReady === false ? 0 : 1);
  const id = Number(result.lastInsertRowid);
  nerve.fire("card:queued", id);
  return id;
}

export interface CreateCardInput {
  type?: string;
  title: string;
  goal?: string;
  source?: string;
  sourceId?: string;
  priority?: string;
  labels?: string;
  deliveryMode?: DeliveryMode;
  chatId?: string;
  sourcePeer?: string;
}

/** #955 — Shared create operation for dispatchable cards. Validates SessionType,
 *  applies bounds, requires goal for B cards. Returns card ID or error. */
export function createDispatchableCard(input: CreateCardInput): { cardId: number; status: "queued" } | { error: string } {
  const { type, title, goal } = input;
  if (!title || !title.trim()) return { error: "title required" };
  const titleBytes = Buffer.byteLength(title, "utf-8");
  if (titleBytes > 160) return { error: `title exceeds 160 bytes (${titleBytes})` };
  if (type && !isValidSessionType(type)) {
    return { error: `invalid type "${type}": must be a SessionType (A/B/C/T/P/S/O/W/D/H/K)` };
  }
  if (type === "B" && (!goal || !goal.trim())) {
    return { error: "goal is required for type B (Browsie) cards" };
  }
  if (goal) {
    const goalBytes = Buffer.byteLength(goal, "utf-8");
    if (goalBytes > 32768) return { error: `goal exceeds 32 KiB (${goalBytes} bytes)` };
  }
  const cardId = kanbanEnqueue(title, input.source || "agent", input.sourceId, {
    priority: input.priority,
    type,
    goal,
    labels: input.labels,
    deliveryMode: input.deliveryMode,
    chatId: input.chatId,
    sourcePeer: input.sourcePeer,
  });
  if (cardId === 0) return { error: "kanban database unavailable" };
  return { cardId, status: "queued" };
}

export function kanbanRunning(id: number): void {
  kanbanTransition({
    cardId: id, from: ["queued"], to: "running", actor: "dispatch",
    reason: "dispatch to running",
  });
}

/**
 * #1546: atomic due-retry promotion. The single writer that clears
 * `next_retry_at` for a retried root/child: one conditional update from
 * `queued` + due to `running` + no marker, preserving `retry_count` and the
 * retry error. Fires the existing running event and the due-change hook only
 * on one changed row; a lost conditional race is a no-op. The due predicate
 * uses `unixepoch` so both `kanbanRetryOrFail`'s ISO-8601 markers and legacy
 * SQLite `datetime('now')` markers compare correctly.
 */
export function kanbanPromoteDueRetry(cardId: number, now?: number): boolean {
  const nowVal = now ?? Date.now();
  const outcome = kanbanTransition({
    cardId,
    from: ["queued"],
    to: "running",
    actor: "retry_promotion",
    reason: "due retry promotion",
    fields: { next_retry_at: null },
    extraPredicate: "next_retry_at IS NOT NULL AND unixepoch(next_retry_at) <= ?",
    extraPredicateParams: [Math.floor(nowVal / 1000)],
  });
  return outcome.kind === "applied";
}

/** #1539: kanban due-change hook wired to the lifecycle wake scheduler. */
let kanbanDueChangedHook: (() => void) | null = null;
export function setKanbanDueChangedHook(hook: (() => void) | null): void {
  kanbanDueChangedHook = hook;
}
function notifyKanbanDueChanged(): void {
  try {
    kanbanDueChangedHook?.();
  } catch { /* hook failures must never break board writes */ }
}

export function kanbanComplete(id: number, resultPath: string | null, summary: string, emit = true): void {
  // #1590: from includes `queued` because task-run-settler completes one-shot
  // K/T cards that were enqueued but never dispatched (system-task runner
  // path) — verified against production callers, not just the matrix.
  const outcome = kanbanTransition({
    cardId: id, from: ["running", "queued"], to: "done", actor: "settle_done",
    reason: "settlement complete",
    fields: {
      result_path: resultPath,
      result_summary: summary.slice(0, 4000),
      completed_at: sqliteNow(),
    },
    emit,
  });
  // #1590: preserve the pre-CAS debug log for the already-settled case.
  if (outcome.kind === "no_op" && (outcome.observed === "done" || outcome.observed === "delivering" || outcome.observed === "delivered")) {
    logDebug("kanban", `Card ${id}: already ${outcome.observed} — skipping kanbanComplete`);
  }
}

export function kanbanFail(id: number, error: string, emit = true): void {
  // #1590: `done` is included because task-run-settler fails an accepted
  // project card when artifact validation later detects a stale artifact
  // (verified against the scheduled-project integration flow).
  kanbanTransition({
    cardId: id, from: ["queued", "running", "done"], to: "failed", actor: "settle_failed",
    reason: "settlement failed",
    fields: { error: error.slice(0, 1000), completed_at: sqliteNow() },
    emit,
  });
}

const MAX_RETRIES = 3;

/** Fail with retry logic — exponential backoff (10s→20s→40s, cap 5min). After MAX_RETRIES → permanent fail. */
export function kanbanRetryOrFail(id: number, error: string): "retrying" | "failed" {
  const d = dbOrNull();
  if (!d) return "failed";
  const card = d.prepare("SELECT retry_count FROM kanban_board WHERE id = ?").get(id) as { retry_count: number } | undefined;
  const retryCount = (card?.retry_count ?? 0) + 1;
  if (retryCount > MAX_RETRIES) {
    kanbanFail(id, `${error} (after ${MAX_RETRIES} retries)`);
    return "failed";
  }
  const backoffMs = Math.min(10_000 * Math.pow(2, retryCount - 1), 300_000);
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
  // #1590: `queued` is included so a retry of an already-queued card reasserts
  // (fields applied, no journal row) instead of no-op'ing — preserving the old
  // blind-write retry semantics for back-to-back retries.
  const outcome = kanbanTransition({
    cardId: id, from: ["running", "queued"], to: "queued", actor: "retry_backoff",
    reason: "retry backoff",
    fields: { retry_count: retryCount, next_retry_at: nextRetryAt, error: error.slice(0, 1000) },
  });
  if (outcome.kind === "applied" || outcome.kind === "reasserted") return "retrying";
  return "failed";
}

export function kanbanPending(): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(
    `SELECT * FROM kanban_board WHERE status = 'done' AND delivery_attempts < 5 ORDER BY priority = 'CRITICAL' DESC, priority = 'HIGH' DESC, created_at ASC`
  ).all() as KanbanCard[];
}

export function kanbanSetDelivering(id: number): void {
  kanbanTransition({
    cardId: id, from: ["done"], to: "delivering", actor: "delivery_claim",
    reason: "set delivering", emit: false,
  });
}

/** Atomically claim one delivery attempt for a completed card. */
export function kanbanClaimDelivery(id: number): boolean {
  const d = dbOrNull();
  if (!d) return false;
  const row = d.prepare("SELECT COALESCE(delivery_attempts, 0) AS attempts FROM kanban_board WHERE id = ?").get(id) as { attempts: number } | undefined;
  const outcome = kanbanTransition({
    cardId: id,
    from: ["done"],
    to: "delivering",
    actor: "delivery_claim",
    reason: "delivery claim",
    fields: { delivery_attempts: (row?.attempts ?? 0) + 1 },
    extraPredicate: "COALESCE(delivery_attempts, 0) < 5",
    emit: false,
  });
  if (outcome.kind !== "applied") {
    logDebug("kanban-delivery", `delivery_skipped_duplicate card=${id}`);
    return false;
  }
  return true;
}

/**
 * #1644: project-aware delivery claim. Atomically performs `done ->
 * delivering` and increments `delivery_attempts` only while the exact root
 * card/run/project-generation authority holds inside the claim transaction:
 * accepted supervision at the supplied generation, delivery released, and —
 * for a scheduled root — `source_id` matching the run and a terminal
 * successful `task_runs` row. A claim for run N can never authorize run N+1.
 */
export function kanbanClaimProjectDelivery(
  cardId: number,
  authority: { projectGeneration: number; scheduledRunId?: string },
): boolean {
  const d = dbOrNull();
  if (!d) return false;
  const row = d.prepare("SELECT COALESCE(delivery_attempts, 0) AS attempts FROM kanban_board WHERE id = ?").get(cardId) as { attempts: number } | undefined;
  const outcome = kanbanTransition({
    cardId,
    from: ["done"],
    to: "delivering",
    actor: "delivery_claim",
    reason: "project delivery claim",
    fields: { delivery_attempts: (row?.attempts ?? 0) + 1 },
    extraPredicate: authority.scheduledRunId !== undefined
      ? "COALESCE(delivery_attempts, 0) < 5 AND delivery_ready = 1 AND source_id = ? AND EXISTS (SELECT 1 FROM project_supervision ps WHERE ps.project_card_id = kanban_board.id AND ps.state = 'accepted' AND ps.generation = ?) AND EXISTS (SELECT 1 FROM task_runs tr WHERE tr.run_id = ? AND tr.finished_at IS NOT NULL AND tr.outcome = 'success')"
      : "COALESCE(delivery_attempts, 0) < 5 AND delivery_ready = 1 AND EXISTS (SELECT 1 FROM project_supervision ps WHERE ps.project_card_id = kanban_board.id AND ps.state = 'accepted' AND ps.generation = ?)",
    extraPredicateParams: authority.scheduledRunId !== undefined
      ? [authority.scheduledRunId, authority.projectGeneration, authority.scheduledRunId]
      : [authority.projectGeneration],
    emit: false,
  });
  if (outcome.kind !== "applied") {
    logDebug("kanban-delivery", `project_delivery_skipped_duplicate card=${cardId}`);
    return false;
  }
  return true;
}

export function kanbanMarkDelivered(id: number): void {
  kanbanTransition({
    cardId: id, from: ["delivering"], to: "delivered", actor: "delivery_settle",
    reason: "delivery complete",
    fields: { delivered_at: sqliteNow() },
  });
}

/**
 * #1539: durable Kanban retry due items for the lifecycle wake scheduler.
 * Queued cards whose `next_retry_at` has passed are woken by the source; the
 * earliest future one arms the shared timer.
 */
export function kanbanDueRetryItems(): Array<{ key: string; dueAt: number }> {
  const d = dbOrNull();
  if (!d) return [];
  const rows = d.prepare(
    `SELECT id, next_retry_at FROM kanban_board WHERE status = 'queued' AND next_retry_at IS NOT NULL`
  ).all() as Array<{ id: number; next_retry_at: string }>;
  return rows.flatMap(r => {
    const t = new Date(r.next_retry_at).getTime();
    if (!Number.isFinite(t)) return [];
    return [{ key: `kanban:${r.id}`, dueAt: t }];
  });
}


/** #1298: Cross-field LIKE search across title/status/source/priority/labels/type. */
export function kanbanSearch(term: string): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  const safe = term.replace(/[%_]/g, ""); // strip LIKE wildcards to avoid user-controlled patterns
  const like = `%${safe}%`;
  return d.prepare(
    `SELECT * FROM kanban_board
     WHERE title LIKE ? OR status LIKE ? OR source LIKE ? OR priority LIKE ? OR labels LIKE ? OR type LIKE ?
     ORDER BY created_at DESC LIMIT 50`
  ).all(like, like, like, like, like, like) as KanbanCard[];
}


export function kanbanList(filter?: string, filterKey?: string): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  if (filter === "*") {
    return d.prepare(`SELECT * FROM kanban_board ORDER BY created_at DESC LIMIT 50`).all() as KanbanCard[];
  }
  if (filter && filterKey) {
    if (filterKey === "labels") {
      return d.prepare(`SELECT * FROM kanban_board WHERE labels LIKE ? ORDER BY created_at DESC LIMIT 50`).all(`%${filter}%`) as KanbanCard[];
    }
    const allowed = new Set(["status", "source", "priority", "type"]);
    if (allowed.has(filterKey)) {
      return d.prepare(`SELECT * FROM kanban_board WHERE ${filterKey} = ? ORDER BY created_at DESC LIMIT 50`).all(filter) as KanbanCard[];
    }
  }
  if (filter) {
    return d.prepare(`SELECT * FROM kanban_board WHERE status = ? ORDER BY created_at DESC LIMIT 50`).all(filter) as KanbanCard[];
  }
  return d.prepare(`SELECT * FROM kanban_board WHERE status NOT IN ('delivered') ORDER BY status = 'running' DESC, priority = 'CRITICAL' DESC, created_at DESC LIMIT 50`).all() as KanbanCard[];
}

export function kanbanUpdate(id: number, fields: Partial<Pick<KanbanCard, "title" | "priority" | "type" | "labels" | "due_at" | "notes" | "parent_id" | "approval">>): void {
  const d = dbOrNull();
  if (!d) return;
  const allowed = new Set(["title", "priority", "type", "labels", "due_at", "notes", "parent_id", "approval"]);
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) throw new Error(`kanbanUpdate cannot update field "${k}"`);
    if (v === undefined) continue;
    if (k === "priority") {
      sets.push("priority = ?");
      vals.push(normalizePriority(v as string));
    } else {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (vals.length === 0) return;
  vals.push(id);
  d.prepare(`UPDATE kanban_board SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function kanbanCleanup(olderThanDays = 7): number {
  const d = dbOrNull();
  if (!d) return 0;
  // #1590: journal rows must not outlive their card — delete in the same
  // transaction as the board rows. All terminal statuses age out: delivered
  // on delivered_at, done/failed on completed_at (fallback updated_at for
  // cards whose completion never stamped a timestamp).
  return d.transaction(() => {
    const doomed = d.prepare(
      `SELECT id FROM kanban_board
       WHERE (status = 'delivered' AND delivered_at < datetime('now', '-' || ? || ' days'))
          OR (status IN ('done','failed') AND COALESCE(completed_at, updated_at) < datetime('now', '-' || ? || ' days'))`
    ).all(olderThanDays, olderThanDays) as Array<{ id: number }>;
    const ids = doomed.map(r => r.id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    d.prepare(`DELETE FROM kanban_card_transitions WHERE card_id IN (${placeholders})`).run(...ids);
    return d.prepare(`DELETE FROM kanban_board WHERE id IN (${placeholders})`).run(...ids).changes;
  })();
}

export function kanbanGetCard(id: number): KanbanCard | undefined {
  const d = dbOrNull();
  if (!d) return undefined;
  return d.prepare(`SELECT * FROM kanban_board WHERE id = ?`).get(id) as KanbanCard | undefined;
}

/** Find a durable remote-delegation proxy by its peer-scoped request ID. */
export function kanbanFindRemoteDelegation(peer: string, requestId: string): KanbanCard | undefined {
  const d = dbOrNull();
  if (!d) return undefined;
  return d.prepare(
    `SELECT * FROM kanban_board
     WHERE source = 'peer' AND type = 'remote' AND source_id = ? AND source_peer = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(requestId, peer) as KanbanCard | undefined;
}

/** Test-only: run a raw SQL statement against the kanban DB (avoids direct better-sqlite3 require in tests). */
export function _kanbanExecForTest(sql: string, params: unknown[] = []): void {
  const d = dbOrNull();
  if (!d) throw new Error("kanban DB not initialised");
  d.prepare(sql).run(...params);
}

export function kanbanGetChildren(parentId: number): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(`SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id`).all(parentId) as KanbanCard[];
}

// ── #1516: bounded agent orchestration ───────────────────────────────────────

export type WorkerSlotResult =
  | { ok: true }
  | { ok: false; reason: "agent_cap_reached"; active: number; workerLimit: number };

export const KANBAN_TERMINAL_STATUSES: readonly string[] = ["done", "delivered", "failed"];

/**
 * #1516: Central child-admission authority. For a project with a durable
 * max_agents cap, refuse a new Worker when admitting it would push active
 * non-terminal type-W children to or past `max_agents - 1`. Queued/admitted
 * children count; terminal history does not. Uncapped projects always admit.
 * The count runs on the same synchronous task-database connection as the
 * subsequent child-card insert, so admission cannot interleave.
 */
export function checkWorkerSlotForProject(rootCardId: number): WorkerSlotResult {
  const d = dbOrNull();
  if (!d) return { ok: true };
  const root = d.prepare(`SELECT max_agents FROM kanban_board WHERE id = ?`).get(rootCardId) as { max_agents: number | null } | undefined;
  if (!root || root.max_agents == null) return { ok: true };
  const workerLimit = root.max_agents - 1;
  const placeholders = KANBAN_TERMINAL_STATUSES.map(() => "?").join(",");
  const row = d.prepare(
    `SELECT COUNT(*) AS active FROM kanban_board WHERE parent_id = ? AND type = 'W' AND status NOT IN (${placeholders})`
  ).get(rootCardId, ...KANBAN_TERMINAL_STATUSES) as { active: number };
  const active = Number(row.active);
  if (active >= workerLimit) return { ok: false, reason: "agent_cap_reached", active, workerLimit };
  return { ok: true };
}

/**
 * #1516: Attach the validated report artifact to an accepted project card.
 * Project acceptance already marks the root card done; this fills in the
 * delivery payload without re-triggering settlement. Idempotent — only
 * applies while result_path is still null.
 */
export function kanbanAttachResult(cardId: number, resultPath: string, summary: string): void {
  const d = dbOrNull();
  if (!d) return;
  d.prepare(
    `UPDATE kanban_board SET result_path = ?, result_summary = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'done' AND result_path IS NULL`
  ).run(resultPath, summary.slice(0, 4000), cardId);
}

/** #1516: Release a scheduled project for delivery after shared settlement. */
export function kanbanSetDeliveryReady(cardId: number): void {
  const d = dbOrNull();
  if (!d) return;
  const result = d.prepare(
    `UPDATE kanban_board SET delivery_ready = 1, updated_at = datetime('now')
     WHERE id = ? AND status = 'done' AND delivery_ready = 0`
  ).run(cardId) as { changes?: number };
  if ((result.changes ?? 0) === 1) nerve.fire("card:done", cardId);
}

/**
 * #1644: project-aware artifact attach. The single winning successful
 * scheduled settlement may attach the validated result path only while the
 * exact root/run/project-generation authority holds inside this statement:
 * accepted supervision at the supplied generation and, for a scheduled root,
 * `source_id` matching the run with a terminal successful `task_runs` row. A
 * stale result path from a failed or older run is never attached — it may
 * remain on disk but is not product output.
 */
export function kanbanAttachProjectResult(
  cardId: number,
  resultPath: string,
  summary: string,
  authority: { projectGeneration: number; scheduledRunId?: string },
): void {
  const d = dbOrNull();
  if (!d) return;
  if (authority.scheduledRunId !== undefined) {
    d.prepare(
      `UPDATE kanban_board SET result_path = ?, result_summary = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'done' AND result_path IS NULL
         AND source_id = ?
         AND EXISTS (SELECT 1 FROM project_supervision ps WHERE ps.project_card_id = kanban_board.id AND ps.state = 'accepted' AND ps.generation = ?)
         AND EXISTS (SELECT 1 FROM task_runs tr WHERE tr.run_id = ? AND tr.finished_at IS NOT NULL AND tr.outcome = 'success')`
    ).run(resultPath, summary.slice(0, 4000), cardId, authority.scheduledRunId, authority.projectGeneration, authority.scheduledRunId);
    return;
  }
  d.prepare(
    `UPDATE kanban_board SET result_path = ?, result_summary = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'done' AND result_path IS NULL
       AND EXISTS (SELECT 1 FROM project_supervision ps WHERE ps.project_card_id = kanban_board.id AND ps.state = 'accepted' AND ps.generation = ?)`
  ).run(resultPath, summary.slice(0, 4000), cardId, authority.projectGeneration);
}

/**
 * #1644: project-aware delivery release. Sets `delivery_ready = 1` only while
 * the exact root/run/project-generation authority holds inside this statement.
 * A late promise from a failed or older run loses this CAS and never releases
 * delivery.
 */
export function kanbanSetProjectDeliveryReady(
  cardId: number,
  authority: { projectGeneration: number; scheduledRunId?: string },
): void {
  const d = dbOrNull();
  if (!d) return;
  let result: { changes?: number };
  if (authority.scheduledRunId !== undefined) {
    result = d.prepare(
      `UPDATE kanban_board SET delivery_ready = 1, updated_at = datetime('now')
       WHERE id = ? AND status = 'done' AND delivery_ready = 0
         AND source_id = ?
         AND EXISTS (SELECT 1 FROM project_supervision ps WHERE ps.project_card_id = kanban_board.id AND ps.state = 'accepted' AND ps.generation = ?)
         AND EXISTS (SELECT 1 FROM task_runs tr WHERE tr.run_id = ? AND tr.finished_at IS NOT NULL AND tr.outcome = 'success')`
    ).run(cardId, authority.scheduledRunId, authority.projectGeneration, authority.scheduledRunId) as { changes?: number };
  } else {
    result = d.prepare(
      `UPDATE kanban_board SET delivery_ready = 1, updated_at = datetime('now')
       WHERE id = ? AND status = 'done' AND delivery_ready = 0
         AND EXISTS (SELECT 1 FROM project_supervision ps WHERE ps.project_card_id = kanban_board.id AND ps.state = 'accepted' AND ps.generation = ?)`
    ).run(cardId, authority.projectGeneration) as { changes?: number };
  }
  if ((result.changes ?? 0) === 1) nerve.fire("card:done", cardId);
}

export function kanbanAddTokens(id: number, tokens: number): void {
  const d = dbOrNull();
  if (!d) return;
  d.prepare(`UPDATE kanban_board SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now') WHERE id = ?`).run(tokens, id);
  const card = kanbanGetCard(id);
  if (card?.parent_id) {
    d.prepare(`UPDATE kanban_board SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now') WHERE id = ?`).run(tokens, card.parent_id);
  }
}

// #907: Worker progress — 30s debounce per card
const _progressTimers = new Map<number, ReturnType<typeof setTimeout>>();
const _progressPending = new Map<number, Record<string, unknown>>();

export function kanbanProgress(id: number, data: { toolUseCount?: number; tokenCount?: number; lastTool?: string; summary?: string }): void {
  _progressPending.set(id, data);
  if (_progressTimers.has(id)) return;
  _progressTimers.set(id, setTimeout(() => {
    _progressTimers.delete(id);
    const pending = _progressPending.get(id);
    if (pending) {
      const d = dbOrNull();
      if (d) d.prepare(`UPDATE kanban_board SET progress = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(pending), id);
      _progressPending.delete(id);
    }
  }, 30_000));
}

// ── DAG orchestration (#677) ─────────────────────────────────────────────────

/** Check if all dependencies of a card are satisfied. */
export function isUnblocked(card: KanbanCard): boolean {
  if (!card.blocked_by) return true;
  if (card.blocked_by === "children") {
    const kids = kanbanGetChildren(card.id);
    return kids.length > 0 && kids.every(k => k.status === "done" || k.status === "delivered");
  }
  const depIds = card.blocked_by.split(",").map(Number).filter(n => !isNaN(n));
  if (depIds.length === 0) return true;
  return depIds.every(id => {
    const dep = kanbanGetCard(id);
    return dep?.status === "done" || dep?.status === "delivered";
  });
}

/** Cascade-fail all cards depending (transitively) on a failed card. */
export function cascadeFail(failedId: number, projectCards: KanbanCard[]): void {
  for (const card of projectCards) {
    if (card.status !== "queued") continue;
    if (!card.blocked_by) continue;
    const deps = card.blocked_by.split(",").map(Number).filter(n => !isNaN(n));
    if (deps.includes(failedId)) {
      kanbanFail(card.id, `upstream #${failedId} failed`);
      cascadeFail(card.id, projectCards);
    }
  }
}

const MAX_ANCESTOR_DEPTH = 100;

/**
 * #1319: Walk parent_id chain to find the root card. Returns undefined if the
 * chain exceeds MAX_ANCESTOR_DEPTH or contains a cycle (detected via visited set).
 */
export function resolveRootId(cardId: number): number | undefined {
  const visited = new Set<number>();
  let current: number | undefined = cardId;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    if (current === undefined || current === null) return undefined;
    if (visited.has(current)) return undefined; // cycle
    visited.add(current);
    const card = kanbanGetCard(current);
    if (!card) return current;
    if (card.parent_id === undefined || card.parent_id === null) return current;
    current = card.parent_id;
  }
  return undefined; // depth exceeded
}

/** #1414: Return IDs of all currently running O-type project cards. */
export function kanbanRunningProjectIds(): number[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(
    `SELECT id FROM kanban_board WHERE status = 'running' AND type = 'O' ORDER BY id`
  ).all().map((row: Record<string, unknown>) => Number(row.id));
}

/**
 * #1628: stranded Orc roots — a live Kanban status with non-terminal
 * supervision and no live Orc run. The durability floor for a project whose
 * ownership relinquishment committed but whose recovery event was lost (e.g.
 * a crash between the release commit and the publish), or whose root was
 * queued with no run ever claimed. Project 63's exact state.
 *
 * Best-effort: the joined supervision/run tables are created lazily by their
 * owning stores; a boot that has not constructed them yet yields no strandings.
 */
export function kanbanStrandedQueuedProjectIds(): number[] {
  const d = dbOrNull();
  if (!d) return [];
  try {
    return d.prepare(`
      SELECT k.id AS project_card_id
        FROM kanban_board k
        JOIN project_supervision s ON s.project_card_id = k.id
       WHERE k.type = 'O'
         AND k.status IN ('queued', 'running')
         AND s.state NOT IN ('accepted', 'blocked')
         AND NOT EXISTS (
           SELECT 1 FROM orc_project_runs r
            WHERE r.project_card_id = k.id
              AND r.state IN ('scheduled', 'dispatching', 'running')
         )
       ORDER BY k.id
    `).all().map((row: Record<string, unknown>) => Number(row.project_card_id));
  } catch (err) {
    logDebug("kanban", `stranded-project sweep unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * #1510: Return queued cards in effective dispatch order (priority/age promotion).
 * Uses SQLite epoch arithmetic for deterministic ordering. Excludes cards whose
 * next_retry_at is still in the future. Accepts explicit `now` for testing.
 */
export function kanbanQueuedDispatchOrder(now?: number): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  const nowVal = now ?? Date.now();
  const rows = d.prepare(`
    SELECT *, (
      SELECT MIN(3, CASE k.priority
        WHEN 'CRITICAL' THEN 3 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 1 ELSE 0
        END + MAX(0, CAST((? - unixepoch(k.created_at)) * 1000 AS INTEGER)) / 60000)
    ) AS effective_priority
    FROM kanban_board k
    WHERE k.status = 'queued'
      AND (k.next_retry_at IS NULL OR unixepoch(k.next_retry_at) <= ?)
    ORDER BY effective_priority DESC, k.created_at ASC, k.id ASC
  `).all(nowVal, Math.floor(nowVal / 1000)) as KanbanCard[];
  return rows;
}

/**
 * #1319: List active (queued/running) direct children of a card, up to `maxCount`.
 * Multi-level descendant resolution is not needed for v1 — Orc's project hierarchy
 * is one level deep (root → direct child cards).
 */
export function resolveActiveDescendants(rootId: number, maxCount = 50): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(
    `SELECT * FROM kanban_board WHERE parent_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT ?`,
  ).all(rootId, maxCount) as KanbanCard[];
}

/**
 * #1319: Get the most recent direct children with terminal states,
 * at most `maxCount`.
 */
export function resolveRecentDirectChildren(parentId: number, maxCount = 20): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(
    `SELECT * FROM kanban_board WHERE parent_id = ? AND status IN ('done', 'failed', 'delivered') ORDER BY updated_at DESC LIMIT ?`,
  ).all(parentId, maxCount) as KanbanCard[];
}
