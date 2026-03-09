import type { StateSnapshot, WorkingDirEntry, TopicFileEntry } from "./sleep-state-gatherer.js";

/**
 * Constructs the comprehensive Sleep_Prompt from a StateSnapshot.
 * The prompt is sent to a powerful subagent (Opus 4.6) that executes
 * all maintenance tasks using AgentBridge tools.
 */
export class SleepPromptBuilder {
  build(snapshot: StateSnapshot): string {
    const sections = [
      this.buildHeader(snapshot),
      this.buildWorkingDirSection(snapshot.workingDirs),
      this.buildDbStatsSection(snapshot),
      this.buildFts5HealthSection(snapshot),
      this.buildDiskUsageSection(snapshot),
      this.buildTopicFilesSection(snapshot.topicFiles),
      this.buildDailyConsolidationInstructions(snapshot),
      this.buildDatabaseCleanupInstructions(snapshot),
      this.buildDiskBudgetInstructions(snapshot),
      this.buildTopicReorgInstructions(),
    ];

    return sections.join("\n\n");
  }

  private buildHeader(snapshot: StateSnapshot): string {
    return `# AgentBridge Sleep Maintenance Run

**Current Date/Time:** ${snapshot.timestamp}

You are the AgentBridge maintenance subagent. Your job is to perform overnight memory maintenance using the AgentBridge tools available to you (file read/write, database queries, file deletion, directory operations).

Review the current system state below, then execute each maintenance category in order.`;
  }

  private buildWorkingDirSection(workingDirs: WorkingDirEntry[]): string {
    let section = `## Current System State

### Working Directories (\`~/.agentbridge/memory/working/\`)
`;
    if (workingDirs.length === 0) {
      section += "\nNo working directories found.";
      return section;
    }

    for (const dir of workingDirs) {
      section += `\n**${dir.date}** (\`${dir.path}\`)`;
      if (dir.files.length === 0) {
        section += "\n- (empty directory)";
      } else {
        for (const file of dir.files) {
          section += `\n- \`${file.name}\` — ${this.formatBytes(file.sizeBytes)}`;
        }
      }
    }

    return section;
  }

  private buildDbStatsSection(snapshot: StateSnapshot): string {
    const { dbStats } = snapshot;
    return `### Database Statistics

| Table | Row Count |
|-------|-----------|
| messages | ${dbStats.messageCount} |
| compactions | ${dbStats.compactionCount} |
| embeddings | ${dbStats.embeddingCount} |
| sessions | ${dbStats.sessionCount} |
| extracted_memories | ${dbStats.extractedMemoryCount} |`;
  }

  private buildFts5HealthSection(snapshot: StateSnapshot): string {
    const { fts5Health } = snapshot;
    return `### FTS5 Index Health

| Virtual Table | Status |
|---------------|--------|
| messages_fts | ${fts5Health.messages_fts} |
| extracted_memories_fts | ${fts5Health.extracted_memories_fts} |
| extracted_memories_original_fts | ${fts5Health.extracted_memories_original_fts} |`;
  }

  private buildDiskUsageSection(snapshot: StateSnapshot): string {
    const usageMB = (snapshot.diskUsageBytes / 1024 / 1024).toFixed(1);
    const budgetMB = (snapshot.diskBudgetBytes / 1024 / 1024).toFixed(1);
    const pct = snapshot.diskBudgetBytes > 0
      ? ((snapshot.diskUsageBytes / snapshot.diskBudgetBytes) * 100).toFixed(1)
      : "N/A";

    return `### Disk Usage

- **Current usage:** ${this.formatBytes(snapshot.diskUsageBytes)} (${usageMB} MB)
- **Disk budget:** ${this.formatBytes(snapshot.diskBudgetBytes)} (${budgetMB} MB)
- **Utilization:** ${pct}%`;
  }

  private buildTopicFilesSection(topicFiles: TopicFileEntry[]): string {
    let section = `### Topic Files (\`.agentbridge/topics/\`)
`;
    if (topicFiles.length === 0) {
      section += "\nNo topic files found.";
      return section;
    }

    section += "\n| File Name | Size | Last Modified |";
    section += "\n|-----------|------|---------------|";
    for (const topic of topicFiles) {
      section += `\n| \`${topic.name}\` | ${this.formatBytes(topic.sizeBytes)} | ${topic.lastModified} |`;
    }

    return section;
  }

  private buildDailyConsolidationInstructions(snapshot: StateSnapshot): string {
    const today = snapshot.timestamp.slice(0, 10); // YYYY-MM-DD
    const pastDirs = snapshot.workingDirs.filter((d) => d.date < today);

    let section = `## Maintenance Instructions

### 1. Daily Consolidation

Consolidate past-day working directories into daily files. Process directories in **chronological order** (oldest first).
`;

    if (pastDirs.length === 0) {
      section += "\nNo past-day working directories to consolidate. Skip this section.";
    } else {
      section += `\nDirectories to consolidate (${pastDirs.length}):`;
      for (const dir of pastDirs) {
        section += `\n- \`${dir.date}\` (${dir.files.length} files)`;
      }

      section += `

**Steps for each working directory (in chronological order):**

1. Read all source files within the working directory \`~/.agentbridge/memory/working/{YYYY-MM-DD}/\`.
2. If \`~/.agentbridge/memory/daily/daily_{YYYYMMDD}.md\` already exists, **skip consolidation** for that date and just delete the working directory (it was already consolidated in a previous run).
3. Consolidate (LLM-summarize) all source files into a single daily file at \`~/.agentbridge/memory/daily/daily_{YYYYMMDD}.md\` (note: no hyphens in the date portion of the filename).
4. The daily file should be a coherent summary of all conversations and activities from that day, organized chronologically.
5. After successful consolidation, **delete the entire working directory** for that date.
6. **Never modify or append to an existing daily file** — daily files are immutable once written.
7. After all working directories are consolidated, **trigger the consolidation pipeline rollups** (weekly and quarterly) so that \`~/.agentbridge/memory/weekly/\` and \`~/.agentbridge/memory/quarterly/\` are updated.`;
    }

    return section;
  }

  private buildDatabaseCleanupInstructions(snapshot: StateSnapshot): string {
    const today = snapshot.timestamp.slice(0, 10);
    const { fts5Health } = snapshot;

    return `### 2. Database Cleanup

Perform the following database maintenance tasks in order:

#### 2a. FTS5 Integrity Checks and Repair

Run integrity-check on all three FTS5 virtual tables:
- \`messages_fts\` — current status: **${fts5Health.messages_fts}**
- \`extracted_memories_fts\` — current status: **${fts5Health.extracted_memories_fts}**
- \`extracted_memories_original_fts\` — current status: **${fts5Health.extracted_memories_original_fts}**

For each table:
1. Execute: \`INSERT INTO {table}({table}) VALUES('integrity-check')\`
2. If the integrity-check fails (table is corrupt), **rebuild** the index: \`INSERT INTO {table}({table}) VALUES('rebuild')\`

#### 2b. Orphaned FTS5 Entry Deletion

Delete orphaned FTS5 entries whose corresponding rows in the source tables no longer exist:
- For \`messages_fts\`: delete entries where \`rowid\` does not match any \`rowid\` in \`messages\`
- For \`extracted_memories_fts\`: delete entries where \`rowid\` does not match any \`rowid\` in \`extracted_memories\`
- For \`extracted_memories_original_fts\`: delete entries where \`rowid\` does not match any \`rowid\` in \`extracted_memories\`

#### 2c. Message Pruning

Prune messages from the \`messages\` table that have been compacted into daily, weekly, or quarterly summaries:
- Delete messages that have a corresponding compaction record in the \`compactions\` table
- **Preserve all messages from today (${today})** — do not delete any messages from the current calendar day
- Be conservative: only prune messages that are confirmed compacted

#### 2d. Embeddings Orphan Deletion

Delete rows from the \`embeddings\` table whose \`message_id\` references a row that no longer exists in the \`messages\` table:
\`\`\`sql
DELETE FROM embeddings WHERE message_id NOT IN (SELECT rowid FROM messages);
\`\`\`

#### 2e. Stale Session Deletion

Delete rows from the \`sessions\` table where:
- \`is_active = 0\` (inactive sessions)
- \`last_activity_at\` is older than the configured staleness threshold

#### 2f. Extracted Memories Pruning

Prune old rows from the \`extracted_memories\` table:
- Delete rows older than the configured retention period
- **Preserve** memories that have not yet been processed by the consolidation pipeline

#### 2g. Ingested Documents Cleanup

Clean up stale rows from the \`ingested_documents\` table:
- Delete rows whose corresponding message chunks no longer exist in the \`messages\` table

#### 2h. Extraction Watermarks Cleanup

Clean up stale rows from the \`extraction_watermarks\` table:
- Delete rows whose \`chat_id\` no longer has any active sessions or messages

#### 2i. Optimize Database

After all cleanup tasks are complete, run:
\`\`\`sql
VACUUM;
ANALYZE;
\`\`\`

This reclaims disk space and updates query planner statistics.`;
  }

  private buildDiskBudgetInstructions(snapshot: StateSnapshot): string {
    const overBudget = snapshot.diskUsageBytes > snapshot.diskBudgetBytes;
    const overBy = snapshot.diskUsageBytes - snapshot.diskBudgetBytes;

    let section = `### 3. Disk Budget Enforcement

- **Current disk usage:** ${this.formatBytes(snapshot.diskUsageBytes)}
- **Disk budget:** ${this.formatBytes(snapshot.diskBudgetBytes)}
`;

    if (!overBudget) {
      section += "\nDisk usage is within budget. No action needed for this section.";
    } else {
      section += `
**Disk usage exceeds budget by ${this.formatBytes(overBy)}.** Take the following steps:

1. **Delete the oldest transcript files** from \`~/.agentbridge/memory/daily/\` (oldest \`daily_YYYYMMDD.md\` files first) until total disk usage is within the budget.
2. For each deleted transcript file, **cascade the cleanup** to the database:
   - Remove corresponding entries from the \`messages\` table
   - Remove corresponding entries from the \`embeddings\` table
   - Remove orphaned entries from the FTS5 tables (\`messages_fts\`, \`extracted_memories_fts\`, \`extracted_memories_original_fts\`)
3. Re-check disk usage after each deletion. Stop once usage is within budget.`;
    }

    return section;
  }

  private buildTopicReorgInstructions(): string {
    return `### 4. Topic Reorganization

Review and tidy the topic files in \`.agentbridge/topics/\`:

#### 4a. Merge Duplicates
Identify topic files that cover the same or heavily overlapping subjects. Merge them into a single file:
- Combine the content intelligently (not just concatenation)
- Keep the most recent filename or the most descriptive one
- Delete the redundant files after merging

#### 4b. Update Stale Content
Identify topic files containing stale or outdated content:
- Update them with current information where possible
- If a topic is no longer relevant, mark it for deletion

#### 4c. Delete Empty/Small Topics
Delete topic files that are:
- Empty (0 bytes)
- Contain fewer than **10 words** of meaningful content

#### 4d. Preserve Naming Convention
When merging or updating topic files, preserve the naming convention:
\`\`\`
{SanitizedName}-{YYYY-MM-DD}.md
\`\`\`
- \`SanitizedName\`: PascalCase or kebab-case descriptive name
- \`YYYY-MM-DD\`: the date the topic was created or last significantly updated`;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
}
