#!/usr/bin/env node
/**
 * agentbridge-sleep — CLI entry point for overnight memory maintenance.
 *
 * Thin orchestrator: gathers system state, builds a comprehensive prompt,
 * invokes a powerful subagent (Opus 4.6 preferred) to perform all intelligent
 * maintenance, logs the audit trail, and exits.
 *
 * Usage:
 *   agentbridge sleep [--dry-run] [--verbose]
 *
 * Flags:
 *   --dry-run   Gather state and build prompt, print to stdout, skip subagent
 *   --verbose   Enable detailed logging at each orchestration step
 *
 * Exit codes:
 *   0  Success
 *   1  Fatal error
 */

import { join } from "node:path";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { MemoryManager } from "../components/memory-manager.js";
import { loadMemoryConfig } from "../components/memory-config.js";
import { SleepStateGatherer } from "../components/sleep-state-gatherer.js";
import { loadSleepPrompt, loadSleepSteps } from "../components/sleep-prompt-loader.js";
import { logInfo, logWarn, logError, setLogLevel } from "../components/logger.js";
import type { StateSnapshot } from "../components/sleep-state-gatherer.js";
import { localDate } from "../components/env-utils.js";

const TAG = "agentbridge-sleep";

// ── Argument parsing ────────────────────────────────────────────────────────

export type RawArgs = {
  dryRun: boolean;
  verbose: boolean;
};

export function parseArgs(argv: string[]): RawArgs {
  const args = argv.slice(2);
  const parsed: RawArgs = { dryRun: false, verbose: false };

  for (const arg of args) {
    switch (arg) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--verbose":
        parsed.verbose = true;
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
async function createSleepTransport(verbose: boolean): Promise<{ transport: import("../components/acp-transport.js").AcpTransport; model: string }> {
  const { loadAndValidateConfig } = await import("../components/config.js");
  const config = await loadAndValidateConfig();
  const { AcpTransport } = await import("../components/acp-transport.js");
  const transport = new AcpTransport(config.kiroCLIPath, config.workingDir);
  const model = process.env.MEMORY_SUBAGENT_MODEL || process.env.KIRO_MODEL || "unknown";
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

    // Gather state
    const gatherer = new SleepStateGatherer(db, memoryConfig);
    const snapshot = await gatherer.gather();
    if (flags.verbose) logInfo(TAG, `State gathered: ${buildSnapshotSummary(snapshot)}`);

    // Load step files
    let steps: import("../components/sleep-prompt-loader.js").SleepStep[];
    try {
      steps = loadSleepSteps(snapshot);
      if (flags.verbose) logInfo(TAG, `Loaded ${steps.length} sleep steps`);
    } catch {
      // Fallback to monolith if step files not deployed yet
      logWarn(TAG, "Sleep step files not found, falling back to monolith prompt");
      const prompt = loadSleepPrompt(snapshot);
      if (flags.dryRun) { process.stdout.write(prompt + "\n"); return; }
      const { transport, model } = await createSleepTransport(flags.verbose);
      try {
        const response = await transport.sendPrompt("system:sleep", prompt);
        writeAuditLog(memoryConfig.memoryDir, {
          timestamp: new Date().toISOString(), model,
          stateSnapshotSummary: buildSnapshotSummary(snapshot),
          subagentResponse: response,
          outcomes: parseOutcomesFromResponse(response),
        });
      } finally { try { transport.destroy(); } catch { /* */ } }
      logInfo(TAG, "Sleep routine completed (monolith fallback)");
      return;
    }

    // Dry-run: print all prompts
    if (flags.dryRun) {
      for (const step of steps) {
        process.stdout.write(`\n--- ${step.filename} ---\n${step.prompt}\n`);
      }
      return;
    }

    // Skip logic based on state snapshot
    const skipSet = new Set<string>();
    // Skip feedback if no recall invocations today
    try {
      const recallCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE content LIKE '%agentbridge-recall%' AND timestamp > ?",
      ).get(snapshot.lastSleepTimestamp ?? 0) as { cnt: number }).cnt;
      if (recallCount === 0) skipSet.add("feedback");
    } catch { /* don't skip on error */ }
    if (snapshot.fts5Health.messages_fts === "ok" && snapshot.fts5Health.extracted_memories_fts === "ok"
        && snapshot.fts5Health.extracted_memories_original_fts === "ok" && snapshot.dbStats.nullEmbeddingCount === 0) {
      skipSet.add("db-maintenance");
    }
    if (snapshot.topicFiles.length === 0) skipSet.add("topic-reorg");
    if (snapshot.dbStats.extractedMemoryCount < 10) skipSet.add("merge");
    // media-cleanup: check received dir
    try {
      const { existsSync: ex } = await import("node:fs");
      if (!ex(join(memoryConfig.memoryDir, "..", "received"))) skipSet.add("media-cleanup");
    } catch { /* don't skip on error */ }

    // Create transport (one kiro-cli spawn for entire session)
    const { transport, model: modelUsed } = await createSleepTransport(flags.verbose);
    const stepResults: Array<{ step: string; duration: number; attempts: number; status: "ok" | "failed" | "skipped"; responseLen: number }> = [];

    try {
      for (const step of steps) {
        // Check skip
        if (step.skippable && skipSet.has(step.name)) {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — skipped`);
          stepResults.push({ step: step.name, duration: 0, attempts: 0, status: "skipped", responseLen: 0 });
          continue;
        }

        const start = Date.now();
        logInfo(TAG, `[SLEEP] → ${step.name}`);

        const response = await sendWithRetry(transport, step.prompt, step.name, flags.verbose);
        const duration = Date.now() - start;
        const attempts = response ? 1 : MAX_RETRIES; // approximate

        stepResults.push({
          step: step.name,
          duration,
          attempts,
          status: response ? "ok" : "failed",
          responseLen: response?.length ?? 0,
        });

        logInfo(TAG, `[SLEEP] ${response ? "✓" : "✗"} ${step.name} (${(duration / 1000).toFixed(1)}s, ${response?.length ?? 0} chars)`);
      }
    } finally {
      try { transport.destroy(); } catch { /* */ }
    }

    // Write structured audit
    const allResponses = stepResults.map(r => `[${r.step}] ${r.status} (${(r.duration / 1000).toFixed(1)}s)`).join("\n");
    try {
      writeAuditLog(memoryConfig.memoryDir, {
        timestamp: new Date().toISOString(),
        model: modelUsed,
        stateSnapshotSummary: buildSnapshotSummary(snapshot),
        subagentResponse: allResponses,
        outcomes: {
          filesConsolidated: 0, messagesPruned: 0, embeddingsRemoved: 0,
          sessionsCleaned: 0, topicsMerged: 0, topicsDeleted: 0,
        },
      });
    } catch (err) {
      process.stderr.write(`Warning: Failed to write audit — ${err instanceof Error ? err.message : String(err)}\n`);
    }

    const okCount = stepResults.filter(r => r.status === "ok").length;
    const failCount = stepResults.filter(r => r.status === "failed").length;
    const skipCount = stepResults.filter(r => r.status === "skipped").length;
    logInfo(TAG, `[SLEEP] 🏁 Sleep routine completed: ${okCount} ok, ${failCount} failed, ${skipCount} skipped`);
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
