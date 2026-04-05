import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../../paths.js";
import type { StateSnapshot } from "./sleep-state-gatherer.js";
import { logDebug } from "../../components/logger.js";
import { localDate } from "../../components/env-utils.js";

const TAG = "sleep-prompt-loader";

/** Build the variable map used for template substitution. */
export function buildSleepVars(snapshot: StateSnapshot): Record<string, string> {
  const now = new Date();
  const dateStr = localDate().replace(/-/g, "");
  const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, "");
  return {
    TIMESTAMP: snapshot.timestamp,
    LAST_SLEEP_AUDIT: snapshot.lastSleepAudit ?? "none",
    LAST_SLEEP_TS: snapshot.lastSleepTimestamp ? String(snapshot.lastSleepTimestamp) : "0",
    CURRENT_TS: String(Date.now()),
    WAKEUP_DATE: snapshot.wakeupDate ?? localDate(),
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
    AUDIT_FILENAME: `${dateStr}_${timeStr}`,
  };
}

/** Apply variable substitution to a template string. */
export function substituteVars(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
  }
  const unreplaced = result.match(/\$\{[A-Z_]+\}/g);
  if (unreplaced) logDebug(TAG, `Unreplaced template variables: ${unreplaced.join(", ")}`);
  return result;
}

/** A single sleep step definition. */
export interface SleepStep {
  name: string;
  filename: string;
  prompt: string;
  skippable: boolean;
}

/**
 * Load all sleep step files from persona/sleep/ directory.
 * Returns ordered steps with variable-substituted prompts.
 */
export function loadSleepSteps(snapshot: StateSnapshot): SleepStep[] {
  const sleepDir = join(agentBridgeHome(), "prompts", "sleep");
  if (!existsSync(sleepDir)) {
    throw new Error(`Sleep step directory not found at ${sleepDir}`);
  }

  const vars = buildSleepVars(snapshot);
  const files = readdirSync(sleepDir).filter(f => f.endsWith(".md")).sort();
  return files.map(filename => {
    const raw = readFileSync(join(sleepDir, filename), "utf-8");
    return {
      name: filename.replace(/^\d+-/, "").replace(/\.md$/, ""),
      filename,
      prompt: substituteVars(raw, vars),
      skippable: !filename.startsWith("00-") && !filename.startsWith("14-"),
    };
  });
}

/**
 * Load sleeping_prompt.md template and inject state snapshot variables.
 * @deprecated Use loadSleepSteps() for multi-turn sleep.
 */
export function loadSleepPrompt(snapshot: StateSnapshot): string {
  const path = join(agentBridgeHome(), "prompts", "sleeping_prompt.md");

  if (!existsSync(path)) {
    throw new Error(`sleeping_prompt.md not found at ${path}`);
  }
  const template = readFileSync(path, "utf-8");
  return substituteVars(template, buildSleepVars(snapshot));
}

function buildSnapshotBlock(s: StateSnapshot): string {
  return [
    `- Messages in DB: ${s.dbStats.messageCount}`,
    `- Extracted memories: ${s.dbStats.extractedMemoryCount}`,
    `- Embeddings: ${s.dbStats.embeddingCount}/${s.dbStats.extractedMemoryCount}${s.dbStats.nullEmbeddingCount > 0 ? ` (${s.dbStats.nullEmbeddingCount} missing)` : ""}`,
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
