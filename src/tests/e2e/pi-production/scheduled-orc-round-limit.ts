/**
 * scheduled-orc-round-limit.ts — #1548 Task 7: Pi production-composition
 * scheduled-project cells.
 *
 * Drives the BUILT bridge (dist/main.js) with a real scheduled project task:
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
import { FIXTURE_MODEL_A } from "./bridge-config.js";
import { waitFor } from "./child-process.js";
import type { PiAcceptanceContext } from "./scenarios.js";

export const SCHEDULED_TASK_ID = "scheduled-limit";
const SCHEDULED_GOAL = `PI-E2E-SCHEDULED ${SCHEDULED_TASK_ID}`;

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
  // Pre-seed the durable runtime state so the first boot tick admits the task
  // immediately instead of waiting for the next cron boundary.
  writeFileSync(join(home, "tasks", "task-state.json"), JSON.stringify({
    [SCHEDULED_TASK_ID]: {
      nextRunAt: Date.now() - 60_000,
      consecutiveFailures: 0,
      consecutiveDeferrals: 0,
      autoPaused: false,
    },
  }, null, 2));

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

/** Read-only evidence over the bridge home's durable files. */
function readBridgeHomeEvidence(ctx: PiAcceptanceContext, providerSummaries: ProviderSummary[]): BridgeHomeEvidence {
  const home = ctx.abtarsHome;
  const evidence: BridgeHomeEvidence = { workerCardCount: 0, providerRoundLimit: false };

  const statePath = join(home, "tasks", "task-state.json");
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, { activeRun?: { runId?: string; cardId?: number; phase?: string } }>;
    const run = state[SCHEDULED_TASK_ID]?.activeRun;
    evidence.runId = run?.runId;
    evidence.cardId = run?.cardId;
    evidence.phase = run?.phase;
  }

  const historyPath = join(home, "tasks", "task-history.jsonl");
  if (existsSync(historyPath)) {
    const rows = readFileSync(historyPath, "utf-8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l) as { taskId?: string; outcome?: string }; } catch { return null; }
    }).filter((r): r is { taskId?: string; outcome?: string } => r !== null);
    const terminal = rows.find((r) => r.taskId === SCHEDULED_TASK_ID);
    evidence.terminalOutcome = terminal?.outcome;
  }

  // Supervision + worker cards via the bridge home's kanban database.
  const dbPath = join(home, "kanban", "kanban.db");
  if (existsSync(dbPath)) {
    try {
      // better-sqlite3 is a production dependency of the built bridge; the
      // test process can open the file read-only for evidence.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require("better-sqlite3") as new (path: string, opts: { readonly: boolean }) => { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
      const db = new Database(dbPath, { readonly: true });
      try {
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
  const scheduled = providerSummaries.filter((s) => s.markerTexts.some((t) => t.includes(SCHEDULED_GOAL)));
  evidence.providerRoundLimit = scheduled.some((s) => s.action === "toolCall") && scheduled.length >= 2;

  return evidence;
}

function enqueueToolRounds(ctx: PiAcceptanceContext, count: number): void {
  for (let i = 0; i < count; i++) {
    ctx.provider.enqueue({
      candidate: FIXTURE_MODEL_A,
      expectation: undefined,
      action: { kind: "toolCall", name: "execute_bash", arguments: { command: "echo round" } },
    });
  }
}

async function waitForScheduledRequest(ctx: PiAcceptanceContext): Promise<ProviderSummary[]> {
  return waitFor(async () => {
    const summaries = ctx.provider.summariesFor(FIXTURE_MODEL_A);
    return summaries.some((s) => s.markerTexts.some((t) => t.includes(SCHEDULED_GOAL)))
      ? summaries
      : null;
  }, TIMEOUTS.runMs, `scheduled request carrying ${SCHEDULED_GOAL}`);
}

/** #1548 Task 7 cell A: Orc round-limit failure during a scheduled project. */
export async function scheduledOrcRoundLimit(ctx: PiAcceptanceContext): Promise<void> {
  installScheduledRoundLimitFixture(ctx);
  enqueueToolRounds(ctx, 8); // covers the authoring retries inside the window
  ctx.bridge = await ctx.restartBridge();

  const summaries = await waitForScheduledRequest(ctx);
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
  installScheduledRoundLimitFixture(ctx);
  enqueueToolRounds(ctx, 8);
  ctx.bridge = await ctx.restartBridge();

  const summaries = await waitForScheduledRequest(ctx);
  const first = readBridgeHomeEvidence(ctx, summaries);
  if (!first.runId) {
    throw new Error("scheduled-orc-round-limit-restart: no durable run before restart");
  }
  const beforeRestart = Date.now();

  // Second restart after the failure fact: the same durable run must recover.
  enqueueToolRounds(ctx, 8);
  ctx.bridge = await ctx.restartBridge();
  const postSummaries = await waitForScheduledRequest(ctx);
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
