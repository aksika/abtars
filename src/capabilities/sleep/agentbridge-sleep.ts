#!/usr/bin/env node
/**
 * agentbridge-sleep — CLI entry point for overnight memory maintenance.
 *
 * Thin orchestrator: gathers system state, builds a comprehensive prompt,
 * invokes a powerful subagent (Opus 4.6 preferred) to perform all intelligent
 * maintenance, logs the audit trail, and exits.
 *
 * Usage:
 *   agentbridge sleep [--dry-run] [--verbose] [--force]
 *
 * Flags:
 *   --dry-run   Gather state and build prompt, print to stdout, skip subagent
 *   --verbose   Enable detailed logging at each orchestration step
 *   --force     Run housekeeping even if no messages since last sleep
 *
 * Exit codes:
 *   0  Success
 *   1  Fatal error
 */

import { localISO } from "../../utils/local-time.js";
import { join, basename } from "node:path";
import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { MemoryManager } from "abmind/memory-manager.js";
import { loadMemoryConfig } from "abmind/memory-config.js";
import { SleepStateGatherer } from "abmind/sleep-state-gatherer.js";
import { loadSleepSteps, buildSleepVars, substituteVars } from "abmind/sleep-pipeline.js";
import { buildDailySummary, writeDailyFile } from "abmind/sleep-pipeline.js";
import { extractFromDaily } from "abmind/sleep-pipeline.js";
import { logInfo, logWarn, logError, setLogLevel } from "../../components/logger.js";
import type { StateSnapshot } from "abmind/sleep-state-gatherer.js";
import { localDate } from "../../components/env-utils.js";
import type { SleepStep } from "abmind/sleep-pipeline.js";

const TAG = "agentbridge-sleep";

const ESSENTIAL_STEPS = new Set(["04a-daily-summary", "04b-extract-from-daily", "retrospective", "retro-extract"]);
const CATCHUP_MAX_AGE_DAYS = 3;

// ── Argument parsing ────────────────────────────────────────────────────────

export type RawArgs = { dryRun: boolean; verbose: boolean; force: boolean };

export function parseArgs(argv: string[]): RawArgs {
  const args = argv.slice(2);
  const parsed: RawArgs = { dryRun: false, verbose: false, force: false };

  for (const arg of args) {
    switch (arg) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--force":
        parsed.force = true;
        break;
    }
  }

  return parsed;
}

// ── Audit trail types ───────────────────────────────────────────────────────

export interface AuditLogEntry {
  timestamp: string;
  model: string;
  stateSnapshotSummary: string;
  subagentResponse: string;
  outcomes: {
    filesConsolidated: number;
    messagesPruned: number;
    embeddingsRemoved: number;
    sessionsCleaned: number;
    topicsMerged: number;
    topicsDeleted: number;
  };
  error?: string;
}

// ── Subagent invocation ─────────────────────────────────────────────────────

/**
 * Invoke the subagent with the sleep prompt.
 *
 * Uses the MemoryManager's LLM callback (wired via transport in main.ts)
 * when available. For standalone CLI usage, initializes its own transport.
 *
 * The subagent is granted AgentBridge tools access through the transport's
 * session mechanism — the Kiro CLI agent has full tool access.
 */
/** Create a SubagentRuntime for sleep — cached, uses transport.json config. */

// ── State file types ────────────────────────────────────────────────────────

type StepStatus = "ok" | "failed" | "skipped" | "pending" | "timeout";
type StepResult = { status: StepStatus; duration?: number; attempts?: number; ctxBefore?: number; ctxAfter?: number };
type WiredResults = { purged: number; deduped: number; embedded: number; anomaliesFixed: number; walOk: boolean; ftsOk: boolean; logsDeleted: number };
type SleepStatus = "ongoing" | "completed" | "suspended" | "failed";
type SleepState = { status: SleepStatus; pid: number; startedAt: number; llmCalls: number; wiredResults?: WiredResults; steps: Record<string, StepResult> };

const SLEEP_TIMEOUT_MS = (parseInt(process.env["SLEEP_TIMEOUT_MIN"] ?? "", 10) || 55) * 60 * 1000; // default 55 minutes
const SLEEP_MAX_LLM_CALLS = parseInt(process.env["SLEEP_MAX_LLM_CALLS"] ?? "", 10) || 15;

// getPrimaryUserId moved to SleepDataAccess in memory package

function readStateFile(path: string): SleepState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null || !raw.steps) return null;
    // Backfill defaults for legacy lock files
    if (!raw.status) raw.status = "ongoing";
    if (raw.llmCalls == null) raw.llmCalls = 0;
    return raw as SleepState;
  } catch { return null; }
}

function writeStateFile(path: string, state: SleepState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ── Wired pre-tasks (delegated to abmind MaintenanceService) ────────────────

async function runWiredPreTasks(sleepData: import("abmind/sleep-data-access.js").SleepDataAccess, memoryDir: string, memory: MemoryManager): Promise<WiredResults> {
  const r = await memory.maintenance.runPreSleepTasks(memory, sleepData);

  // Bridge-side: log rotation (not memory's concern)
  let logsDeleted = 0;
  try {
    const logsDir = join(memoryDir, "..", "logs");
    if (existsSync(logsDir)) {
      const cutoff = Date.now() - 7 * 86400000;
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith("bridge-") || !f.endsWith(".log")) continue;
        const match = f.match(/bridge-(\d{4}-\d{2}-\d{2})\.log/);
        if (match && new Date(match[1]!).getTime() < cutoff) {
          unlinkSync(join(logsDir, f));
          logsDeleted++;
        }
      }
    }
  } catch (err) { logWarn(TAG, `[WIRED] log rotation: ${err instanceof Error ? err.message : String(err)}`); }

  return { purged: r.purged, deduped: r.deduped, embedded: r.embedded, anomaliesFixed: r.anomaliesFixed, walOk: r.walOk, ftsOk: r.ftsOk, logsDeleted };
}


function formatWiredResults(r: WiredResults): string {
  const parts: string[] = [];
  if (r.purged > 0) parts.push(`${r.purged} garbage purged`);
  if (r.deduped > 0) parts.push(`${r.deduped} dupes deleted`);
  parts.push(`WAL ${r.walOk ? "ok" : "FAILED"}`);
  parts.push(`FTS ${r.ftsOk ? "ok" : "FAILED"}`);
  if (r.embedded > 0) parts.push(`${r.embedded} embedded`);
  if (r.anomaliesFixed > 0) parts.push(`${r.anomaliesFixed} anomalies fixed`);
  if (r.logsDeleted > 0) parts.push(`${r.logsDeleted} old logs deleted`);
  return parts.length > 0 ? parts.join(", ") : "nothing to do";
}

// ── Transport ───────────────────────────────────────────────────────────────

import { SubagentRuntime } from "../../components/subagent-runtime.js";

let sleepRuntime: SubagentRuntime | null = null;

function getSleepRuntime(): SubagentRuntime {
  if (!sleepRuntime) sleepRuntime = new SubagentRuntime();
  return sleepRuntime;
}

const MAX_RETRIES = 3;

/** Budget tracker — shared across all sendWithRetry calls in a sleep cycle. */
class LlmBudget {
  private state: SleepState;
  private readonly statePath: string;
  exhausted = false;

  constructor(state: SleepState, statePath: string) {
    this.state = state;
    this.statePath = statePath;
  }

  /** Increment counter, return false if budget exhausted. */
  consume(): boolean {
    this.state.llmCalls = (this.state.llmCalls ?? 0) + 1;
    writeStateFile(this.statePath, this.state);
    if (this.state.llmCalls > SLEEP_MAX_LLM_CALLS) {
      this.exhausted = true;
      return false;
    }
    return true;
  }

  get calls(): number { return this.state.llmCalls ?? 0; }
}

async function sendWithRetry(
  _transport: import("../../components/transport/kiro-transport.js").IKiroTransport | null,
  prompt: string,
  stepName: string,
  _verbose: boolean,
  budget?: LlmBudget,
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (budget && !budget.consume()) {
      logWarn(TAG, `[BUDGET] LLM call limit (${SLEEP_MAX_LLM_CALLS}) reached at step ${stepName} — suspending`);
      return null;
    }
    try {
      return await getSleepRuntime().complete("dreamy", prompt, { session: "reuse" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Step ${stepName} attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
      if (attempt === MAX_RETRIES) {
        logError(TAG, `Step ${stepName} failed after ${MAX_RETRIES} attempts, skipping`);
        return null;
      }
    }
  }
  return null;
}


// ── Audit trail helpers ─────────────────────────────────────────────────────

export function buildSnapshotSummary(snapshot: StateSnapshot): string {
  return [
    `Working dirs: ${snapshot.workingDirs.length}`,
    `Messages: ${snapshot.dbStats.messageCount}`,
    `Embeddings: ${snapshot.dbStats.embeddingCount}`,
    `Extracted memories: ${snapshot.dbStats.extractedMemoryCount}`,
    `Disk: ${(snapshot.diskUsageBytes / 1024 / 1024).toFixed(1)} MB / ${(snapshot.diskBudgetBytes / 1024 / 1024).toFixed(0)} MB`,
    `Topics: ${snapshot.topicFiles.length}`,
    `FTS5: messages=${snapshot.fts5Health.messages_fts}, extracted=${snapshot.fts5Health.extracted_memories_fts}, original=${snapshot.fts5Health.extracted_memories_original_fts}`,
  ].join(", ");
}

/**
 * Parse outcome counts from the subagent's free-form text response.
 *
 * The subagent response is unstructured text, so we use best-effort regex
 * matching for common patterns like "consolidated 3 files", "pruned 42
 * messages", etc. Returns 0 for any count that can't be parsed.
 */
export function parseOutcomesFromResponse(response: string): AuditLogEntry["outcomes"] {
  const defaults: AuditLogEntry["outcomes"] = {
    filesConsolidated: 0,
    messagesPruned: 0,
    embeddingsRemoved: 0,
    sessionsCleaned: 0,
    topicsMerged: 0,
    topicsDeleted: 0,
  };

  if (!response) return defaults;

  const text = response.toLowerCase();

  // Each pattern array contains regexes to try in order for a given outcome.
  // We take the first match found. Patterns cover both "verb N noun" and
  // "N noun verb" orderings that an LLM might produce.
  const patterns: Array<{
    key: keyof typeof defaults;
    regexes: RegExp[];
  }> = [
    {
      key: "filesConsolidated",
      regexes: [
        /consolidat\w*\s+(\d+)\s+(?:file|dir|working)/i,
        /(\d+)\s+(?:file|dir|working\s*dir)\w*\s+consolidat/i,
        /files?\s+consolidated\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "messagesPruned",
      regexes: [
        /prun\w*\s+(\d+)\s+message/i,
        /(\d+)\s+message\w*\s+prun/i,
        /(?:delet|remov)\w*\s+(\d+)\s+message/i,
        /(\d+)\s+message\w*\s+(?:delet|remov)/i,
        /messages?\s+pruned\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "embeddingsRemoved",
      regexes: [
        /(?:remov|delet|clean)\w*\s+(\d+)\s+embedding/i,
        /(\d+)\s+embedding\w*\s+(?:remov|delet|clean)/i,
        /embeddings?\s+removed\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "sessionsCleaned",
      regexes: [
        /(?:clean|delet|remov)\w*\s+(\d+)\s+session/i,
        /(\d+)\s+session\w*\s+(?:clean|delet|remov)/i,
        /sessions?\s+cleaned\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "topicsMerged",
      regexes: [
        /merg\w*\s+(\d+)\s+topic/i,
        /(\d+)\s+topic\w*\s+merg/i,
        /topics?\s+merged\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "topicsDeleted",
      regexes: [
        /delet\w*\s+(\d+)\s+topic/i,
        /(\d+)\s+topic\w*\s+delet/i,
        /topics?\s+deleted\s*:\s*(\d+)/i,
      ],
    },
  ];

  for (const { key, regexes } of patterns) {
    for (const regex of regexes) {
      const match = text.match(regex);
      if (match?.[1]) {
        const parsed = parseInt(match[1], 10);
        if (!isNaN(parsed) && parsed >= 0) {
          defaults[key] = parsed;
          break;
        }
      }
    }
  }

  return defaults;
}

export function writeAuditLog(
  memoryDir: string,
  entry: AuditLogEntry,
): void {
  const sleepDir = join(memoryDir, "sleep");
  mkdirSync(sleepDir, { recursive: true });

  const suffix = [
    ``,
    `---`,
    ``,
    `## CLI Wrapper`,
    ``,
    `**Timestamp:** ${entry.timestamp}`,
    `**Model:** ${entry.model}`,
    ``,
    `### State Snapshot`,
    `${entry.stateSnapshotSummary}`,
    ``,
    `### Outcomes`,
    `- Files consolidated: ${entry.outcomes.filesConsolidated}`,
    `- Messages pruned: ${entry.outcomes.messagesPruned}`,
    `- Embeddings removed: ${entry.outcomes.embeddingsRemoved}`,
    `- Sessions cleaned: ${entry.outcomes.sessionsCleaned}`,
    `- Topics merged: ${entry.outcomes.topicsMerged}`,
    `- Topics deleted: ${entry.outcomes.topicsDeleted}`,
    entry.error ? `\n### Error\n${entry.error}` : "",
  ].join("\n");

  // Find the subagent's audit file and append to it
  const today = localDate().replace(/-/g, "");
  try {
    const files = readdirSync(sleepDir)
      .filter(f => f.startsWith(`sleep_${today}`) && f.endsWith(".md"))
      .sort();
    if (files.length > 0) {
      const target = join(sleepDir, files[files.length - 1]!);
      const existingLines = readFileSync(target, "utf-8").split("\n").length;
      if (existingLines < 50) {
        logWarn(TAG, `Sleep audit suspiciously short (${existingLines} lines) — subagent may have truncated`);
      }
      appendFileSync(target, suffix, "utf-8");
      return;
    }
  } catch { /* fall through to standalone */ }

  // Fallback: no subagent file found — write standalone
  const now = new Date();
  const dateStr = localDate().replace(/-/g, "");
  const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, "");
  const filename = `sleep_${dateStr}_${timeStr}.md`;
  writeFileSync(join(sleepDir, filename), `# Sleep Audit Log${suffix}`, "utf-8");
}

// ── Catch-up for previous days ──────────────────────────────────────────────

interface PreviousLock {
  path: string;
  dateStr: string; // YYYYMMDD
  state: SleepState;
  ageDays: number;
}

function scanPreviousLocks(sleepDir: string, todayStr: string): PreviousLock[] {
  if (!existsSync(sleepDir)) return [];
  const locks: PreviousLock[] = [];
  const todayMs = dateStrToMs(todayStr);
  for (const f of readdirSync(sleepDir)) {
    const m = f.match(/^sleep_(\d{8})\.lock$/);
    if (!m || m[1] === todayStr) continue;
    const state = readStateFile(join(sleepDir, f));
    if (!state) continue;
    const ageDays = Math.round((todayMs - dateStrToMs(m[1]!)) / 86400000);
    if (ageDays > 0) locks.push({ path: join(sleepDir, f), dateStr: m[1]!, state, ageDays });
  }
  return locks.sort((a, b) => b.dateStr.localeCompare(a.dateStr)); // newest first
}

function dateStrToMs(ds: string): number {
  return new Date(`${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}T00:00:00`).getTime();
}

function dateStrToFormatted(ds: string): string {
  return `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
}

function failedEssentials(state: SleepState): string[] {
  const failed: string[] = [];
  for (const name of ESSENTIAL_STEPS) {
    const s = state.steps[name];
    if (!s || s.status === "failed" || s.status === "timeout" || s.status === "pending") {
      failed.push(name);
    }
  }
  return failed;
}

async function runCatchUp(
  locks: PreviousLock[],
  sleepData: import("abmind/sleep-data-access.js").SleepDataAccess,
  memoryConfig: { memoryDir: string },
  steps: SleepStep[],
  flags: RawArgs,
  budget?: LlmBudget,
): Promise<void> {
  for (const lock of locks) {
    if (lock.ageDays > CATCHUP_MAX_AGE_DAYS) {
      logError(TAG, `[CATCH-UP] Abandoning stale lock ${basename(lock.path)} — ${lock.ageDays} days old, data unrecoverable`);
      unlinkSync(lock.path);
      continue;
    }

    const needed = failedEssentials(lock.state);
    if (needed.length === 0) {
      logInfo(TAG, `[CATCH-UP] Cleaning up completed lock ${basename(lock.path)}`);
      unlinkSync(lock.path);
      continue;
    }

    logInfo(TAG, `[CATCH-UP] ${basename(lock.path)} — recovering: ${needed.join(", ")}`);

    // 04a — daily summary with date-range
    if (needed.includes("04a-daily-summary")) {
      const start = Date.now();
      try {
        const ctxWindow = parseInt(process.env["AGENT_SLEEP_CTX_WINDOW"] ?? "128000", 10);
        const userId = sleepData.getPrimaryUserId();
        const dayStart = dateStrToMs(lock.dateStr);
        const dayEnd = dayStart + 86400000;
        const summary = await buildDailySummary(sleepData.getDb(), (p) => sendWithRetry(null, p, "catch-up-04a", flags.verbose, budget).then(r => r ?? ""), {
          ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs: 0,
          dateRange: { startTs: dayStart, endTs: dayEnd },
        });
        if (summary) {
          writeDailyFile(memoryConfig.memoryDir, dateStrToFormatted(lock.dateStr), summary);
          lock.state.steps["04a-daily-summary"] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
        } else {
          lock.state.steps["04a-daily-summary"] = { status: "skipped" };
        }
        logInfo(TAG, `[CATCH-UP] ✓ 04a-daily-summary for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      } catch (err) {
        logWarn(TAG, `[CATCH-UP] ✗ 04a-daily-summary for ${lock.dateStr}: ${err instanceof Error ? err.message : String(err)}`);
        lock.state.steps["04a-daily-summary"] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
      }
      writeStateFile(lock.path, lock.state);
    }

    // 04b — extract from daily (needs daily file to exist)
    if (needed.includes("04b-extract-from-daily")) {
      const dailyPath = join(memoryConfig.memoryDir, "daily", `daily_${dateStrToFormatted(lock.dateStr)}.md`);
      if (!existsSync(dailyPath)) {
        logInfo(TAG, `[CATCH-UP] ⏭ 04b — no daily file for ${lock.dateStr}`);
        lock.state.steps["04b-extract-from-daily"] = { status: "skipped" };
      } else {
        const start = Date.now();
        try {
          const userId = sleepData.getPrimaryUserId();
          const result = await extractFromDaily(dailyPath, userId, (p) => sendWithRetry(null, p, "catch-up-04b", flags.verbose, budget).then(r => r ?? ""));
          lock.state.steps["04b-extract-from-daily"] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
          logInfo(TAG, `[CATCH-UP] ✓ 04b-extract-from-daily for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
        } catch (err) {
          logWarn(TAG, `[CATCH-UP] ✗ 04b for ${lock.dateStr}: ${err instanceof Error ? err.message : String(err)}`);
          lock.state.steps["04b-extract-from-daily"] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
        }
      }
      writeStateFile(lock.path, lock.state);
    }

    // Prompt-driven essentials (retrospective, retro-extract)
    for (const stepName of ["retrospective", "retro-extract"] as const) {
      if (!needed.includes(stepName)) continue;
      const step = steps.find(s => s.name === stepName);
      if (!step) { logWarn(TAG, `[CATCH-UP] Step file not found: ${stepName}`); continue; }
      const start = Date.now();
      const response = await sendWithRetry(null, step.rawPrompt, `catch-up-${stepName}`, flags.verbose, budget);
      if (response) {
        lock.state.steps[stepName] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
        logInfo(TAG, `[CATCH-UP] ✓ ${stepName} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      } else {
        lock.state.steps[stepName] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
        logWarn(TAG, `[CATCH-UP] ✗ ${stepName}`);
      }
      writeStateFile(lock.path, lock.state);
    }

    // Final check: all essentials recovered?
    const stillFailing = failedEssentials(lock.state);
    if (stillFailing.length === 0) {
      logInfo(TAG, `[CATCH-UP] ✅ ${basename(lock.path)} — all essentials recovered, lock deleted`);
      unlinkSync(lock.path);
    } else {
      logWarn(TAG, `[CATCH-UP] ${basename(lock.path)} — still failing: ${stillFailing.join(", ")} (failing ${lock.ageDays} day(s))`);
    }
  }
}

// ── Main orchestration ──────────────────────────────────────────────────────

async function main(): Promise<number> {
  const flags = parseArgs(process.argv);

  if (flags.verbose) {
    setLogLevel("debug");
    logInfo(TAG, "Verbose mode enabled");
  }

  const memoryConfig = loadMemoryConfig();
  const memory = new MemoryManager(memoryConfig);

  try {
    await memory.initialize();
  } catch (err) {
    process.stderr.write(`Fatal: Failed to initialize MemoryManager — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    const sleepData = memory.getSleepData();

    // State file path
    const dateStr = localDate().replace(/-/g, "");
    const statePath = join(memoryConfig.memoryDir, "sleep", `sleep_${dateStr}.lock`);
    const existingState = readStateFile(statePath);
    const isResume = existingState !== null && Object.values(existingState.steps).some(s => s.status === "ok");

    // Gather state
    let cronFn: (() => string | null) | undefined;
    try { const { readEntries } = await import("../../components/cron/cron-db.js"); cronFn = () => { try { return JSON.stringify(readEntries()); } catch { return null; } }; } catch { /* cron not available */ }
    const gatherer = new SleepStateGatherer(memory, memoryConfig, cronFn);
    const snapshot = await gatherer.gather();
    if (flags.verbose) logInfo(TAG, `State gathered: ${buildSnapshotSummary(snapshot)}`);

    // Guardrail: skip if no messages since last sleep (unless --force or resuming)
    const msgCount = snapshot.dbStats.messagesSinceLastSleep;
    if (msgCount === 0 && !flags.force && !isResume) {
      logInfo(TAG, `[SLEEP] No messages since last sleep — nothing to process. Use --force to run housekeeping anyway.`);
      return 0;
    }

    // Wired pre-tasks (always run — fast, idempotent)
    logInfo(TAG, `[SLEEP] Running wired pre-tasks${isResume ? " (resume)" : ""}...`);
    const wiredResults = await runWiredPreTasks(sleepData, memoryConfig.memoryDir, memory);
    logInfo(TAG, `[SLEEP] Wired: ${formatWiredResults(wiredResults)}`);

    // Build candidate lists for conditional prompts
    const candidates = sleepData.buildSleepCandidates();
    logInfo(TAG, `[SLEEP] Candidates: topics=${candidates.untaggedMemories ? "yes" : "none"}, promote=${candidates.promotionCandidates ? "yes" : "none"}, contradict=${candidates.contradictions ? "yes" : "none"}, merge=${candidates.mergeCandidates ? "yes" : "none"}, translate=${candidates.translationIssues ? "yes" : "none"}, emotion-ctx=${candidates.emotionContextGaps ? "yes" : "none"}, feedback=${candidates.recallFeedback ? "yes" : "none"}`);

    // Load step files + build vars
    const vars = buildSleepVars(snapshot);
    vars.WIRED_RESULTS = formatWiredResults(wiredResults);

    // Inject candidate lists as template variables
    vars.UNTAGGED_MEMORIES = candidates.untaggedMemories || "No untagged memories found.";
    vars.PROMOTION_CANDIDATES = candidates.promotionCandidates || "No promotion candidates found.";
    vars.CONTRADICTION_WARNINGS = candidates.contradictions || "";
    vars.MERGE_CANDIDATES = candidates.mergeCandidates || "No merge candidates found.";
    vars.TRANSLATION_ISSUES = candidates.translationIssues || "No translation issues found.";
    vars.EMOTION_CONTEXT_GAPS = candidates.emotionContextGaps || "No emotion context gaps found.";
    vars.RECALL_FEEDBACK = candidates.recallFeedback || "No recalls happened today.";
    vars.WIRED_RESULTS = formatWiredResults(wiredResults);
    vars.RESUME_CONTEXT = isResume
      ? `This is a RESUMED sleep cycle. Steps already completed: ${Object.entries(existingState!.steps).filter(([, s]) => s.status === "ok" || s.status === "skipped").map(([k]) => k).join(", ")}. Only pending/failed steps will run.`
      : "Fresh sleep cycle — all steps will run.";

    // Pre-query messages for retro (watermark-scoped, noise-stripped)
    const lastSleepTs = snapshot.lastSleepTimestamp ?? 0;
    try {
      const garbagePath = join(memoryConfig.memoryDir, "garbage.json");
      const garbageIds = new Set<number>();
      try {
        const raw = JSON.parse(readFileSync(garbagePath, "utf-8"));
        const entries = Array.isArray(raw) ? raw : (raw?.messages ?? []);
        for (const e of entries) { if (e?.messageId) garbageIds.add(e.messageId); }
      } catch { /* no garbage file */ }

      const msgs = sleepData.getMessagesAfter(lastSleepTs);

      const lines = msgs
        .filter(m => !garbageIds.has(m.id) && !m.content.startsWith("[SYSTEM"))
        .map(m => `[${m.role}]${m.emotion_score ? ` (emotion:${m.emotion_score})` : ""} ${m.content.slice(0, 500)}`);

      vars.CLEAN_MESSAGES = lines.length > 0
        ? `${lines.length} messages since last sleep:\n\n${lines.join("\n")}`
        : "No messages since last sleep.";
      logInfo(TAG, `[SLEEP] Pre-queried ${lines.length} messages for retro (${msgs.length} total, ${garbageIds.size} garbage filtered)`);
    } catch { vars.CLEAN_MESSAGES = "Error loading messages — use abmind recall to search."; }

    // Set remaining missing vars
    vars.MESSAGES_SINCE_WATERMARK = vars.CLEAN_MESSAGES; // same data, different name for gc-noise
    vars.RETRO_PATH = join(memoryConfig.memoryDir, "daily", `daily_${localDate()}.md`);
    try {
      const { getLatestConsolidationFile } = await import("abmind/consolidation-search.js");
      const latest = getLatestConsolidationFile(memoryConfig.memoryDir, "weekly");
      vars.CONSOLIDATION_PATH = latest?.filePath ?? "No consolidation files yet.";
    } catch { vars.CONSOLIDATION_PATH = "No consolidation files yet."; }

    const steps = loadSleepSteps();
    // Merge snapshot vars + bridge vars into one map for JIT substitution
    const snapshotVars = buildSleepVars(snapshot);
    for (const [k, v] of Object.entries(snapshotVars)) vars[k] = vars[k] ?? v;

    // Progress protocol — emit PROGRESS:<pct>:<label> on stdout
    const totalSteps = steps.length;
    let stepIndex = 0;
    const emitProgress = (label: string): void => {
      const pct = Math.round((stepIndex / totalSteps) * 100);
      process.stdout.write(`PROGRESS:${pct}:${label}\n`);
    };

    if (flags.dryRun) {
      for (const step of steps) process.stdout.write(`\n--- ${step.filename} ---\n${substituteVars(step.rawPrompt, vars)}\n`);
      return 0;
    }

    // Skip logic — candidate-driven (empty = skip)
    const skipSet = new Set<string>();

    // SLEEP_QUALITY tiering — controls which prompts are eligible
    const quality = (process.env["SLEEP_QUALITY"] ?? "normal").toLowerCase();
    const curationDay = (process.env["SLEEP_CURATION_DAY"] ?? "sunday").toLowerCase();
    const today = new Date().toLocaleDateString("en", { weekday: "long" }).toLowerCase();
    const isCurationDay = today === curationDay;

    const BUDGET_ONLY = new Set(["gc-noise", "daily-summary", "extract-from-daily"]);
    const WEEKLY_ONLY = new Set(["skill-review", "core-knowledge", "consolidation"]);

    if (quality === "budget") {
      for (const step of steps) {
        if (!BUDGET_ONLY.has(step.name)) skipSet.add(step.name);
      }
      logInfo(TAG, `[SLEEP] Quality=budget — only essential extraction`);
    } else if (quality === "normal" && !isCurationDay) {
      for (const name of WEEKLY_ONLY) skipSet.add(name);
      logInfo(TAG, `[SLEEP] Quality=normal — weekly prompts skipped (curation day: ${curationDay})`);
    } else {
      logInfo(TAG, `[SLEEP] Quality=${quality}${isCurationDay ? " (curation day)" : ""} — all eligible`);
    }

    // Candidate-driven skips (empty = nothing to do)
    if (!candidates.recallFeedback) skipSet.add("feedback");
    if (!candidates.untaggedMemories) skipSet.add("topic-assignment");
    if (!candidates.promotionCandidates) skipSet.add("core-promotion");
    if (!candidates.mergeCandidates) skipSet.add("merge");
    if (!candidates.translationIssues) skipSet.add("translation-check");
    if (!candidates.translationIssues) skipSet.add("translation");
    if (!candidates.emotionContextGaps) skipSet.add("emotion-context");
    if (!candidates.emotionContextGaps) skipSet.add("emotion-context-backfill");
    // Legacy skip names (old prompt files)
    if (snapshot.topicFiles.length === 0) skipSet.add("topic-reorg");
    if (snapshot.dbStats.extractedMemoryCount < 10) { skipSet.add("merge"); skipSet.add("darwinism"); }
    try { if (!existsSync(join(memoryConfig.memoryDir, "..", "received"))) skipSet.add("media-cleanup"); } catch { /* */ }
    try {
      const shortCount = sleepData.getShortMessageCount();
      if (shortCount === 0) skipSet.add("gc-noise");
    } catch { /* */ }

    // Initialize state file
    const state: SleepState = existingState ?? {
      status: "ongoing",
      pid: process.pid,
      startedAt: Date.now(),
      llmCalls: 0,
      wiredResults,
      steps: {},
    };
    state.status = "ongoing";
    state.pid = process.pid;
    state.wiredResults = wiredResults;

    // 20-min wall-clock timeout
    const timeoutHandle = setTimeout(() => {
      logError(TAG, `[SLEEP] ⏰ ${Math.round(SLEEP_TIMEOUT_MS / 60000)}-minute timeout reached — aborting`);
      process.exit(1);
    }, SLEEP_TIMEOUT_MS);

    // Resolve model name for logging (from transport.json)
    const { resolveAgent, loadTransport } = await import("../../components/transport-config.js");
    const tc = loadTransport();
    const modelUsed = tc ? (resolveAgent("dreamy", tc)?.model ?? "unknown") : "unknown";
    let dreamySucceeded = true;
    let dailySummaryPath: string | null = null;

    try {
      // ── LLM call budget (hard safety limit) ──
      const budget = new LlmBudget(state, statePath);

      // ── Catch-up: recover failed essentials from previous days ──
      const sleepDir = join(memoryConfig.memoryDir, "sleep");
      const previousLocks = scanPreviousLocks(sleepDir, dateStr);
      if (previousLocks.length > 0) {
        logInfo(TAG, `[CATCH-UP] Found ${previousLocks.length} previous lock(s)`);
        await runCatchUp(previousLocks, sleepData, memoryConfig, steps, flags, budget);
      }

      emitProgress("starting");
      let consecutiveFailures = 0;

      // Create day directory for per-step logs
      const stepLogDir = join(sleepDir, dateStr);
      mkdirSync(stepLogDir, { recursive: true });

      for (const step of steps) {
        // Hard safety: LLM call budget exhausted → suspend
        if (budget.exhausted) {
          logWarn(TAG, `[BUDGET] Suspending sleep — ${budget.calls}/${SLEEP_MAX_LLM_CALLS} LLM calls used`);
          state.status = "suspended";
          writeStateFile(statePath, state);
          break;
        }

        emitProgress(step.name);
        stepIndex++;

        // Resume: skip already completed steps
        if (isResume && existingState?.steps[step.name]?.status === "ok") {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — already done (resume)`);
          continue;
        }
        if (isResume && existingState?.steps[step.name]?.status === "skipped") {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — skipped (resume)`);
          continue;
        }

        // Skip logic (identity and report always run)
        if (step.skippable && skipSet.has(step.name)) {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — skipped`);
          state.steps[step.name] = { status: "skipped" };
          writeStateFile(statePath, state);
          continue;
        }

        const start = Date.now();
        logInfo(TAG, `[SLEEP] → ${step.name}`);
        state.steps[step.name] = { status: "pending" };
        writeStateFile(statePath, state);

        // Code-driven steps
        if (step.name === "04a-daily-summary") {
          try {
            const ctxWindow = parseInt(process.env["AGENT_SLEEP_CTX_WINDOW"] ?? "128000", 10);
            const userId = sleepData.getPrimaryUserId();
            const watermarkTs = sleepData.getExtractionWatermark(userId);

            // Determine target date from first unprocessed message
            const firstMsgTs = sleepData.getFirstMessageAfter(userId, watermarkTs);
            const firstMsgDate = firstMsgTs ? new Date(firstMsgTs) : new Date();
            const targetDate = `${firstMsgDate.getFullYear()}-${String(firstMsgDate.getMonth() + 1).padStart(2, "0")}-${String(firstMsgDate.getDate()).padStart(2, "0")}`;

            const summary = await buildDailySummary(sleepData.getDb(), (p) => sendWithRetry(null, p, "04a-daily-summary", flags.verbose, budget).then(r => r ?? ""), {
              ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs,
            });
            if (summary) {
              dailySummaryPath = writeDailyFile(memoryConfig.memoryDir, targetDate, summary);
              state.steps[step.name] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
              writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), summary, "utf-8");
            } else {
              state.steps[step.name] = { status: "skipped" };
            }
          } catch (err) {
            logWarn(TAG, `[SLEEP] 04a failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
            dreamySucceeded = false;
          }
          writeStateFile(statePath, state);
          logInfo(TAG, `[SLEEP] ${state.steps[step.name]?.status === "ok" ? "✓" : "✗"} ${step.name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
          continue;
        }

        if (step.name === "04b-extract-from-daily") {
          if (!dailySummaryPath) {
            state.steps[step.name] = { status: "skipped" };
            writeStateFile(statePath, state);
            logInfo(TAG, `[SLEEP] ⏭ ${step.name} — no daily summary`);
            continue;
          }
          try {
            const userId = sleepData.getPrimaryUserId();
            const result = await extractFromDaily(dailySummaryPath, userId, (p) => sendWithRetry(null, p, "04b-extract", flags.verbose, budget).then(r => r ?? ""));
            state.steps[step.name] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
            writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), result, "utf-8");
            logInfo(TAG, `[SLEEP] ✓ ${step.name} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          } catch (err) {
            logWarn(TAG, `[SLEEP] 04b failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
            dreamySucceeded = false;
          }
          writeStateFile(statePath, state);
          continue;
        }

        // Standard prompt-driven step — JIT substitution
        const prompt = substituteVars(step.rawPrompt, vars);
        const ctxBefore = -1;
        const response = await sendWithRetry(null, prompt, step.name, flags.verbose, budget);
        const ctxAfter = -1;
        const duration = Date.now() - start;

        if (response) {
          state.steps[step.name] = { status: "ok", duration: Math.round(duration / 100) / 10, ctxBefore, ctxAfter };
          writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), response, "utf-8");
          // Generic output chaining + explicit aliases
          vars[step.name.toUpperCase().replace(/-/g, "_") + "_OUTPUT"] = response;
          if (step.name === "retrospective") vars.RETRO_CONTENT = response;
        } else {
          state.steps[step.name] = { status: "failed", duration: Math.round(duration / 100) / 10, attempts: MAX_RETRIES, ctxBefore, ctxAfter };
          dreamySucceeded = false;
        }
        writeStateFile(statePath, state);

        logInfo(TAG, `[SLEEP] ${response ? "✓" : "✗"} ${step.name} (${(duration / 1000).toFixed(1)}s, ${response?.length ?? 0} chars)`);

        // Backoff between steps: 10s → 30s → 60s on consecutive failures, reset on success
        if (response) { consecutiveFailures = 0; } else { consecutiveFailures++; }
        const isEssential = step.name.startsWith("04") || step.name === "00-identity";
        if (!isEssential) {
          const delays = [10, 30, 60];
          const delaySec = delays[Math.min(consecutiveFailures, delays.length - 1)]!;
          logInfo(TAG, `[SLEEP] Waiting ${delaySec}s before next step`);
          await new Promise(r => setTimeout(r, delaySec * 1000));
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      try { getSleepRuntime().shutdown(); } catch { /* */ }
    }

    // Set final status
    if (state.status === "ongoing") {
      state.status = dreamySucceeded ? "completed" : "failed";
      writeStateFile(statePath, state);
    }

    // Advance extraction watermark — only when all steps succeeded
    if (dreamySucceeded) {
      try {
        const count = sleepData.advanceExtractionWatermarks();
        logInfo(TAG, `[SLEEP] Extraction watermark advanced for ${count} chat(s)`);
      } catch { /* non-fatal */ }
    } else {
      logWarn(TAG, "[SLEEP] Watermark NOT advanced — essential steps failed, messages preserved for catch-up");
    }

    // Write audit
    const stepEntries = Object.entries(state.steps);
    const okCount = stepEntries.filter(([, s]) => s.status === "ok").length;
    const failCount = stepEntries.filter(([, s]) => s.status === "failed" || s.status === "timeout").length;
    const skipCount = stepEntries.filter(([, s]) => s.status === "skipped").length;
    const totalDuration = (Date.now() - state.startedAt) / 1000;

    const allResponses = stepEntries.map(([k, v]) => `[${k}] ${v.status}${v.duration ? ` (${v.duration}s)` : ""}`).join("\n");
    try {
      writeAuditLog(memoryConfig.memoryDir, {
        timestamp: localISO(),
        model: modelUsed,
        stateSnapshotSummary: buildSnapshotSummary(snapshot),
        subagentResponse: `Wired: ${formatWiredResults(wiredResults)}\n${allResponses}${vars.RETRO_CONTENT ? "\n\n--- Retrospective ---\n" + vars.RETRO_CONTENT : ""}`,
        outcomes: { filesConsolidated: 0, messagesPruned: wiredResults.purged + wiredResults.deduped, embeddingsRemoved: 0, sessionsCleaned: 0, topicsMerged: 0, topicsDeleted: 0 },
      });
    } catch (err) {
      process.stderr.write(`Warning: Failed to write audit — ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // Wired post-task: flush old messages (keep max 500, age out >7 days, garbage 12h)
    if (dreamySucceeded) {
      try {
        // Flush garbage-marked messages
        const garbagePath = join(memoryConfig.memoryDir, "garbage.json");
        if (existsSync(garbagePath)) {
          const raw = JSON.parse(readFileSync(garbagePath, "utf-8"));
          const garbage: Array<{ msg_id?: number }> = Array.isArray(raw) ? raw : (Array.isArray(raw?.messages) ? raw.messages : []);
          if (garbage.length > 0) {
            const ids = garbage.map(g => g.msg_id).filter((id): id is number => typeof id === "number");
            if (ids.length > 0) {
              sleepData.deleteMessagesByIds(ids);
              logInfo(TAG, `[SLEEP] Flushed ${ids.length} garbage messages`);
            }
            writeFileSync(garbagePath, "[]");
          }
        }
        // Age out + cap
        const { agedOut, capped } = sleepData.flushOldMessages({ maxAgeDays: 7, maxCount: 500 });
        if (agedOut > 0) logInfo(TAG, `[SLEEP] Flushed ${agedOut} messages >7d`);
        if (capped > 0) logInfo(TAG, `[SLEEP] Flushed ${capped} messages (cap 500)`);
      } catch (err) { logWarn(TAG, `[WIRED] flush failed: ${err instanceof Error ? err.message : String(err)}`); }
    }

    emitProgress("done");
    logInfo(TAG, `[SLEEP] 🏁 ${okCount} ok, ${failCount} failed, ${skipCount} skipped | wired: ${formatWiredResults(wiredResults)} | ${totalDuration.toFixed(0)}s total`);
    return failCount;
  } finally {
    memory.close();
  }
}



// Only run when executed as a script, not when imported for testing
const isDirectRun =
  process.argv[1]?.endsWith("agentbridge-sleep.ts") ||
  process.argv[1]?.endsWith("agentbridge-sleep.js");
if (isDirectRun) {
  main()
    .then((failCount) => process.exit(failCount > 0 ? 2 : 0))
    .catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
