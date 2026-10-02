/**
 * scheduled-orc-round-limit.ts — #1548 Task 7: Pi production-composition
 * scheduled-project cells (journey replaced under #1902).
 *
 * Drives the BUILT bridge (bundle/abtars.js) with a real scheduled project
 * task: the task is admitted through the real CronQueue/scheduled runner, and
 * its initial planning drains through the real workflow driver into
 * SpinPlannerBackend, whose S-profile model call reaches the real Pi transport
 * and the loopback scripted provider. No live provider is required.
 *
 * #1902: the planned model stimulus is a deterministic planning failure. The
 * scripted main candidate answers the scheduled goal with non-proposal text,
 * so every planning round exhausts its corrections and the runner records an
 * explicit bounded PlanRejected (plan_revision consumed, round requeued)
 * under the existing finite policy; the third rejection exhausts the budget
 * and fails the run with plan_rejected diagnostics. The cells observe that
 * failure fact, then terminal custody across a bridge restart, through current
 * workflow obligations and failure facts. The retired supervised-brain Orc
 * ledger and candidate-B tool-round scripts are gone: production routes
 * planning to the main candidate, and nothing in current production writes
 * orc_project_runs rows. Scenario names stay unchanged for matrix/JUnit
 * continuity.
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
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
/**
 * #1902: deterministic planning-failure stimulus. Proven non-proposal text
 * (the planner's parse rejects it, exactly as in the ports unit tests), so
 * each planning round consumes one plan_revision and requeues instead of
 * admitting a revision. Never valid JSON: a valid proposal would admit a
 * revision and dispatch real worker execution in the fixture.
 */
export const SCHEDULED_INVALID_PLAN = "not json at all";

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
}

interface BridgeHomeEvidence {
  runId?: string;
  cardId?: number;
  phase?: string;
  terminalOutcome?: string;
  supervisionState?: string;
  workerCardCount: number;
  /** #1902: scheduled reservations for the task (cron may reserve more than
   *  one across an observation; predicates pin the first). */
  reservationCount: number;
  /** #1902: workflow runs bound to the observed scheduled run. Exactly one:
   *  duplicate admission for the same occurrence would surface here. */
  workflowRunCount: number;
  /** #1902: workflow state of the observed run. */
  workflowState?: string;
  /** #1902: plan_revision budget allowed/consumed — the explicit failure fact. */
  planRevisionAllowed?: number;
  planRevisionConsumed?: number;
  /** #1902: admitted plan revisions (this journey must never admit one). */
  planRevisionAdmitted: number;
  /** #1902: last durable read error — never treated as proof of absence. */
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
export function readBridgeHomeEvidence(ctx: PiAcceptanceContext): BridgeHomeEvidence {
  const home = ctx.abtarsHome;
  const evidence: BridgeHomeEvidence = { workerCardCount: 0, reservationCount: 0, workflowRunCount: 0, planRevisionAdmitted: 0 };

  // #1601: durable run state now lives in the shared task database
  // (task_runs rows); the legacy task-state.json is migrated once at boot.
  // #1568: the terminal event lives in the bounded task_run_history table.
  const dbPath = join(home, "kanban", "kanban.db");
  if (!existsSync(dbPath)) {
    evidence.dbReadError = `kanban db missing at ${dbPath}`;
    return evidence;
  }
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
      // Pin the FIRST reservation: cron may reserve further occurrences
      // during an observation, and latest-row selection would flap between
      // runs. New reservations never disturb the pinned original.
      const runs = db.prepare("SELECT run_id, card_id, phase FROM task_runs WHERE task_id = ? ORDER BY reserved_at ASC").all(SCHEDULED_TASK_ID) as Array<{ run_id?: string; card_id?: number | null; phase?: string }>;
      evidence.reservationCount = runs.length;
      const run = runs[0];
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

      // #1902: current-architecture planning facts, read with plain SELECTs
      // (never a production store, which would migrate the database). A
      // missing/unreadable fact fails the cell below; it is never treated
      // as proof of an absent failure or a satisfied plan.
      if (evidence.runId) {
        try {
          const wfRuns = db.prepare(
            "SELECT run_id, state FROM workflow_runs WHERE scheduled_run_id = ?",
          ).all(evidence.runId) as Array<{ run_id: string; state: string }>;
          evidence.workflowRunCount = wfRuns.length;
          const wf = wfRuns[0];
          if (wf) {
            evidence.workflowState = wf.state;
            const budget = db.prepare(
              "SELECT allowed, consumed FROM workflow_budgets WHERE run_id = ? AND scope = 'plan_revision'",
            ).get(wf.run_id) as { allowed?: number; consumed?: number } | undefined;
            evidence.planRevisionAllowed = budget?.allowed;
            evidence.planRevisionConsumed = budget?.consumed;
            const revs = db.prepare(
              "SELECT COUNT(*) AS n FROM workflow_plan_revisions WHERE run_id = ?",
            ).get(wf.run_id) as { n: number };
            evidence.planRevisionAdmitted = Number(revs?.n ?? 0);
          }
        } catch (err) {
          evidence.dbReadError = `workflow facts unreadable: ${err instanceof Error ? err.message : String(err)}`;
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

  return evidence;
}

/** Minimal custody facts shared by the terminal-custody predicate and its tests. */
export interface PlanningCustodyFacts {
  runId?: string;
  cardId?: number;
  workflowRunCount: number;
  workflowState?: string;
  planRevisionAllowed?: number;
  planRevisionConsumed?: number;
  planRevisionAdmitted: number;
  supervisionState?: string;
}

/**
 * #1902: terminal-custody contract for the planning-failure journey. The
 * post-restart run must be the same logical job (identities unchanged,
 * exactly one workflow run for the occurrence), explicitly failed by budget
 * exhaustion (consumed == allowed, no revision ever admitted), with terminal
 * settlement projected (supervision blocked). Returns violation strings;
 * empty means custody holds. Pure so the contract is unit-tested without a
 * bridge; the cells enforce it against live evidence.
 */
export function verifyTerminalCustody(first: PlanningCustodyFacts, second: PlanningCustodyFacts): string[] {
  const violations: string[] = [];
  if (!first.runId || !second.runId || first.runId !== second.runId) {
    violations.push(`run identity changed across restart (${first.runId ?? "none"} -> ${second.runId ?? "none"})`);
  }
  if (first.cardId === undefined || second.cardId !== first.cardId) {
    violations.push(`root card changed across restart (${first.cardId ?? "none"} -> ${second.cardId ?? "none"})`);
  }
  if (second.workflowRunCount !== 1) {
    violations.push(`expected exactly one workflow run for the occurrence, found ${second.workflowRunCount}`);
  }
  if (second.workflowState !== "failed") {
    violations.push(`workflow state ${second.workflowState ?? "none"} — expected failed (plan_rejected exhaustion)`);
  }
  if (second.planRevisionAllowed === undefined || second.planRevisionConsumed === undefined ||
      second.planRevisionConsumed !== second.planRevisionAllowed) {
    violations.push(`plan_revision not exhausted (consumed=${second.planRevisionConsumed ?? "none"} allowed=${second.planRevisionAllowed ?? "none"})`);
  }
  if ((second.planRevisionConsumed ?? -1) < (first.planRevisionConsumed ?? 0)) {
    violations.push(`plan_revision consumption went backwards (${first.planRevisionConsumed ?? "none"} -> ${second.planRevisionConsumed ?? "none"})`);
  }
  if (second.planRevisionAdmitted !== 0) {
    violations.push(`plan revision admitted (${second.planRevisionAdmitted}) — this journey must never admit one`);
  }
  if (second.supervisionState !== "blocked") {
    violations.push(`supervision ${second.supervisionState ?? "none"} — expected blocked (terminal projection of the failed run)`);
  }
  return violations;
}

/** #1902: deterministic planning-failure scripts on the route production
 *  planning actually takes. S-profile planning is routed to the main
 *  candidate by the production fallback chain, so the scheduled goal is
 *  scripted there — never on B, and production routing is never changed to
 *  feed a fixture. Each script is consumed once by one goal-bearing request;
 *  exhaustion falls back to unscripted 503s, which fail the round in the same
 *  direction. Constrained to the scheduled goal so unrelated A traffic can
 *  neither consume these responses nor satisfy planning evidence. */
function enqueueInvalidPlans(ctx: PiAcceptanceContext, count: number): void {
  ctx.provider.registerMarker(SCHEDULED_GOAL);
  for (let i = 0; i < count; i++) {
    ctx.provider.enqueue({
      candidate: FIXTURE_MODEL_A,
      expectation: {
        candidate: FIXTURE_MODEL_A,
        orderedContains: [SCHEDULED_GOAL],
      },
      action: { kind: "text", chunks: [SCHEDULED_INVALID_PLAN] },
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

/** Goal-bearing requests on the production planning route after a boundary.
 *  Planning is routed to the main candidate; B traffic can never satisfy
 *  planning evidence, and unrelated A traffic cannot match the goal. */
function scheduledPlanningRequests(summaries: ProviderSummary[], afterSeq: number): ProviderSummary[] {
  return summaries.filter((s) => s.seq > afterSeq && s.candidate === FIXTURE_MODEL_A && isScheduledSummary(s));
}

/** #1902: one bounded observation budget after each restart becomes ready,
 *  covering planning attempts plus explicit failure settlement. No fresh
 *  timeout per probe. Catches the run after its first explicit PlanRejected:
 *  real planner work reached the model boundary on the production route, the
 *  finite policy recorded the failure (budget consumed), and no revision was
 *  admitted — the run is mid-redrive, not terminal. */
async function waitForPlanningFailure(
  ctx: PiAcceptanceContext,
  afterSeq: number,
): Promise<{ goalRequests: ProviderSummary[]; evidence: BridgeHomeEvidence }> {
  return waitFor(async () => {
    const goal = scheduledPlanningRequests(ctx.provider.summaries, afterSeq);
    if (goal.length < 2) return null;
    const evidence = readBridgeHomeEvidence(ctx);
    if (evidence.dbReadError) return null;
    if (!evidence.runId || evidence.cardId === undefined) return null;
    if (evidence.workflowRunCount !== 1) return null;
    if (evidence.supervisionState !== "awaiting_contract") return null;
    if (evidence.terminalOutcome !== undefined) return null;
    if ((evidence.planRevisionConsumed ?? 0) < 1) return null;
    if (evidence.planRevisionAdmitted !== 0) return null;
    return { goalRequests: goal, evidence };
  }, TIMEOUTS.scheduledObservationMs, `scheduled planning failure for ${SCHEDULED_TASK_ID} (180s budget)`, () => {
    // Bounded diagnostics for the timeout — counts and identities only.
    const goal = scheduledPlanningRequests(ctx.provider.summaries, afterSeq);
    const evidence = readBridgeHomeEvidence(ctx);
    return [
      `afterSeq=${afterSeq} aTotal=${ctx.provider.summariesFor(FIXTURE_MODEL_A).filter((s) => s.seq > afterSeq).length} matched=${goal.length}`,
      `consumed=${evidence.planRevisionConsumed ?? "none"}/${evidence.planRevisionAllowed ?? "none"} admitted=${evidence.planRevisionAdmitted}`,
      `runId=${evidence.runId ?? "none"} cardId=${evidence.cardId ?? "none"} wfRuns=${evidence.workflowRunCount} wfState=${evidence.workflowState ?? "none"}`,
      `supervision=${evidence.supervisionState ?? "none"} terminal=${evidence.terminalOutcome ?? "none"}`,
      `dbError=${evidence.dbReadError ?? "none"}`,
    ].join(" ");
  });
}

/** #1902: terminal wait before the custody restart. Polls until the observed
 *  run fails by budget exhaustion. No restart is involved, so no claim-lease
 *  race can delay settlement past the bound: rounds settle every few seconds
 *  on the live bridge. */
async function waitForTerminalFailure(ctx: PiAcceptanceContext): Promise<BridgeHomeEvidence> {
  return waitFor(async () => {
    const evidence = readBridgeHomeEvidence(ctx);
    if (evidence.dbReadError) return null;
    if (!evidence.runId || evidence.cardId === undefined) return null;
    if (evidence.workflowRunCount !== 1) return null;
    if (evidence.workflowState !== "failed") return null;
    if (evidence.planRevisionConsumed === undefined || evidence.planRevisionAllowed === undefined ||
        evidence.planRevisionConsumed !== evidence.planRevisionAllowed) return null;
    if (evidence.planRevisionAdmitted !== 0) return null;
    if (evidence.supervisionState !== "blocked") return null;
    return evidence;
  }, TIMEOUTS.scheduledObservationMs, `scheduled terminal planning failure for ${SCHEDULED_TASK_ID} (180s budget)`, () => {
    const evidence = readBridgeHomeEvidence(ctx);
    return [
      `consumed=${evidence.planRevisionConsumed ?? "none"}/${evidence.planRevisionAllowed ?? "none"} admitted=${evidence.planRevisionAdmitted}`,
      `runId=${evidence.runId ?? "none"} wfRuns=${evidence.workflowRunCount} wfState=${evidence.workflowState ?? "none"}`,
      `supervision=${evidence.supervisionState ?? "none"} terminal=${evidence.terminalOutcome ?? "none"}`,
      `dbError=${evidence.dbReadError ?? "none"}`,
    ].join(" ");
  });
}

/** #1548 Task 7 cell A (#1902 journey): explicit planning failure during a
 *  scheduled project. The deterministic invalid stimulus makes the first
 *  planning round exhaust its corrections; the cell observes real planner
 *  work on the production route plus the explicit bounded failure fact. */
export async function scheduledOrcRoundLimit(ctx: PiAcceptanceContext): Promise<void> {
  installScheduledRoundLimitFixture(ctx);
  enqueueInvalidPlans(ctx, 32); // several rounds of corrections plus restart redrive
  enqueueBootGreeting(ctx);
  enqueueHealthProbe(ctx);
  const afterSeq = ctx.provider.requestCount;
  ctx.bridge = await ctx.restartBridge();

  const observed = await waitForPlanningFailure(ctx, afterSeq);
  const goalRequests = observed.goalRequests;
  const evidence = observed.evidence;
  // Bounded match evidence only — sequence/action/candidate identities, never
  // complete request text or expanded previews.
  ctx.writeArtifact("scheduled-orc-round-limit.json", JSON.stringify({
    evidence: {
      runId: evidence.runId,
      cardId: evidence.cardId,
      supervisionState: evidence.supervisionState,
      terminalOutcome: evidence.terminalOutcome,
      workflowRunCount: evidence.workflowRunCount,
      workflowState: evidence.workflowState,
      planRevisionAllowed: evidence.planRevisionAllowed,
      planRevisionConsumed: evidence.planRevisionConsumed,
      planRevisionAdmitted: evidence.planRevisionAdmitted,
      reservationCount: evidence.reservationCount,
    },
    planningRequests: goalRequests.map((s) => ({ seq: s.seq, action: s.action, candidate: s.candidate })),
  }, null, 2));

  if (evidence.dbReadError) {
    throw new Error(`scheduled-orc-round-limit: durable evidence unreadable (${evidence.dbReadError})`);
  }
  if (goalRequests.length < 2) {
    throw new Error(`scheduled-orc-round-limit: no real planner work reached the model boundary (goal requests: ${goalRequests.length})`);
  }
  if (!evidence.runId) {
    throw new Error("scheduled-orc-round-limit: no durable scheduled run reservation");
  }
  if (evidence.workflowRunCount !== 1) {
    throw new Error(`scheduled-orc-round-limit: expected exactly one workflow run for the occurrence, found ${evidence.workflowRunCount}`);
  }
  if (evidence.terminalOutcome !== undefined) {
    throw new Error(`scheduled-orc-round-limit: run settled ${evidence.terminalOutcome} — expected the mid-redrive failure fact, not a terminal row`);
  }
  if (evidence.cardId === undefined) {
    throw new Error("scheduled-orc-round-limit: scheduled run has no root project card");
  }
  if (evidence.supervisionState !== "awaiting_contract") {
    throw new Error(`scheduled-orc-round-limit: supervision ${evidence.supervisionState ?? "none"} — expected awaiting_contract (no plan admitted yet)`);
  }
  if ((evidence.planRevisionConsumed ?? 0) < 1) {
    throw new Error("scheduled-orc-round-limit: no explicit planning failure recorded (plan_revision unconsumed)");
  }
  if (evidence.planRevisionAdmitted !== 0) {
    throw new Error(`scheduled-orc-round-limit: plan revision admitted (${evidence.planRevisionAdmitted}) — this journey must fail before custody`);
  }
}

/** #1548 Task 7 cell B (#1902 journey): terminal custody across a restart.
 *  The run is driven to explicit terminal failure first; only then does the
 *  bridge restart. A restart can strand an in-flight planning round behind
 *  its 5-minute claim lease, so custody of a live redrive is not observable
 *  within a bounded window — terminal custody is: the same logical job,
 *  explicitly failed, never resurrected or duplicated. */
export async function scheduledOrcRoundLimitRestart(ctx: PiAcceptanceContext): Promise<void> {
  enqueueInvalidPlans(ctx, 32);
  enqueueBootGreeting(ctx);
  enqueueHealthProbe(ctx);
  ctx.bridge = await ctx.restartBridge();

  // Settle to terminal BEFORE the custody restart (no lease race: rounds
  // settle every few seconds on the live bridge).
  const terminal = await waitForTerminalFailure(ctx);
  if (terminal.dbReadError) {
    throw new Error(`scheduled-orc-round-limit-restart: durable evidence unreadable before restart (${terminal.dbReadError})`);
  }
  const beforeRestart = Date.now();

  enqueueInvalidPlans(ctx, 32);
  enqueueBootGreeting(ctx);
  enqueueHealthProbe(ctx);
  ctx.bridge = await ctx.restartBridge();
  // Immediate state read: terminal facts are monotonic (nothing post-restart
  // can un-fail the run or un-consume the budget), so no wait is needed and
  // no claim-lease race applies.
  const second = readBridgeHomeEvidence(ctx);
  ctx.writeArtifact("scheduled-orc-round-limit-restart.json", JSON.stringify({
    beforeRestart,
    first: {
      runId: terminal.runId, cardId: terminal.cardId, supervisionState: terminal.supervisionState,
      terminalOutcome: terminal.terminalOutcome, workflowState: terminal.workflowState,
      planRevisionAllowed: terminal.planRevisionAllowed, planRevisionConsumed: terminal.planRevisionConsumed,
      planRevisionAdmitted: terminal.planRevisionAdmitted, workflowRunCount: terminal.workflowRunCount,
      reservationCount: terminal.reservationCount,
    },
    second: {
      runId: second.runId, cardId: second.cardId, supervisionState: second.supervisionState,
      terminalOutcome: second.terminalOutcome, workflowState: second.workflowState,
      planRevisionAllowed: second.planRevisionAllowed, planRevisionConsumed: second.planRevisionConsumed,
      planRevisionAdmitted: second.planRevisionAdmitted, workflowRunCount: second.workflowRunCount,
      reservationCount: second.reservationCount,
    },
  }, null, 2));

  if (second.dbReadError) {
    throw new Error(`scheduled-orc-round-limit-restart: durable evidence unreadable after restart (${second.dbReadError})`);
  }
  const violations = verifyTerminalCustody(terminal, second);
  if (violations.length > 0) {
    throw new Error(`scheduled-orc-round-limit-restart: terminal custody broken across restart: ${violations.join("; ")}`);
  }
}
