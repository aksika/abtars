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
import { mkdirSync, writeFileSync } from "node:fs";
import { MemoryManager } from "../components/memory-manager.js";
import { loadMemoryConfig } from "../components/memory-config.js";
import { SleepStateGatherer } from "../components/sleep-state-gatherer.js";
import { SleepPromptBuilder } from "../components/sleep-prompt-builder.js";
import { logInfo, logError, setLogLevel } from "../components/logger.js";
import type { StateSnapshot } from "../components/sleep-state-gatherer.js";

const TAG = "agentbridge-sleep";

// ── Preferred models in priority order ──────────────────────────────────────
const MODEL_PRIORITY = [
  "claude-opus-4-0-20250514",
  "claude-sonnet-4-20250514",
  "claude-sonnet-3-5-20241022",
];

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
async function invokeSubagent(
  prompt: string,
  verbose: boolean,
): Promise<{ response: string; model: string }> {
  // Sleep CLI always uses ACP transport — it spawns its own Kiro CLI process
  // with a dedicated session so it never conflicts with the user's tmux session.

  const { loadAndValidateConfig } = await import("../components/config.js");
  const config = await loadAndValidateConfig();

  const { AcpTransport } = await import("../components/acp-transport.js");
  const transport = new AcpTransport(config.kiroCLIPath, config.workingDir);

  const usedModel = MODEL_PRIORITY[0]!;

  try {
    await transport.initialize();
    if (verbose) logInfo(TAG, "ACP transport initialized");

    // The session key "system:sleep" isolates this from user conversations
    if (verbose) logInfo(TAG, `Invoking subagent with model preference: ${usedModel}`);

    const response = await transport.sendPrompt("system:sleep", prompt);

    return { response, model: usedModel };
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    try {
      transport.destroy();
    } catch {
      // best-effort cleanup
    }
  }
}


// ── Audit trail helpers ─────────────────────────────────────────────────────

export function buildSnapshotSummary(snapshot: StateSnapshot): string {
  return [
    `Working dirs: ${snapshot.workingDirs.length}`,
    `Messages: ${snapshot.dbStats.messageCount}`,
    `Compactions: ${snapshot.dbStats.compactionCount}`,
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
  const auditDir = join(memoryDir, "audit");
  mkdirSync(auditDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const filename = `sleep_${dateStr}_${timeStr}.md`;
  const filePath = join(auditDir, filename);

  const content = [
    `# Sleep Audit Log`,
    ``,
    `**Timestamp:** ${entry.timestamp}`,
    `**Model:** ${entry.model}`,
    ``,
    `## State Snapshot Summary`,
    `${entry.stateSnapshotSummary}`,
    ``,
    `## Subagent Response`,
    entry.error ? `**Error:** ${entry.error}` : entry.subagentResponse,
    ``,
    `## Outcomes`,
    `- Files consolidated: ${entry.outcomes.filesConsolidated}`,
    `- Messages pruned: ${entry.outcomes.messagesPruned}`,
    `- Embeddings removed: ${entry.outcomes.embeddingsRemoved}`,
    `- Sessions cleaned: ${entry.outcomes.sessionsCleaned}`,
    `- Topics merged: ${entry.outcomes.topicsMerged}`,
    `- Topics deleted: ${entry.outcomes.topicsDeleted}`,
  ].join("\n");

  writeFileSync(filePath, content, "utf-8");
}

// ── Main orchestration ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);

  if (flags.verbose) {
    setLogLevel("debug");
    logInfo(TAG, "Verbose mode enabled");
  }

  // Phase 1: Initialize MemoryManager
  if (flags.verbose) logInfo(TAG, "Phase 1: Initializing MemoryManager");
  const memoryConfig = loadMemoryConfig();
  const memory = new MemoryManager(memoryConfig);

  try {
    await memory.initialize();
    if (flags.verbose) logInfo(TAG, "MemoryManager initialized successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal: Failed to initialize MemoryManager — ${msg}\n`);
    process.exit(1);
  }

  try {
    const db = memory.getDatabase();
    if (!db) {
      process.stderr.write("Fatal: Database not available after initialization\n");
      process.exit(1);
    }

    // Phase 2: Gather state
    if (flags.verbose) logInfo(TAG, "Phase 2: Gathering system state");
    const gatherer = new SleepStateGatherer(db, memoryConfig);
    let snapshot: StateSnapshot;
    try {
      snapshot = await gatherer.gather();
      if (flags.verbose) logInfo(TAG, `State gathered: ${buildSnapshotSummary(snapshot)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Fatal: State gathering failed — ${msg}\n`);
      process.exit(1);
    }

    // Phase 3: Build prompt
    if (flags.verbose) logInfo(TAG, "Phase 3: Building sleep prompt");
    const builder = new SleepPromptBuilder();
    let prompt: string;
    try {
      prompt = builder.build(snapshot);
      if (flags.verbose) logInfo(TAG, `Prompt built (${prompt.length} chars)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Fatal: Prompt construction failed — ${msg}\n`);
      process.exit(1);
    }

    // Phase 4: Dry-run or invoke subagent
    if (flags.dryRun) {
      if (flags.verbose) logInfo(TAG, "Dry-run mode — printing prompt to stdout");
      process.stdout.write(prompt + "\n");
      return;
    }

    // Phase 5: Invoke subagent
    if (flags.verbose) logInfo(TAG, "Phase 4: Invoking subagent");
    let subagentResponse: string;
    let modelUsed: string;
    try {
      const result = await invokeSubagent(prompt, flags.verbose);
      subagentResponse = result.response;
      modelUsed = result.model;
      if (flags.verbose) logInfo(TAG, `Subagent completed (model=${modelUsed}, response=${subagentResponse.length} chars)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(TAG, "Subagent invocation failed", err);

      // Write failure audit
      try {
        writeAuditLog(memoryConfig.memoryDir, {
          timestamp: new Date().toISOString(),
          model: "none",
          stateSnapshotSummary: buildSnapshotSummary(snapshot),
          subagentResponse: "",
          outcomes: {
            filesConsolidated: 0,
            messagesPruned: 0,
            embeddingsRemoved: 0,
            sessionsCleaned: 0,
            topicsMerged: 0,
            topicsDeleted: 0,
          },
          error: msg,
        });
      } catch (auditErr) {
        process.stderr.write(`Warning: Failed to write failure audit — ${auditErr instanceof Error ? auditErr.message : String(auditErr)}\n`);
      }

      process.stderr.write(`Fatal: Subagent invocation failed — ${msg}\n`);
      process.exit(1);
    }

    // Phase 6: Log audit trail
    if (flags.verbose) logInfo(TAG, "Phase 5: Writing audit trail");
    try {
      writeAuditLog(memoryConfig.memoryDir, {
        timestamp: new Date().toISOString(),
        model: modelUsed,
        stateSnapshotSummary: buildSnapshotSummary(snapshot),
        subagentResponse,
        outcomes: parseOutcomesFromResponse(subagentResponse),
      });
      if (flags.verbose) logInfo(TAG, "Audit trail written successfully");
    } catch (err) {
      // Audit failure is non-fatal — maintenance still succeeded
      process.stderr.write(`Warning: Failed to write audit log — ${err instanceof Error ? err.message : String(err)}\n`);
    }

    logInfo(TAG, "Sleep routine completed successfully");
  } finally {
    memory.close();
  }
}

// Only run when executed as a script, not when imported for testing
const isDirectRun =
  process.argv[1]?.endsWith("agentbridge-sleep.ts") ||
  process.argv[1]?.endsWith("agentbridge-sleep.js");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
