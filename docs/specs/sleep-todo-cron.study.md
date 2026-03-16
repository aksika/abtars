# Sleep Cycle Rewrite + Todo + Internal Cron

## Problem Statement

The sleep agent (LLM) deleted 119 messages from the `messages` table that weren't actually compacted, causing total recall failure. CompactionEngine is redundant middleware (two LLM passes for the same data). The heartbeat/sleep trigger logic is overcomplicated. No todo or reminder system exists.

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Message safety | `chat_backup` table, wired 7-day retention | LLM must never control message deletion |
| CompactionEngine | Fully remove | Sleep agent reads JSONL directly, handles all rollups |
| Sleep prompt | `sleeping_prompt.md` template file | Editable without rebuild |
| Day boundary | Previous sleep audit timestamp | "Yesterday" = wake-up to sleep, not midnight |
| Daily file date | Wake-up date | `daily_20260314.md` even if sleep was at 01:44 on Mar 15 |
| Sleep trigger | Startup always + cron (≥8am, 10min idle, once/day) | Simple, predictable |
| Messages during sleep | Auto-reply "waking up" + queue, process after | Good UX, no lost messages |
| Cron reminders | Queue file → agent personality | ~5min precision is fine |
| Cron tasks | Subagent → plain TG report | No personality needed for task reports |
| Dead tests | Delete alongside dead code | Keep test suite clean |

---

## Job 1: Sleep Cycle Rewrite

### Task 1.1: `chat_backup` table + wired retention

**Files to modify:**
- `src/components/memory-db.ts` — add `chat_backup` table schema
- `src/components/memory-manager.ts` — insert into `chat_backup` in `recordMessage()`, add `pruneBackup()` called from `initialize()`
- `src/cli/agentbridge-recall.ts` — add Stage 8: LIKE search on `chat_backup`

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS chat_backup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_backup_chat_ts
  ON chat_backup(chat_id, timestamp);
```

**Wired logic in `initialize()`:**
```typescript
private pruneBackup(): void {
  if (!this.db) return;
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  this.db.prepare("DELETE FROM chat_backup WHERE timestamp < ?").run(cutoff);
}
```

**Status:** Partially done in working tree. Needs: tests deleted for removed code, build verification.

### Task 1.2: Remove CompactionEngine

**Files to delete:**
- `src/components/compaction-engine.ts`
- `src/components/compaction-engine.test.ts`
- `src/components/daily-compaction-task.ts`
- `src/components/daily-compaction-task.test.ts`
- `src/components/sleep-cycle-runner.ts`
- `src/components/sleep-cycle-runner.test.ts` (if exists)

**Files to modify:**
- `src/components/memory-manager.ts` — remove all CompactionEngine imports and usage:
  - Remove `import { CompactionEngine }`
  - Remove `autoCompactIfNeeded()` method
  - Remove `compactSession()` method
  - Remove `runConsolidation()` method
  - Remove CompactionEngine instantiation in `initialize()`
  - Remove shutdown compaction in `close()`
- `src/components/reflection-engine.ts` — remove CompactionEngine dependency (it uses it for consolidation — move rollup logic to sleep agent)

**What stays:** The `compactions` table in the DB stays (historical data). `agentbridge-recall` Stage 7 still searches it.

### Task 1.3: `sleeping_prompt.md` template

**New file:** `persona/sleeping_prompt.md`

**Sections:**

```markdown
# Sleep Maintenance Prompt

**Date/Time:** ${TIMESTAMP}
**Previous sleep:** ${LAST_SLEEP_AUDIT}
**Day boundary:** ${LAST_SLEEP_AUDIT} → now (this is "yesterday")

## State Snapshot
${STATE_SNAPSHOT}

## §1 Daily Summary

Read the JSONL transcript files for the period between the previous sleep
audit (${LAST_SLEEP_AUDIT}) and now. Summarize into a daily file.

- Transcript path: ~/.agentbridge/memory/transcripts/
- Output: ~/.agentbridge/memory/daily/daily_${WAKEUP_DATE}.md
- Date in filename = wake-up date (date portion of ${LAST_SLEEP_AUDIT})
- If daily file already exists for this date, skip
- Include: key topics, decisions, facts, action items, emotional highlights
- Exclude: routine greetings, tool noise, formatting

## §2 Reminder & Todo Extraction

Scan the day's transcript for missed reminders and action items:
- Patterns: "remind me", "tomorrow", "later", "don't forget",
  "emlékeztess", "holnap", "ne felejtsd"
- For each found: run `agentbridge-todo add "<description>"`
- Check existing todo.md first — don't duplicate

Current todo list:
${TODO_CONTENTS}

## §3 Database Maintenance

Run these maintenance tasks on ~/.agentbridge/memory/memory.db:

**FTS5 integrity checks:**
- messages_fts — status: ${FTS_MESSAGES}
- extracted_memories_fts — status: ${FTS_EXTRACTED}
- extracted_memories_original_fts — status: ${FTS_ORIGINAL}
If corrupt, rebuild: INSERT INTO {table}({table}) VALUES('rebuild')

**Orphan cleanup:**
- Delete orphaned FTS entries (rowid not in source table)
- Delete orphaned embeddings (message_id not in messages)
- Delete stale sessions (is_active=0, old last_activity_at)

**⚠️ DO NOT delete any rows from the `messages` or `chat_backup` tables.**
Message retention is handled by wired startup logic, not this routine.

## §4 Cron Verification

Cross-check time-specific reminders found in §2 against cron entries.

Current cron entries:
${CRON_CONTENTS}

If a time-specific reminder was found in the transcript but has no
corresponding cron entry, log a warning in the audit output.

## §5 Weekly & Quarterly Rollups

Consolidate daily summaries into higher tiers:
- If 7+ daily files exist for a completed ISO week → create
  ~/.agentbridge/memory/weekly/weekly_YYYY-WXX.md
- If 4+ weekly files exist for a completed quarter → create
  ~/.agentbridge/memory/quarterly/quarterly_YYYY-QN.md
- Read source files, LLM-summarize, write target file
- Do NOT delete source files (they serve as backup)

## §6 Topic Reorg

${TOPIC_FILES_SECTION}

## §7 Disk Budget

Current usage: ${DISK_USAGE_MB} MB / ${DISK_BUDGET_MB} MB
If over 80%, flag in audit output. Do not auto-delete.
```

**Files to modify:**
- `src/components/sleep-prompt-builder.ts` — replace class with template loader:
  - Read `sleeping_prompt.md` from `~/.agentbridge/` (deployed) or `persona/` (dev)
  - Replace `${VARIABLES}` with values from `StateSnapshot`
- `src/components/sleep-state-gatherer.ts` — add to `StateSnapshot`:
  - `lastSleepAudit: string` (ISO timestamp from latest audit file)
  - `wakeupDate: string` (YYYY-MM-DD derived from last sleep audit)
  - `todoContents: string` (raw contents of `todo.md`)
  - `cronContents: string` (raw contents of `cron.json`)
  - `transcriptPaths: Array<{chatId: number, path: string, messageCount: number}>`
- `scripts/deploy.sh` — add `sleeping_prompt.md` to deployment

### Task 1.4: Simplify heartbeat + sleep trigger

**Files to modify:**
- `src/components/sleep-trigger.ts` — simplify:
  - `shouldRunOnStartup()` → always returns `true`
  - `shouldRunFromCron(lastMessageTs)` → 3 checks:
    1. `new Date().getHours() >= 8`
    2. `Date.now() - lastMessageTs >= 10 * 60 * 1000`
    3. No audit file exists for today's date
  - Remove `sleepIntervalHours`, `morningThresholdHour` config
  - Remove `hasUnconsolidatedYesterday()`
- `src/components/memory-manager.ts` — heartbeat `startHeartbeat()`:
  - Keep sleep-trigger task only
  - Keep 5min interval (already default 300000ms)
  - Remove old `SleepTrigger` config complexity

### Task 1.5: "Waking up" auto-reply + message queue

**Files to modify:**
- `src/main.ts` — add sleep state management:
  - `let sleepInProgress = true` flag
  - When message arrives during sleep:
    - Send auto-reply: "Oh good morning, I am just waking up, give me a minute please.. I answer you soon"
    - Push message to `pendingMessages: Array<{chatId, text, ...}>`
  - When sleep finishes (child process exit):
    - Set `sleepInProgress = false`
    - Process all `pendingMessages` through the agent sequentially

### Task 1.6: Cleanup

**Files to delete:**
- `src/components/sleep-prompt-builder.ts` (replaced by template loader)
- `src/components/sleep-prompt-builder.test.ts`

**Files to modify:**
- `src/cli/agentbridge-sleep.ts` — use template loader instead of `SleepPromptBuilder`

---

## Job 2: Todo List

### Task 2.1: `agentbridge-todo` CLI

**New file:** `src/cli/agentbridge-todo.ts`

**Commands:**
```bash
agentbridge-todo add "Export X/Twitter session cookies"
agentbridge-todo list
agentbridge-todo done 3          # mark line 3 as done
agentbridge-todo remove 3        # remove line 3
```

**File format** (`~/.agentbridge/memory/todo.md`):
```markdown
# Todo List

- [ ] 2026-03-15: Export X/Twitter session cookies for authenticated access
- [ ] 2026-03-15: Investigate daily report (napi jelentés) not functioning
- [x] 2026-03-14: Fix browser socket permissions
```

**Implementation:**
- Read/write `~/.agentbridge/memory/todo.md`
- `add`: append `- [ ] YYYY-MM-DD: <description>` with today's date
- `list`: print file contents to stdout
- `done <N>`: replace `- [ ]` with `- [x]` on line N
- `remove <N>`: delete line N
- Create file if it doesn't exist

### Task 2.2: Todo skill steering

**New file:** `skills/todo/SKILL.md`

```markdown
---
name: todo
description: Manage a persistent todo list
user-invocable: false
---

# Todo Skill

Manage a persistent todo list via shell commands.

## Commands

- `agentbridge-todo add "description"` — add new item
- `agentbridge-todo list` — show all items
- `agentbridge-todo done <line>` — mark as complete
- `agentbridge-todo remove <line>` — delete item

## When to use

- User says "remind me", "don't forget", "add to my list", "todo"
- User asks "what's on my list", "what do I need to do"
- After completing a task the user previously asked to track

## When NOT to use

- For time-specific reminders (use agentbridge-cron instead)
- For facts/preferences (use agentbridge-store instead)
```

### Task 2.3: Deploy wiring

**Files to modify:**
- `scripts/deploy.sh` — add `agentbridge-todo` CLI wrapper + skill deployment
- `package.json` — add build entry if needed

---

## Job 3: Internal Cron

### Task 3.1: `agentbridge-cron` CLI

**New file:** `src/cli/agentbridge-cron.ts`

**Commands:**
```bash
agentbridge-cron add --at "2026-03-16T08:00" --message "Remind user about cookies" --chat-id 7773842843 --type reminder
agentbridge-cron add --at "2026-03-16T14:00" --message "Check email for invoices" --chat-id 7773842843 --type task
agentbridge-cron list
agentbridge-cron remove <id>
```

**File format** (`~/.agentbridge/memory/cron.json`):
```json
[
  {
    "id": "a1b2c3",
    "fireAt": 1773580800000,
    "message": "Remind user about cookies",
    "chatId": 7773842843,
    "type": "reminder",
    "fired": false,
    "createdAt": 1773535000000
  }
]
```

**Implementation:**
- Read/write `~/.agentbridge/memory/cron.json`
- `add`: parse `--at` as ISO date → epoch ms, generate random 6-char hex id, append entry
- `list`: print pending (unfired) entries
- `remove`: delete entry by id

### Task 3.2: Heartbeat cron checker

**Files to modify:**
- `src/components/memory-manager.ts` — add second heartbeat task `cron-checker`:
  - Every 5min tick: read `cron.json`
  - For each entry where `fireAt <= Date.now()` and `fired === false`:
    - If `type === "reminder"`: write to `~/.agentbridge/memory/pending_reminders.json`
    - If `type === "task"`: spawn subagent (separate kiro-cli process) with the task message, on completion send plain TG report via Telegram API
    - Mark entry as `fired: true` in `cron.json`

### Task 3.3: Pending reminders pickup

**Files to modify:**
- `src/main.ts` — in the message processing loop:
  - Before processing user messages, check `pending_reminders.json`
  - If entries exist: inject each as a synthetic system message → agent responds naturally
  - Clear the file after processing

**Pending reminders format** (`~/.agentbridge/memory/pending_reminders.json`):
```json
[
  {"chatId": 7773842843, "message": "Reminder: Export X/Twitter session cookies", "createdAt": 1773580800000}
]
```

### Task 3.4: Task subagent + TG report

**Files to modify:**
- `src/components/memory-manager.ts` or new `src/components/cron-executor.ts`:
  - Spawn separate kiro-cli ACP process for task execution
  - On completion: send plain English report via Telegram API directly
  - Report format: "✅ Cron task completed: <message>\n\n<result summary>"

### Task 3.5: Cron skill steering

**New file:** `skills/cron/SKILL.md`

```markdown
---
name: cron
description: Schedule time-based reminders and tasks
user-invocable: false
---

# Cron Skill

Schedule time-based reminders and tasks via shell commands.

## Commands

- `agentbridge-cron add --at "YYYY-MM-DDTHH:MM" --message "..." --chat-id <ID> --type reminder|task`
- `agentbridge-cron list` — show pending entries
- `agentbridge-cron remove <id>` — cancel a scheduled entry

## Types

- `reminder`: fires as a message through the agent personality
- `task`: spawns a subagent to execute, sends plain report via TG

## When to use

- User says "remind me at 3pm", "Sunday at 2am do X", specific time references
- User asks to schedule a recurring check or action

## When NOT to use

- For vague "remind me later/tomorrow" without specific time (use agentbridge-todo)
- For immediate actions (just do them now)
```

### Task 3.6: Deploy wiring

**Files to modify:**
- `scripts/deploy.sh` — add `agentbridge-cron` CLI wrapper + skill deployment

---

## Execution Order

1. **Task 1.1** — `chat_backup` (safety net first)
2. **Task 1.2** — Remove CompactionEngine
3. **Task 2.1 + 2.2** — Todo CLI + skill (needed by sleep prompt)
4. **Task 3.1** — Cron CLI (needed by sleep prompt)
5. **Task 1.3** — `sleeping_prompt.md` template
6. **Task 1.4** — Simplify heartbeat + sleep trigger
7. **Task 1.5** — "Waking up" auto-reply + queue
8. **Task 1.6** — Cleanup dead code
9. **Task 3.2 + 3.3** — Heartbeat cron checker + pending reminders pickup
10. **Task 3.4 + 3.5** — Task subagent + cron skill
11. **Task 2.3 + 3.6** — Deploy wiring for all new CLIs + skills
12. **Full build + test** — verify everything compiles, existing tests pass

## Files Summary

**New files:**
- `persona/sleeping_prompt.md`
- `src/cli/agentbridge-todo.ts`
- `src/cli/agentbridge-cron.ts`
- `src/components/cron-executor.ts` (optional, could be inline)
- `skills/todo/SKILL.md`
- `skills/cron/SKILL.md`

**Files to delete:**
- `src/components/compaction-engine.ts`
- `src/components/compaction-engine.test.ts`
- `src/components/daily-compaction-task.ts`
- `src/components/daily-compaction-task.test.ts`
- `src/components/sleep-cycle-runner.ts`
- `src/components/sleep-cycle-runner.test.ts` (if exists)
- `src/components/sleep-prompt-builder.ts`
- `src/components/sleep-prompt-builder.test.ts`

**Files to modify:**
- `src/components/memory-db.ts` — chat_backup schema
- `src/components/memory-manager.ts` — backup insert, pruneBackup, remove CompactionEngine, heartbeat cron task
- `src/cli/agentbridge-recall.ts` — Stage 8 backup search
- `src/cli/agentbridge-sleep.ts` — template loader
- `src/components/sleep-state-gatherer.ts` — expanded snapshot
- `src/components/sleep-trigger.ts` — simplified logic
- `src/components/reflection-engine.ts` — remove CompactionEngine dep
- `src/main.ts` — sleep flag, auto-reply, message queue, pending reminders
- `scripts/deploy.sh` — new CLIs + skills + sleeping_prompt.md
