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
import { FIXTURE_MODEL_B } from "./bridge-config.js";
import { waitFor } from "./child-process.js";
import type { PiAcceptanceContext } from "./scenarios.js";
import { resolveNativeDep } from "../../../utils/lazy-require.js";
import { getRunFromDatabase } from "../../../components/tasks/task-history-store.js";
import { wrapTaskDatabase } from "../../../components/tasks/kanban-board.js";

export const SCHEDULED_TASK_ID = "scheduled-limit";
const SCHEDULED_GOAL = `PI-E2E-SCHEDULED ${SCHEDULED_TASK_ID}`;
const SCHEDULED_PROJECT_MARKER = "[SCHEDULED TASK PROJECT —";

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
}

function isScheduledSummary(summary: ProviderSummary): boolean {
  // The task goal is appended after the provider fixture's bounded marker-text
  // window, but the production Orc header is present near the beginning of
  // the request. The caller scopes summaries to the current restart before
  // using this predicate.
  return summary.markerTexts.some((t) => t.includes(SCHEDULED_PROJECT_MARKER) || t.includes(SCHEDULED_GOAL));
}

/** Read-only evidence over the bridge home's durable files. */
function readBridgeHomeEvidence(ctx: PiAcceptanceContext, providerSummaries: ProviderSummary[]): BridgeHomeEvidence {
  const home = ctx.abtarsHome;
  const evidence: BridgeHomeEvidence = { workerCardCount: 0, providerRoundLimit: false };

  // #1601: durable run state now lives in the shared task database
  // (task_runs rows); the legacy task-state.json is migrated once at boot.
  // #1568: the terminal event lives in the bounded task_run_history table.
  const dbPath = join(home, "kanban", "kanban.db");
  if (existsSync(dbPath)) {
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
        }
      } finally {
        (db as unknown as { close(): void }).close();
      }
    } catch {
      // db unavailable in the test process — provider evidence still stands
    }
  }

  // Round-limit class: the scheduled request stream saw two toolCall rounds.
  const scheduled = providerSummaries.filter(isScheduledSummary);
  evidence.providerRoundLimit = scheduled.some((s) => s.action === "toolCall") && scheduled.length >= 2;

  return evidence;
}

function enqueueToolRounds(ctx: PiAcceptanceContext, count: number): void {
  for (let i = 0; i < count; i++) {
    ctx.provider.enqueue({
      // Scheduled project authoring uses the production O session profile,
      // whose agent is browsie. In this fixture that role resolves to the
      // fallback candidate B; queue the responses on the route the real Orc
      // request actually takes rather than changing production routing.
      candidate: FIXTURE_MODEL_B,
      expectation: undefined,
      action: { kind: "toolCall", name: "execute_bash", arguments: { command: "echo round" } },
    });
  }
}

async function waitForScheduledRequest(ctx: PiAcceptanceContext, afterSeq: number): Promise<ProviderSummary[]> {
  return waitFor(async () => {
    const summaries = ctx.provider.summariesFor(FIXTURE_MODEL_B).filter((s) => s.seq > afterSeq);
    return summaries.filter(isScheduledSummary).length >= 2
      ? summaries
      : null;
  }, TIMEOUTS.runMs, `scheduled Orc tool rounds for ${SCHEDULED_TASK_ID}`);
}

/** #1548 Task 7 cell A: Orc round-limit failure during a scheduled project. */
export async function scheduledOrcRoundLimit(ctx: PiAcceptanceContext): Promise<void> {
  installScheduledRoundLimitFixture(ctx);
  enqueueToolRounds(ctx, 8); // covers the authoring retries inside the window
  const afterSeq = ctx.provider.requestCount;
  ctx.bridge = await ctx.restartBridge();

  const summaries = await waitForScheduledRequest(ctx, afterSeq);
  const evidence = readBridgeHomeEvidence(ctx, summaries);
  ctx.writeArtifact("scheduled-orc-round-limit.json", JSON.stringify({ evidence, providerSummaries: summaries.map((s) => ({ seq: s.seq, action: s.action, toolCalls: s.toolCalls, markerTexts: s.markerTexts.slice(0, 2) })) }, null, 2));

  if (!evidence.providerRoundLimit) {
    throw new Error(`scheduled-orc-round-limit: round-limit class not observed (summaries: ${JSON.stringify(summaries.map((s) => ({ seq: s.seq, action: s.action, toolCalls: s.toolCalls })))})`);
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
  const firstAfterSeq = ctx.provider.requestCount;
  ctx.bridge = await ctx.restartBridge();

  const summaries = await waitForScheduledRequest(ctx, firstAfterSeq);
  const first = readBridgeHomeEvidence(ctx, summaries);
  if (!first.runId) {
    throw new Error("scheduled-orc-round-limit-restart: no durable run before restart");
  }
  const beforeRestart = Date.now();

  // Second restart after the failure fact: the same durable run must recover.
  enqueueToolRounds(ctx, 8);
  const secondAfterSeq = ctx.provider.requestCount;
  ctx.bridge = await ctx.restartBridge();
  const postSummaries = await waitForScheduledRequest(ctx, secondAfterSeq);
  const second = readBridgeHomeEvidence(ctx, postSummaries);
  ctx.writeArtifact("scheduled-orc-round-limit-restart.json", JSON.stringify({
    beforeRestart,
    first: { runId: first.runId, cardId: first.cardId, supervisionState: first.supervisionState },
    second: { runId: second.runId, cardId: second.cardId, supervisionState: second.supervisionState, terminalOutcome: second.terminalOutcome },
    providerSummaries: postSummaries.map((s) => ({ seq: s.seq, action: s.action, toolCalls: s.toolCalls })),
  }, null, 2));

  if (second.runId !== first.runId) {
    throw new Error(`scheduled-orc-round-limit-restart: run identity changed across restart (${first.runId} -> ${second.runId ?? "none"})`);
  }
  if (second.terminalOutcome !== undefined) {
    throw new Error(`scheduled-orc-round-limit-restart: run settled ${second.terminalOutcome} after restart — expected the recovered run without a terminal row`);
  }
  if (second.supervisionState !== "awaiting_contract") {
    throw new Error(`scheduled-orc-round-limit-restart: supervision ${second.supervisionState ?? "none"} after restart`);
  }
}
