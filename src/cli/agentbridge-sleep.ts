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

import { join } from "node:path";
import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { MemoryManager } from "../components/memory-manager.js";
import { loadMemoryConfig } from "../components/memory-config.js";
import { SleepStateGatherer } from "../components/sleep-state-gatherer.js";
import { loadSleepSteps, buildSleepVars, substituteVars } from "../components/sleep-prompt-loader.js";
import { logInfo, logWarn, logError, setLogLevel } from "../components/logger.js";
import type { StateSnapshot } from "../components/sleep-state-gatherer.js";
import { localDate } from "../components/env-utils.js";

const TAG = "agentbridge-sleep";

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
type SleepState = { pid: number; startedAt: number; wiredResults?: WiredResults; steps: Record<string, StepResult> };

const SLEEP_TIMEOUT_MS = (parseInt(process.env["SLEEP_TIMEOUT_MIN"] ?? "", 10) || 30) * 60 * 1000; // default 30 minutes

function readStateFile(path: string): SleepState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Validate it's a proper state file (not old PID-only format)
    if (typeof raw !== "object" || raw === null || !raw.steps) return null;
    return raw;
  } catch { return null; }
}

function writeStateFile(path: string, state: SleepState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ── Wired pre-tasks ─────────────────────────────────────────────────────────

async function runWiredPreTasks(db: import("better-sqlite3").Database, memoryDir: string): Promise<WiredResults> {
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
        if (ids.length > 0) {
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
    const dupes = db.prepare(`
      SELECT b.id FROM messages a JOIN messages b
      ON a.chat_id = b.chat_id AND a.role = b.role
      AND TRIM(a.content) = TRIM(b.content)
      AND b.id > a.id
      AND NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.chat_id = a.chat_id AND m.id > a.id AND m.id < b.id AND m.role = a.role
      )
    `).all() as Array<{ id: number }>;
    if (dupes.length > 0) {
      db.prepare(`DELETE FROM messages WHERE id IN (${dupes.map(d => d.id).join(",")})`).run();
      results.deduped = dupes.length;
    }
  } catch (err) { logWarn(TAG, `[WIRED] dedup failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 3. WAL checkpoint
  try { db.pragma("wal_checkpoint(TRUNCATE)"); results.walOk = true; } catch (err) { logWarn(TAG, `[WIRED] WAL checkpoint failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 4. FTS rebuild if corrupt
  try {
    for (const table of ["messages_fts", "extracted_memories_fts", "extracted_memories_original_fts"]) {
      try { db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`); }
      catch { db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`); logInfo(TAG, `[WIRED] Rebuilt corrupt FTS: ${table}`); }
    }
    results.ftsOk = true;
  } catch (err) { logWarn(TAG, `[WIRED] FTS check failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 5. Batch embed NULL embeddings
  try {
    if (process.env["EMBEDDING_ENABLED"] === "true") {
      const { loadEmbedConfig, embedText: embedFn } = await import("../components/ollama-embed.js");
      const cfg = loadEmbedConfig();
      if (cfg.enabled) {
        const rows = db.prepare("SELECT id, content_en FROM extracted_memories WHERE embedding IS NULL").all() as Array<{ id: number; content_en: string }>;
        for (const row of rows) {
          const vec = await embedFn(cfg, row.content_en);
          if (vec) { db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ?").run(Buffer.from(vec.buffer), row.id); results.embedded++; }
        }
      }
    }
  } catch (err) { logWarn(TAG, `[WIRED] embed failed: ${err instanceof Error ? err.message : String(err)}`); }

  // 6. Anomaly auto-fixes
  try {
    let fixed = 0;
    fixed += db.prepare("UPDATE extracted_memories SET trust = 2 WHERE memory_type = 'decision' AND trust < 2").run().changes;
    fixed += db.prepare("UPDATE extracted_memories SET classification = 1 WHERE memory_type = 'decision' AND classification = 0").run().changes;
    fixed += db.prepare("UPDATE extracted_memories SET trust = 2 WHERE trust = 0 AND credibility = 6 AND integrity = 2").run().changes;
    fixed += db.prepare("UPDATE extracted_memories SET credibility = 3 WHERE credibility = 6 AND created_at < ?").run(Date.now() - 7 * 86400000).changes;
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

async function createSleepTransport(verbose: boolean): Promise<{ transport: import("../components/acp-transport.js").AcpTransport; model: string }> {
  const { loadAndValidateConfig } = await import("../components/config.js");
  const config = await loadAndValidateConfig();
  const { AcpTransport } = await import("../components/acp-transport.js");
  const transport = new AcpTransport(config.agentCliPath, config.workingDir);
  const model = process.env.AGENT_SLEEP_MODEL || "unknown";
  await transport.initialize();
  if (verbose) logInfo(TAG, `ACP transport initialized (model=${model})`);
  return { transport, model };
}

const MAX_RETRIES = 3;

/** Send a prompt with retry logic. Returns response or null on exhaustion. */
async function sendWithRetry(
  transport: import("../components/acp-transport.js").AcpTransport,
  prompt: string,
  stepName: string,
  _verbose: boolean,
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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

// ── Main orchestration ──────────────────────────────────────────────────────

async function main(): Promise<void> {
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
    const gatherer = new SleepStateGatherer(db, memoryConfig);
    const snapshot = await gatherer.gather();
    if (flags.verbose) logInfo(TAG, `State gathered: ${buildSnapshotSummary(snapshot)}`);

    // Guardrail: skip if no messages since last sleep (unless --force)
    const msgCount = snapshot.dbStats.messagesSinceLastSleep;
    if (msgCount === 0 && !flags.force) {
      logInfo(TAG, `[SLEEP] No messages since last sleep — nothing to process. Use --force to run housekeeping anyway.`);
      return;
    }
    if (msgCount === 0 && flags.force) {
      logInfo(TAG, `[SLEEP] No messages since last sleep — running housekeeping only (--force).`);
    }

    // Wired pre-tasks (always run — fast, idempotent)
    logInfo(TAG, `[SLEEP] Running wired pre-tasks${isResume ? " (resume)" : ""}...`);
    const wiredResults = await runWiredPreTasks(db, memoryConfig.memoryDir);
    logInfo(TAG, `[SLEEP] Wired: ${formatWiredResults(wiredResults)}`);

    // If --force with no messages, stop after housekeeping
    if (msgCount === 0) return;

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

    if (flags.dryRun) {
      for (const step of steps) process.stdout.write(`\n--- ${step.filename} ---\n${step.prompt}\n`);
      return;
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
      pid: process.pid,
      startedAt: Date.now(),
      wiredResults,
      steps: {},
    };
    state.wiredResults = wiredResults;

    // 20-min wall-clock timeout
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      logError(TAG, `[SLEEP] ⏰ ${Math.round(SLEEP_TIMEOUT_MS / 60000)}-minute timeout reached — killing transport`);
    }, SLEEP_TIMEOUT_MS);

    const { transport, model: modelUsed } = await createSleepTransport(flags.verbose);
    let dreamySucceeded = true;

    try {
      for (const step of steps) {
        if (timedOut) {
          state.steps[step.name] = { status: "timeout" };
          writeStateFile(statePath, state);
          continue;
        }

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

        const response = await sendWithRetry(transport, step.prompt, step.name, flags.verbose);
        const duration = Date.now() - start;

        if (response) {
          state.steps[step.name] = { status: "ok", duration: Math.round(duration / 100) / 10 };
        } else {
          state.steps[step.name] = { status: "failed", duration: Math.round(duration / 100) / 10, attempts: MAX_RETRIES };
          dreamySucceeded = false;
        }
        writeStateFile(statePath, state);

        logInfo(TAG, `[SLEEP] ${response ? "✓" : "✗"} ${step.name} (${(duration / 1000).toFixed(1)}s, ${response?.length ?? 0} chars)`);
      }
    } finally {
      clearTimeout(timeoutHandle);
      try { transport.destroy(); } catch { /* */ }
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
        timestamp: new Date().toISOString(),
        model: modelUsed,
        stateSnapshotSummary: buildSnapshotSummary(snapshot),
        subagentResponse: `Wired: ${formatWiredResults(wiredResults)}\n${allResponses}`,
        outcomes: { filesConsolidated: 0, messagesPruned: wiredResults.purged + wiredResults.deduped, embeddingsRemoved: 0, sessionsCleaned: 0, topicsMerged: 0, topicsDeleted: 0 },
      });
    } catch (err) {
      process.stderr.write(`Warning: Failed to write audit — ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // Wired post-task: flush >24h messages (only if Dreamy succeeded)
    if (dreamySucceeded && !timedOut) {
      try {
        const cutoff = Date.now() - 24 * 3600000;
        const flushed = db.prepare("DELETE FROM messages WHERE timestamp < ?").run(cutoff);
        if (flushed.changes > 0) logInfo(TAG, `[SLEEP] Flushed ${flushed.changes} messages >24h`);
      } catch (err) { logWarn(TAG, `[WIRED] flush failed: ${err instanceof Error ? err.message : String(err)}`); }
    }

    logInfo(TAG, `[SLEEP] 🏁 ${okCount} ok, ${failCount} failed, ${skipCount} skipped | wired: ${formatWiredResults(wiredResults)} | ${totalDuration.toFixed(0)}s total`);
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
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
