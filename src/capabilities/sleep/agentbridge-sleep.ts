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
import { MemoryManager } from "../../memory/memory-manager.js";
import { loadMemoryConfig } from "../../memory/memory-config.js";
import { SleepStateGatherer } from "../../memory/sleep-state-gatherer.js";
import { loadSleepSteps, buildSleepVars, substituteVars } from "./sleep-prompt-loader.js";
import { buildDailySummary, writeDailyFile } from "./sleep-daily-summary.js";
import { extractFromDaily } from "./sleep-extract-daily.js";
import { logInfo, logWarn, logError, setLogLevel } from "../../components/logger.js";
import type { StateSnapshot } from "../../memory/sleep-state-gatherer.js";
import { localDate } from "../../components/env-utils.js";
import type { SleepStep } from "./sleep-prompt-loader.js";

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
/** Create a reusable ACP transport for the sleep session. */

// ── State file types ────────────────────────────────────────────────────────

type StepStatus = "ok" | "failed" | "skipped" | "pending" | "timeout";
type StepResult = { status: StepStatus; duration?: number; attempts?: number };
type WiredResults = { purged: number; deduped: number; embedded: number; anomaliesFixed: number; walOk: boolean; ftsOk: boolean; logsDeleted: number };
type SleepStatus = "ongoing" | "completed" | "suspended" | "failed";
type SleepState = { status: SleepStatus; pid: number; startedAt: number; llmCalls: number; wiredResults?: WiredResults; steps: Record<string, StepResult> };

const SLEEP_TIMEOUT_MS = (parseInt(process.env["SLEEP_TIMEOUT_MIN"] ?? "", 10) || 55) * 60 * 1000; // default 55 minutes
const SLEEP_MAX_LLM_CALLS = parseInt(process.env["SLEEP_MAX_LLM_CALLS"] ?? "", 10) || 12;

/** Get the primary chat ID from DB, falling back to ALLOWED_USER_IDS env var. */
function getPrimaryChatId(db: import("better-sqlite3").Database): number {
  try {
    const row = db.prepare("SELECT DISTINCT chat_id FROM messages LIMIT 1").get() as { chat_id: number } | undefined;
    if (row?.chat_id) return row.chat_id;
  } catch { /* */ }
  const envIds = process.env["ALLOWED_USER_IDS"] ?? "";
  const first = parseInt(envIds.split(",")[0]?.trim() ?? "", 10);
  if (Number.isFinite(first) && first > 0) return first;
  throw new Error("No chat_id found in DB and ALLOWED_USER_IDS not set");
}

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

// ── Wired pre-tasks ─────────────────────────────────────────────────────────

async function runWiredPreTasks(db: import("better-sqlite3").Database, memoryDir: string, memory: MemoryManager): Promise<WiredResults> {
  const results: WiredResults = { purged: 0, deduped: 0, embedded: 0, anomaliesFixed: 0, walOk: false, ftsOk: false, logsDeleted: 0 };

  // 1. Purge expired garbage
  try {
    const garbagePath = join(memoryDir, "garbage.json");
    if (existsSync(garbagePath)) {
      const garbage = JSON.parse(readFileSync(garbagePath, "utf-8")) as Record<string, string>;
      const cutoff = Date.now() - 7 * 86400000;
      const expired = Object.entries(garbage).filter(([, ts]) => new Date(ts).getTime() < cutoff);
      if (expired.length > 0) {
        const ids = expired.map(([id]) => parseInt(id, 10)).filter(n => Number.isFinite(n));
        if (ids.length > 0 && db) {
          db.prepare(`DELETE FROM messages WHERE id IN (${ids.join(",")})`).run();
        }
        for (const [id] of expired) delete garbage[id];
        writeFileSync(garbagePath, JSON.stringify(garbage));
        results.purged = expired.length;
      }
    }
  } catch (err) { logWarn(TAG, `[WIRED] garbage purge failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 2. Dedup consecutive exact messages
  try {
    const { removed } = memory.deduplicateMessages();
    results.deduped = removed;
  } catch (err) { logWarn(TAG, `[WIRED] dedup failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 3. WAL checkpoint
  results.walOk = memory.runWalCheckpoint();

  // 4. FTS rebuild if corrupt
  try {
    const { rebuilt } = memory.rebuildFtsIndexes();
    results.ftsOk = true;
    for (const t of rebuilt) logInfo(TAG, `[WIRED] Rebuilt corrupt FTS: ${t}`);
  } catch (err) { logWarn(TAG, `[WIRED] FTS check failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 5. Batch embed NULL embeddings
  try {
    if (process.env["EMBEDDING_ENABLED"] === "true") {
      const { loadEmbedConfig, embedText: embedFn } = await import("../../memory/ollama-embed.js");
      const cfg = loadEmbedConfig();
      if (cfg.enabled) {
        const { embedded } = await memory.backfillEmbeddings((text) => embedFn(cfg, text));
        results.embedded = embedded;
      }
    }
  } catch (err) { logWarn(TAG, `[WIRED] embed failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 6. Anomaly auto-fixes
  try {
    const { fixed } = memory.fixMemoryDefaults();
    results.anomaliesFixed = fixed;
  } catch (err) { logWarn(TAG, `[WIRED] anomaly fixes failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 7. Log rotation (delete >7d)
  try {
    const logsDir = join(memoryDir, "..", "logs");
    if (existsSync(logsDir)) {
      const cutoff = Date.now() - 7 * 86400000;
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith("bridge-") || !f.endsWith(".log")) continue;
        const match = f.match(/bridge-(\d{4}-\d{2}-\d{2})\.log/);
        if (match && new Date(match[1]!).getTime() < cutoff) {
          unlinkSync(join(logsDir, f));
          results.logsDeleted++;
        }
      }
    }
  } catch (err) { logWarn(TAG, `[WIRED] log rotation failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 8. Delete old sleep lock files (>2 days)
  try {
    const sleepDir = join(memoryDir, "sleep");
    if (existsSync(sleepDir)) {
      const cutoff = Date.now() - 2 * 86400000;
      for (const f of readdirSync(sleepDir)) {
        if (!f.endsWith(".lock")) continue;
        const match = f.match(/sleep_(\d{4})(\d{2})(\d{2})\.lock/);
        if (match && new Date(`${match[1]}-${match[2]}-${match[3]}`).getTime() < cutoff) {
          unlinkSync(join(sleepDir, f));
          logInfo(TAG, `[WIRED] Deleted old lock: ${f}`);
        }
      }
    }
  } catch (err) { logWarn(TAG, `[WIRED] lock cleanup failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 9. Compute decayed confidence — write candidates for Darwinism step
  try {
    const candidates = memory.computeDecayedConfidence();
    if (candidates.length > 0) {
      const candidatesPath = join(memoryDir, "sleep", "darwinism-candidates.json");
      writeFileSync(candidatesPath, JSON.stringify(candidates, null, 2));
      logInfo(TAG, `[WIRED] ${candidates.length} Darwinism prune candidates (effective confidence < 1)`);
    }
  } catch (err) { logWarn(TAG, `[WIRED] confidence decay failed: ${err instanceof Error ? err.message : String(err)}`); }

  return results;
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

async function createSleepTransport(verbose: boolean): Promise<{ transport: import("../../components/transport/acp-transport.js").AcpTransport; model: string }> {
  const { loadAndValidateConfig } = await import("../../components/config.js");
  const config = await loadAndValidateConfig();
  const { AcpTransport } = await import("../../components/transport/acp-transport.js");
  const model = process.env["AGENT_SLEEP_MODEL"] || "auto";
  const transport = new AcpTransport(config.transport.agentCliPath, config.transport.workingDir, { model: model !== "unknown" ? model : undefined, autoReinit: false, tag: "acp-sleep" });
  await transport.initialize();
  if (verbose) logInfo(TAG, `ACP transport initialized (model=${model})`);
  return { transport, model };
}

const MAX_RETRIES = 3;

/** Send a prompt with retry logic. Returns response or null on exhaustion. */
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
  transport: import("../../components/transport/acp-transport.js").AcpTransport,
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
      const response = await transport.sendPrompt("system:sleep", prompt);
      return response;
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
    `Sessions: ${snapshot.dbStats.sessionCount}`,
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
  transport: import("../../components/transport/acp-transport.js").AcpTransport,
  db: import("better-sqlite3").Database,
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
        const chatId = getPrimaryChatId(db);
        const dayStart = dateStrToMs(lock.dateStr);
        const dayEnd = dayStart + 86400000;
        const summary = await buildDailySummary(db, (p) => sendWithRetry(transport, p, "catch-up-04a", flags.verbose, budget).then(r => r ?? ""), {
          ctxWindow, memoryDir: memoryConfig.memoryDir, chatId, watermarkTs: 0,
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
          const chatId = getPrimaryChatId(db);
          const result = await extractFromDaily(dailyPath, chatId, (p) => sendWithRetry(transport, p, "catch-up-04b", flags.verbose, budget).then(r => r ?? ""));
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
      const response = await sendWithRetry(transport, step.prompt, `catch-up-${stepName}`, flags.verbose, budget);
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
    const db = memory.getDatabase();
    if (!db) { process.stderr.write("Fatal: Database not available\n"); process.exit(1); }

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
    const wiredResults = await runWiredPreTasks(db, memoryConfig.memoryDir, memory);
    logInfo(TAG, `[SLEEP] Wired: ${formatWiredResults(wiredResults)}`);

    // Load step files + build vars
    const vars = buildSleepVars(snapshot);
    vars.WIRED_RESULTS = formatWiredResults(wiredResults);
    vars.RESUME_CONTEXT = isResume
      ? `This is a RESUMED sleep cycle. Steps already completed: ${Object.entries(existingState!.steps).filter(([, s]) => s.status === "ok" || s.status === "skipped").map(([k]) => k).join(", ")}. Only pending/failed steps will run.`
      : "Fresh sleep cycle — all steps will run.";

    const steps = loadSleepSteps(snapshot);
    for (const step of steps) {
      step.prompt = substituteVars(step.prompt, vars);
    }

    // Progress protocol — emit PROGRESS:<pct>:<label> on stdout
    const totalSteps = steps.length;
    let stepIndex = 0;
    const emitProgress = (label: string): void => {
      const pct = Math.round((stepIndex / totalSteps) * 100);
      process.stdout.write(`PROGRESS:${pct}:${label}\n`);
    };

    if (flags.dryRun) {
      for (const step of steps) process.stdout.write(`\n--- ${step.filename} ---\n${step.prompt}\n`);
      return 0;
    }

    // Skip logic
    const skipSet = new Set<string>();
    try {
      const recallCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE content LIKE '%agentbridge-recall%' AND timestamp > ?",
      ).get(snapshot.lastSleepTimestamp ?? 0) as { cnt: number }).cnt;
      if (recallCount === 0) skipSet.add("feedback");
    } catch { /* */ }
    if (snapshot.topicFiles.length === 0) skipSet.add("topic-reorg");
    if (snapshot.dbStats.extractedMemoryCount < 10) { skipSet.add("merge"); skipSet.add("darwinism"); }
    try { if (!existsSync(join(memoryConfig.memoryDir, "..", "received"))) skipSet.add("media-cleanup"); } catch { /* */ }
    // Skip noise if no short messages
    try {
      const shortCount = (db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE role='user' AND length(content) < 20").get() as { cnt: number }).cnt;
      if (shortCount === 0) skipSet.add("gc-noise");
    } catch { /* */ }
    // Skip translation check if no bilingual memories
    try {
      const bilingualCount = (db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories WHERE content_en != content_original AND content_original IS NOT NULL").get() as { cnt: number }).cnt;
      if (bilingualCount === 0) skipSet.add("translation-check");
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

    const { transport, model: modelUsed } = await createSleepTransport(flags.verbose);
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
        await runCatchUp(previousLocks, transport, db, memoryConfig, steps, flags, budget);
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
            const chatId = getPrimaryChatId(db);
            const watermarkRow = db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE chat_id = ?").get(chatId) as { last_processed_timestamp: number } | undefined;

            // Determine target date from first unprocessed message
            const watermarkTs = watermarkRow?.last_processed_timestamp ?? 0;
            const firstMsgRow = db.prepare("SELECT MIN(timestamp) as ts FROM messages WHERE chat_id = ? AND timestamp > ?").get(chatId, watermarkTs) as { ts: number | null } | undefined;
            const firstMsgDate = firstMsgRow?.ts ? new Date(firstMsgRow.ts) : new Date();
            const targetDate = `${firstMsgDate.getFullYear()}-${String(firstMsgDate.getMonth() + 1).padStart(2, "0")}-${String(firstMsgDate.getDate()).padStart(2, "0")}`;

            const summary = await buildDailySummary(db, (p) => sendWithRetry(transport, p, "04a-daily-summary", flags.verbose, budget).then(r => r ?? ""), {
              ctxWindow, memoryDir: memoryConfig.memoryDir, chatId, watermarkTs,
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
            const chatId = getPrimaryChatId(db);
            const result = await extractFromDaily(dailySummaryPath, chatId, (p) => sendWithRetry(transport, p, "04b-extract", flags.verbose, budget).then(r => r ?? ""));
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

        // Standard prompt-driven step
        const response = await sendWithRetry(transport, step.prompt, step.name, flags.verbose, budget);
        const duration = Date.now() - start;

        if (response) {
          state.steps[step.name] = { status: "ok", duration: Math.round(duration / 100) / 10 };
          writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), response, "utf-8");
        } else {
          state.steps[step.name] = { status: "failed", duration: Math.round(duration / 100) / 10, attempts: MAX_RETRIES };
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
      try { transport.destroy(); } catch { /* */ }
    }

    // Set final status
    if (state.status === "ongoing") {
      state.status = dreamySucceeded ? "completed" : "failed";
      writeStateFile(statePath, state);
    }

    // Advance extraction watermark — only when all steps succeeded
    if (dreamySucceeded) {
      try {
        const chatIds = db.prepare("SELECT DISTINCT chat_id FROM messages").all() as { chat_id: number }[];
        const now = Date.now();
        for (const { chat_id } of chatIds) {
          db.prepare(
            `INSERT INTO extraction_watermarks (chat_id, last_processed_timestamp)
             VALUES (?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET last_processed_timestamp = excluded.last_processed_timestamp`,
          ).run(chat_id, now);
        }
        logInfo(TAG, `[SLEEP] Extraction watermark advanced for ${chatIds.length} chat(s)`);
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
        subagentResponse: `Wired: ${formatWiredResults(wiredResults)}\n${allResponses}`,
        outcomes: { filesConsolidated: 0, messagesPruned: wiredResults.purged + wiredResults.deduped, embeddingsRemoved: 0, sessionsCleaned: 0, topicsMerged: 0, topicsDeleted: 0 },
      });
    } catch (err) {
      process.stderr.write(`Warning: Failed to write audit — ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // Wired post-task: flush old messages (keep max 500, age out >7 days, garbage 12h)
    if (dreamySucceeded) {
      try {
        // Flush garbage-marked messages >12h
        const garbagePath = join(memoryConfig.memoryDir, "garbage.json");
        if (existsSync(garbagePath)) {
          const raw = JSON.parse(readFileSync(garbagePath, "utf-8"));
          const garbage: Array<{ msg_id?: number }> = Array.isArray(raw) ? raw : (Array.isArray(raw?.messages) ? raw.messages : []);
          if (garbage.length > 0) {
            const ids = garbage.map(g => g.msg_id).filter((id): id is number => typeof id === "number");
            if (ids.length > 0) {
              db.prepare(`DELETE FROM messages WHERE id IN (${ids.join(",")})`).run();
              logInfo(TAG, `[SLEEP] Flushed ${ids.length} garbage messages`);
            }
            writeFileSync(garbagePath, "[]");
          }
        }
        // Age out >7 days
        const ageCutoff = Date.now() - 7 * 24 * 3600000;
        const flushedAge = db.prepare("DELETE FROM messages WHERE timestamp < ?").run(ageCutoff);
        if (flushedAge.changes > 0) logInfo(TAG, `[SLEEP] Flushed ${flushedAge.changes} messages >7d`);
        // Cap at 500
        const total = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
        if (total > 500) {
          const excess = total - 500;
          const flushedCount = db.prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY timestamp ASC LIMIT ?)").run(excess);
          if (flushedCount.changes > 0) logInfo(TAG, `[SLEEP] Flushed ${flushedCount.changes} messages (cap 500)`);
        }
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
