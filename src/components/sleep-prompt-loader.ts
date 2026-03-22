import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { StateSnapshot } from "./sleep-state-gatherer.js";
import { logWarn } from "./logger.js";

const TAG = "sleep-prompt-loader";

/**
 * Load sleeping_prompt.md template and inject state snapshot variables.
 * Looks for the template in:
 *   1. ~/.agentbridge/prompts/sleeping_prompt.md (deployed, read-only)
 *   2. ~/.agentbridge/sleeping_prompt.md (legacy location)
 *   3. persona/sleeping_prompt.md (dev fallback)
 */
export function loadSleepPrompt(snapshot: StateSnapshot): string {
  const prompts = join(homedir(), ".agentbridge", "prompts", "sleeping_prompt.md");
  const legacy = join(homedir(), ".agentbridge", "sleeping_prompt.md");
  const dev = join(process.cwd(), "persona", "sleeping_prompt.md");

  let template: string;
  if (existsSync(prompts)) {
    template = readFileSync(prompts, "utf-8");
  } else if (existsSync(legacy)) {
    logWarn(TAG, `sleeping_prompt.md found at legacy location — move to ${prompts}`);
    template = readFileSync(legacy, "utf-8");
  } else if (existsSync(dev)) {
    template = readFileSync(dev, "utf-8");
  } else {
    throw new Error(`sleeping_prompt.md not found at ${prompts}, ${legacy}, or ${dev}`);
  }

  // Build variable map
  const vars: Record<string, string> = {
    TIMESTAMP: snapshot.timestamp,
    LAST_SLEEP_AUDIT: snapshot.lastSleepAudit ?? "none",
    LAST_SLEEP_TS: snapshot.lastSleepTimestamp ? String(snapshot.lastSleepTimestamp) : "0",
    CURRENT_TS: String(Date.now()),
    WAKEUP_DATE: snapshot.wakeupDate ?? new Date().toISOString().slice(0, 10),
    STATE_SNAPSHOT: buildSnapshotBlock(snapshot),
    FTS_MESSAGES: snapshot.fts5Health.messages_fts,
    FTS_EXTRACTED: snapshot.fts5Health.extracted_memories_fts,
    FTS_ORIGINAL: snapshot.fts5Health.extracted_memories_original_fts,
    DISK_USAGE_MB: (snapshot.diskUsageBytes / 1024 / 1024).toFixed(1),
    DISK_BUDGET_MB: (snapshot.diskBudgetBytes / 1024 / 1024).toFixed(0),
    TODO_CONTENTS: snapshot.todoContents ?? "No todo list yet.",
    CRON_CONTENTS: snapshot.cronContents ?? "No cron entries.",
    TOPIC_FILES_SECTION: buildTopicSection(snapshot),
    WORKING_DIRS_SECTION: buildWorkingDirsSection(snapshot),
  };

  // Replace ${VAR} patterns
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
  }

  // Warn about unreplaced variables
  const unreplaced = result.match(/\$\{[A-Z_]+\}/g);
  if (unreplaced) {
    logWarn(TAG, `Unreplaced template variables: ${unreplaced.join(", ")}`);
  }

  return result;
}

function buildSnapshotBlock(s: StateSnapshot): string {
  return [
    `- Messages in DB: ${s.dbStats.messageCount}`,
    `- Extracted memories: ${s.dbStats.extractedMemoryCount}`,
    `- Embeddings: ${s.dbStats.embeddingCount}`,
    `- Sessions: ${s.dbStats.sessionCount}`,
    `- Working dirs: ${s.workingDirs.length}`,
    `- Disk: ${(s.diskUsageBytes / 1024 / 1024).toFixed(1)} MB / ${(s.diskBudgetBytes / 1024 / 1024).toFixed(0)} MB`,
  ].join("\n");
}

function buildTopicSection(s: StateSnapshot): string {
  if (s.topicFiles.length === 0) return "No topic files.";
  return s.topicFiles
    .map((t) => `- \`${t.name}\` (${(t.sizeBytes / 1024).toFixed(1)} KB, modified ${t.lastModified.slice(0, 10)})`)
    .join("\n");
}

function buildWorkingDirsSection(s: StateSnapshot): string {
  if (s.workingDirs.length === 0) return "No working directories.";
  return s.workingDirs
    .map((d) => `- \`${d.date}\` (${d.files.length} files)`)
    .join("\n");
}
