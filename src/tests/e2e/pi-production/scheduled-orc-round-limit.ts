/**
 * scheduled-orc-round-limit.ts — #1548 Task 7: Pi production-composition
 * scheduled-project cells.
 *
 * Drives the BUILT bridge (bundle/abtars.js) with a real scheduled project task:
 * the task is admitted through the real CronQueue/scheduled runner, the Orc
 * contract-authoring turn runs through the real Pi transport and the loopback
 * scripted provider, and `maxToolRounds=2` reproduces the terminal
 * round-limit failure class. The first cell observes the correlated scheduled
 * run after the failure; the second restarts the built bridge and verifies
 * the same durable run identity is recovered before recording custody
 * evidence. No live provider is required.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TIMEOUTS, type ProviderSummary } from "./contracts.js";
import { FIXTURE_MODEL_A, FIXTURE_MODEL_B } from "./bridge-config.js";
import { waitFor } from "./child-process.js";
import type { PiAcceptanceContext } from "./scenarios.js";
import { resolveNativeDep } from "../../../utils/lazy-require.js";
import { getRunFromDatabase } from "../../../components/tasks/task-history-store.js";
import { wrapTaskDatabase } from "../../../components/tasks/kanban-board.js";

export const SCHEDULED_TASK_ID = "scheduled-limit";
export const SCHEDULED_GOAL = `PI-E2E-SCHEDULED ${SCHEDULED_TASK_ID}`;

/** #1548 R9: bounded scheduled fixture + per-scenario maxToolRounds override. */
export function installScheduledRoundLimitFixture(ctx: PiAcceptanceContext): void {
  const home = ctx.abtarsHome;
  mkdirSync(join(home, "tasks"), { recursive: true });
  writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([{
    id: SCHEDULED_TASK_ID,
    kind: "agent",
    prompt: SCHEDULED_GOAL,
    agent: "task",
    interaction: { mode: "oneshot" },
    orchestration: { maxAgents: 2 },
    schedule: "* * * * *",
    enabled: true,
    priority: "medium",
    delivery: "silent",
  }], null, 2));
  // Pre-seed the durable runtime state (the shared task database, #1601) so
  // the first boot tick admits the task immediately instead of waiting for
  // the next cron boundary. The table DDL is created idempotently by the
  // bridge at boot; the fixture creates it early with the same statements.
  mkdirSync(join(home, "kanban"), { recursive: true });
  const Database = resolveNativeDep("better-sqlite3") as new (path: string) => { prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }; exec(sql: string): void };
  const db = new Database(join(home, "kanban", "kanban.db"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_state (
        task_id TEXT PRIMARY KEY,
        next_run_at INTEGER, last_started_at INTEGER, last_finished_at INTEGER,
        retry_at INTEGER, retrying INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0, retry_group_id TEXT,
        retry_attempt INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_deferrals INTEGER NOT NULL DEFAULT 0,
        auto_paused INTEGER NOT NULL DEFAULT 0, paused_at INTEGER,
        prior_failure TEXT, last_incident_json TEXT, deferred_admission_json TEXT
      );
    `);
    db.prepare(
      "INSERT OR IGNORE INTO task_state (task_id, next_run_at, consecutive_failures, consecutive_deferrals, auto_paused) VALUES (?, ?, 0, 0, 0)",
    ).run(SCHEDULED_TASK_ID, Date.now() - 60_000);
  } finally {
    (db as unknown as { close(): void }).close();
  }

  // Per-scenario tool-round override: the round-limit failure class needs
  // maxToolRounds=2 in the transport config the restarted bridge loads.
  const transportPath = join(home, "config", "transport.json");
  const transport = JSON.parse(readFileSync(transportPath, "utf-8")) as { maxToolRounds?: number };
  transport.maxToolRounds = 2;
  writeFileSync(transportPath, JSON.stringify(transport, null, 2));
}

interface BridgeHomeEvidence {
  runId?: string;
  cardId?: number;
  phase?: string;
  terminalOutcome?: string;
  supervisionState?: string;
  workerCardCount: number;
  providerRoundLimit: boolean;
  /** #1900: durable Orc authoring failure code for the scheduled card. */
  orcFailureCode?: string;
  /** #1900: correlated terminal authoring evidence (prompt_round_limit). */
  orcRoundLimit: boolean;
  /** #1900: Orc release timestamp for freshness correlation. */
  orcReleasedAt?: string;
  /** #1900: last durable read error — never treated as proof of absence. */
  dbReadError?: string;
}

export type { BridgeHomeEvidence };

export function isScheduledSummary(summary: ProviderSummary): boolean {
  // #1900: full-request recognition via bounded registered identities.
  // The synthetic goal is matched in complete message text before preview
  // truncation, so its offset beyond 300 chars or inside decorated context
  // no longer matters. Preview substring matching is retired.
  return summary.matchedMarkers.includes(SCHEDULED_GOAL);
}

/** Read-only evidence over the bridge home's durable files. */
export function readBridgeHomeEvidence(ctx: PiAcceptanceContext, providerSummaries: ProviderSummary[]): BridgeHomeEvidence {
  const home = ctx.abtarsHome;
  const evidence: BridgeHomeEvidence = { workerCardCount: 0, providerRoundLimit: false, orcRoundLimit: false };

  // #1601: durable run state now lives in the shared task database
  // (task_runs rows); the legacy task-state.json is migrated once at boot.
  // #1568: the terminal event lives in the bounded task_run_history table.
  const dbPath = join(home, "kanban", "kanban.db");
  if (!existsSync(dbPath)) {
    evidence.dbReadError = `kanban db missing at ${dbPath}`;
  } else {
    try {
      // Reuse the production native-dependency resolver. The bridge HOME is
      // isolated, but the dependency itself is the existing host install.
      const Database = resolveNativeDep("better-sqlite3") as new (path: string, opts: { readonly: boolean }) => {
        prepare(sql: string): { run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint }; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
        exec(sql: string): void;
        transaction<T>(fn: () => T): () => T;
      };
      const db = new Database(dbPath, { readonly: true });
      try {
        const run = db.prepare("SELECT run_id, card_id, phase FROM task_runs WHERE task_id = ? ORDER BY reserved_at DESC LIMIT 1").get(SCHEDULED_TASK_ID) as { run_id?: string; card_id?: number | null; phase?: string } | undefined;
        evidence.runId = run?.run_id;
        evidence.cardId = run?.card_id ?? undefined;
        evidence.phase = run?.phase;

        // Use the public history codec/API and correlate to the exact
        // reservation, rather than treating the table as an acceptance API.
        if (evidence.runId) {
          const event = getRunFromDatabase(wrapTaskDatabase(db), evidence.runId);
          evidence.terminalOutcome = event?.outcome;
        }

        if (evidence.cardId !== undefined) {
          const sup = db.prepare("SELECT state FROM project_supervision WHERE project_card_id = ?").get(evidence.cardId) as { state?: string } | undefined;
          evidence.supervisionState = sup?.state;
          const children = db.prepare("SELECT COUNT(*) AS n FROM kanban_board WHERE parent_id = ?").get(evidence.cardId) as { n: number };
          evidence.workerCardCount = Number(children?.n ?? 0);
          // #1900: durable Orc authoring terminal class, read-only without
          // instantiating a production store that would migrate the database.
          // The authoring attempt ends with prompt_round_limit; Spin releases
          // the owned Orc run with that failure code. Filter to the
          // contract-authoring intent so unrelated worker/review runs cannot
          // satisfy the evidence.
          try {
            const orc = db.prepare(
              "SELECT failure_code, released_at FROM orc_project_runs WHERE project_card_id = ? AND intent_kind = 'contract_authoring' ORDER BY created_at DESC LIMIT 1",
            ).get(evidence.cardId) as { failure_code?: string | null; released_at?: string | null } | undefined;
            evidence.orcFailureCode = orc?.failure_code ?? undefined;
            evidence.orcReleasedAt = orc?.released_at ?? undefined;
            evidence.orcRoundLimit = evidence.orcFailureCode === "prompt_round_limit";
          } catch (err) {
            // Missing table or unreadable rows fail the cell below; never
            // treated as proof of an absent terminal event.
            evidence.dbReadError = `orc runs unreadable: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      } finally {
        (db as unknown as { close(): void }).close();
      }
    } catch (err) {
      // #1900: database read errors cannot be treated as proof of an absent
      // terminal event. Record and fail the cell; provider evidence alone is
      // insufficient.
      evidence.dbReadError = `kanban db unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Round-limit class: two matching tool-call responses after the restart
  // sequence boundary. Request counts alone are insufficient.
  const scheduled = providerSummaries.filter(isScheduledSummary);
  const toolResponses = scheduled.filter((s) => s.action === "toolCall");
  evidence.providerRoundLimit = toolResponses.length >= 2;

  return evidence;
}

function enqueueToolRounds(ctx: PiAcceptanceContext, count: number): void {
  // #1900: constrain scheduled tool scripts to candidate B plus presence of
  // the synthetic goal. Unrelated B traffic stays unscripted (HTTP 503) and
  // cannot consume these responses. The strict option has no general
  // non-consuming fallback that could conceal unaccepted traffic.
  ctx.provider.registerMarker(SCHEDULED_GOAL);
  for (let i = 0; i < count; i++) {
    ctx.provider.enqueue({
      // Scheduled project authoring uses the production O session profile,
      // whose agent is browsie. In this fixture that role resolves to the
      // fallback candidate B; queue the responses on the route the real Orc
      // request actually takes rather than changing production routing.
      candidate: FIXTURE_MODEL_B,
      expectation: {
        candidate: FIXTURE_MODEL_B,
        orderedContains: [SCHEDULED_GOAL],
      },
      action: { kind: "toolCall", name: "execute_bash", arguments: { command: "echo round" } },
    });
  }
}

/** #1900: explicit boot-greeting scripts so a fresh bridge's autonomous
 *  [SESSION START] turn never consumes a scheduled response and never takes
 *  a 503 that would mark the candidate unhealthy. Constrained to the boot
 *  marker so scheduled traffic cannot consume them. */
function enqueueBootGreeting(ctx: PiAcceptanceContext): void {
  for (const candidate of [FIXTURE_MODEL_A, FIXTURE_MODEL_B] as const) {
    ctx.provider.enqueue({
      candidate,
      expectation: {
        candidate,
        orderedContains: ["[SESSION START]"],
      },
      action: { kind: "text", chunks: ["boot ok"] },
    });
  }
}

/** #1900: explicit health-probe scripts for the model's `hi` check. The probe
 *  is a single `hi` user message; without a script it takes a 503 that marks
 *  the candidate unhealthy and suppresses the scheduled authoring that follows.
 *  Constrained to `hi` with excludes so scheduled/PI traffic cannot consume
 *  them and they cannot conceal unaccepted traffic. */
function enqueueHealthProbe(ctx: PiAcceptanceContext): void {
  for (const candidate of [FIXTURE_MODEL_A, FIXTURE_MODEL_B] as const) {
    for (let i = 0; i < 2; i++) {
      ctx.provider.enqueue({
        candidate,
        expectation: {
          candidate,
          orderedContains: ["hi"],
          excludes: [SCHEDULED_GOAL, "[SESSION START]", "PI-E2E-", "PI-SMOKE-"],
        },
        action: { kind: "text", chunks: ["ok"] },
      });
    }
  }
}

/** #1900: freshness gate — a new observation cannot reuse an earlier
 *  attempt's terminal evidence. The Orc release must be at/after the
 *  observation's restart boundary (5s clock slack). */
export function isFreshOrcEvidence(evidence: BridgeHomeEvidence, observationStart: number): boolean {
  if (!evidence.orcReleasedAt) return false;
  const releasedMs = Date.parse(evidence.orcReleasedAt);
  if (Number.isNaN(releasedMs)) return false;
  return releasedMs >= observationStart - 5_000;
}

/** #1900: one 180s observation budget after each restart becomes ready,
 *  covering provider rounds plus terminal-attempt settlement. No fresh
 *  timeout per probe. Freshness: the Orc release must be at or after the
 *  observation start so a new observation cannot reuse an earlier attempt's
 *  terminal evidence. */
async function waitForScheduledObservation(
  ctx: PiAcceptanceContext,
  afterSeq: number,
  observationStart: number,
): Promise<{ summaries: ProviderSummary[]; evidence: BridgeHomeEvidence }> {
  return waitFor(async () => {
    const summaries = ctx.provider.summariesFor(FIXTURE_MODEL_B).filter((s) => s.seq > afterSeq);
    const scheduled = summaries.filter(isScheduledSummary);
    const toolResponses = scheduled.filter((s) => s.action === "toolCall");
    if (toolResponses.length < 2) return null;
    const evidence = readBridgeHomeEvidence(ctx, summaries);
    if (evidence.dbReadError) return null;
    if (!evidence.providerRoundLimit) return null;
    if (!evidence.orcRoundLimit) return null;
    // Freshness: Orc release at/after this observation's restart boundary.
    if (!isFreshOrcEvidence(evidence, observationStart)) return null;
    if (!evidence.runId || evidence.cardId === undefined) return null;
    if (evidence.terminalOutcome !== undefined) return null;
    if (evidence.supervisionState !== "awaiting_contract") return null;
    return { summaries, evidence };
  }, TIMEOUTS.scheduledObservationMs, `scheduled Orc observation for ${SCHEDULED_TASK_ID} (180s budget)`, () => {
    // Bounded diagnostics for the timeout — counts and identities only.
    const summaries = ctx.provider.summariesFor(FIXTURE_MODEL_B).filter((s) => s.seq > afterSeq);
    const scheduled = summaries.filter(isScheduledSummary);
    const evidence = readBridgeHomeEvidence(ctx, summaries);
    return [
      `afterSeq=${afterSeq} bTotal=${summaries.length} matched=${scheduled.length}`,
      `toolResponses=${scheduled.filter((s) => s.action === "toolCall").length}`,
      `runId=${evidence.runId ?? "none"} cardId=${evidence.cardId ?? "none"}`,
      `supervision=${evidence.supervisionState ?? "none"} terminal=${evidence.terminalOutcome ?? "none"}`,
      `orc=${evidence.orcFailureCode ?? "none"} fresh=${evidence.orcReleasedAt ?? "none"}`,
      `dbError=${evidence.dbReadError ?? "none"}`,
    ].join(" ");
  });
}

/** #1548 Task 7 cell A: Orc round-limit failure during a scheduled project. */
export async function scheduledOrcRoundLimit(ctx: PiAcceptanceContext): Promise<void> {
  installScheduledRoundLimitFixture(ctx);
  enqueueToolRounds(ctx, 8); // covers the authoring retries inside the window
  enqueueBootGreeting(ctx);
  enqueueHealthProbe(ctx);
  const afterSeq = ctx.provider.requestCount;
  const observationStart = Date.now();
  ctx.bridge = await ctx.restartBridge();

  const observed = await waitForScheduledObservation(ctx, afterSeq, observationStart);
  const summaries = observed.summaries;
  const evidence = observed.evidence;
  // #1900: bounded match evidence only — registered identities/hashes, never
  // complete request text or expanded previews.
  ctx.writeArtifact("scheduled-orc-round-limit.json", JSON.stringify({
    evidence: {
      runId: evidence.runId,
      cardId: evidence.cardId,
      supervisionState: evidence.supervisionState,
      terminalOutcome: evidence.terminalOutcome,
      orcFailureCode: evidence.orcFailureCode,
      providerRoundLimit: evidence.providerRoundLimit,
      orcRoundLimit: evidence.orcRoundLimit,
    },
    providerSummaries: summaries.filter(isScheduledSummary).map((s) => ({
      seq: s.seq,
      action: s.action,
      toolCalls: s.toolCalls,
      matchedMarkers: s.matchedMarkers,
      markerHashes: s.markerHashes,
    })),
  }, null, 2));

  if (evidence.dbReadError) {
    throw new Error(`scheduled-orc-round-limit: durable evidence unreadable (${evidence.dbReadError})`);
  }
  if (!evidence.providerRoundLimit) {
    throw new Error(`scheduled-orc-round-limit: round-limit class not observed (summaries: ${JSON.stringify(summaries.map((s) => ({ seq: s.seq, action: s.action, toolCalls: s.toolCalls })))})`);
  }
  if (!evidence.orcRoundLimit) {
    throw new Error(`scheduled-orc-round-limit: terminal authoring evidence missing (orcFailureCode=${evidence.orcFailureCode ?? "none"} — expected prompt_round_limit)`);
  }
  if (!evidence.runId) {
    throw new Error("scheduled-orc-round-limit: no durable scheduled run reservation");
  }
  if (evidence.terminalOutcome !== undefined) {
    throw new Error(`scheduled-orc-round-limit: run settled ${evidence.terminalOutcome} — expected the custody/round-limit observation, not a terminal row`);
  }
  if (evidence.cardId === undefined) {
    throw new Error("scheduled-orc-round-limit: scheduled run has no root project card");
  }
  if (evidence.supervisionState !== "awaiting_contract") {
    throw new Error(`scheduled-orc-round-limit: supervision ${evidence.supervisionState ?? "none"} — expected awaiting_contract (Orc died before authoring)`);
  }
}

/** #1548 Task 7 cell B: the same failure followed by a built-bridge restart. */
export async function scheduledOrcRoundLimitRestart(ctx: PiAcceptanceContext): Promise<void> {
  // Cell A intentionally leaves the round-limited project unfinished. Reuse
  // that durable run here; creating a second scheduled entry while the first
  // project is still awaiting its contract races the scheduler's Orc capacity
  // guard and produces an unrelated intent_not_actionable retry.
  enqueueToolRounds(ctx, 8);
  enqueueBootGreeting(ctx);
  enqueueHealthProbe(ctx);
  const firstAfterSeq = ctx.provider.requestCount;
  const firstStart = Date.now();
  ctx.bridge = await ctx.restartBridge();

  const firstObserved = await waitForScheduledObservation(ctx, firstAfterSeq, firstStart);
  const first = firstObserved.evidence;
  if (first.dbReadError) {
    throw new Error(`scheduled-orc-round-limit-restart: durable evidence unreadable before restart (${first.dbReadError})`);
  }
  if (!first.runId) {
    throw new Error("scheduled-orc-round-limit-restart: no durable run before restart");
  }
  if (!first.orcRoundLimit) {
    throw new Error(`scheduled-orc-round-limit-restart: terminal authoring evidence missing before restart (orcFailureCode=${first.orcFailureCode ?? "none"})`);
  }
  const beforeRestart = Date.now();

  // Second restart after the failure fact: the same durable run must recover.
  enqueueToolRounds(ctx, 8);
  enqueueBootGreeting(ctx);
  enqueueHealthProbe(ctx);
  const secondAfterSeq = ctx.provider.requestCount;
  const secondStart = Date.now();
  ctx.bridge = await ctx.restartBridge();
  const secondObserved = await waitForScheduledObservation(ctx, secondAfterSeq, secondStart);
  const postSummaries = secondObserved.summaries;
  const second = secondObserved.evidence;
  ctx.writeArtifact("scheduled-orc-round-limit-restart.json", JSON.stringify({
    beforeRestart,
    first: { runId: first.runId, cardId: first.cardId, supervisionState: first.supervisionState, orcFailureCode: first.orcFailureCode },
    second: { runId: second.runId, cardId: second.cardId, supervisionState: second.supervisionState, terminalOutcome: second.terminalOutcome, orcFailureCode: second.orcFailureCode },
    providerSummaries: postSummaries.filter(isScheduledSummary).map((s) => ({ seq: s.seq, action: s.action, toolCalls: s.toolCalls, matchedMarkers: s.matchedMarkers })),
  }, null, 2));

  if (second.dbReadError) {
    throw new Error(`scheduled-orc-round-limit-restart: durable evidence unreadable after restart (${second.dbReadError})`);
  }

  if (second.runId !== first.runId) {
    throw new Error(`scheduled-orc-round-limit-restart: run identity changed across restart (${first.runId} -> ${second.runId ?? "none"})`);
  }
  if (second.cardId !== first.cardId) {
    throw new Error(`scheduled-orc-round-limit-restart: root card changed across restart (${first.cardId} -> ${second.cardId ?? "none"})`);
  }
  if (!second.orcRoundLimit) {
    throw new Error(`scheduled-orc-round-limit-restart: terminal authoring evidence missing after restart (orcFailureCode=${second.orcFailureCode ?? "none"})`);
  }
  if (second.terminalOutcome !== undefined) {
    throw new Error(`scheduled-orc-round-limit-restart: run settled ${second.terminalOutcome} after restart — expected the recovered run without a terminal row`);
  }
  if (second.supervisionState !== "awaiting_contract") {
    throw new Error(`scheduled-orc-round-limit-restart: supervision ${second.supervisionState ?? "none"} after restart`);
  }
}
