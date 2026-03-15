# Sleep Maintenance Prompt

**Date/Time:** ${TIMESTAMP}
**Previous sleep:** ${LAST_SLEEP_AUDIT}
**Day boundary:** ${LAST_SLEEP_AUDIT} → now (this is "yesterday")
**Wake-up date:** ${WAKEUP_DATE}

## State Snapshot

${STATE_SNAPSHOT}

## Transcripts

${TRANSCRIPT_PATHS}

## Working Directories

${WORKING_DIRS_SECTION}

---

## §1 Daily Summary

Read the JSONL transcript files for the period between the previous sleep audit and now. Each line is a JSON object with `role`, `content`, and `timestamp` fields.

Summarize into a daily file:
- Output: `~/.agentbridge/memory/daily/daily_${WAKEUP_DATE}.md` (replace hyphens: `daily_YYYYMMDD.md`)
- If the daily file already exists for this date, **skip** — do not overwrite
- The date in the filename is the **wake-up date** (date portion of the previous sleep audit), not today's date
- Include: key topics discussed, decisions made, facts learned, action items, emotional highlights
- Exclude: routine greetings, tool execution noise, formatting artifacts, step-by-step reasoning
- Write in English, concise prose, organized chronologically

After the daily file is written, check if rollups are needed:
- If 7+ daily files exist for a completed ISO week → create `~/.agentbridge/memory/weekly/weekly_YYYY-WXX.md`
- If 4+ weekly files exist for a completed quarter → create `~/.agentbridge/memory/quarterly/quarterly_YYYY-QN.md`
- Read source files, summarize, write target file
- Do NOT delete source files

## §2 Reminder & Todo Extraction

Scan the day's transcript for missed reminders and action items. Look for patterns like:
- "remind me", "tomorrow", "later", "don't forget", "need to", "should do"
- "emlékeztess", "holnap", "ne felejtsd", "meg kell", "kellene"

For each found item:
- Run `agentbridge-todo add "<description>"` (if the CLI is available)
- Check the existing todo list first — do not add duplicates

Current todo list:
${TODO_CONTENTS}

## §3 Database Maintenance

Run these maintenance tasks on `~/.agentbridge/memory/memory.db`:

### FTS5 Integrity Checks

- `messages_fts` — current status: **${FTS_MESSAGES}**
- `extracted_memories_fts` — current status: **${FTS_EXTRACTED}**
- `extracted_memories_original_fts` — current status: **${FTS_ORIGINAL}**

For each table:
1. Run: `INSERT INTO {table}({table}) VALUES('integrity-check')`
2. If corrupt, rebuild: `INSERT INTO {table}({table}) VALUES('rebuild')`

### Orphan Cleanup

- Delete orphaned FTS entries (rowid not in source table)
- Delete orphaned embeddings (`message_id` not in `messages`)
- Delete stale sessions (`is_active = 0` with old `last_activity_at`)

### ⚠️ CRITICAL SAFETY RULE

**DO NOT delete any rows from the `messages` or `chat_backup` tables.**
Message retention is handled by wired startup logic, not this routine.
This rule is absolute — no exceptions, no "cleanup", no "pruning" of messages.

## §4 Cron Verification

Cross-check any time-specific reminders found in §2 against existing cron entries.

Current cron entries:
${CRON_CONTENTS}

If a time-specific reminder was found in the transcript (e.g. "remind me Sunday at 2am") but has no corresponding cron entry, log a warning in your response.

## §5 Topic Reorg

Review topic files for staleness or merge opportunities:

${TOPIC_FILES_SECTION}

## §6 Disk Budget

Current usage: ${DISK_USAGE_MB} MB / ${DISK_BUDGET_MB} MB

If over 80%, flag in your response. Do not auto-delete anything.
