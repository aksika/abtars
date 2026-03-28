# Sleep Maintenance Prompt

**Date/Time:** ${TIMESTAMP}
**Previous sleep:** ${LAST_SLEEP_AUDIT}
**Day boundary:** ${LAST_SLEEP_AUDIT} → now (this is "yesterday")
**Wake-up date:** ${WAKEUP_DATE}

## State Snapshot

${STATE_SNAPSHOT}

## Messages Source

All messages are in `~/.agentbridge/memory/memory.db` (SQLite). Query with:
```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT id, role, substr(content,1,120), timestamp, emotion_score FROM messages ORDER BY timestamp;"
```

## Working Directories

${WORKING_DIRS_SECTION}

---

## §1 Retrospective (BEFORE any GC)

Read the full messages table for the period since last sleep. This must happen FIRST — before any garbage collection deletes messages.

```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT role, content, emotion_score FROM messages WHERE timestamp > ${LAST_SLEEP_TS} ORDER BY timestamp;"
```

Answer these 5 questions honestly and write to `~/.agentbridge/memory/retrospectives/retro_${WAKEUP_DATE}.md`:

1. **What went well?** — Conversations where I was helpful, accurate, or efficient. What patterns worked?
2. **What went wrong?** — Misunderstandings, errors, wasted effort, frustrated user reactions (check emotion_score < 0). What failed?
3. **How can I improve?** — Concrete behavioral changes for tomorrow. Not vague aspirations.
4. **Emotional attribution** — For negative moments: was it my fault (wrong answer, slow, misunderstood) or external (unclear request, changed requirements, tool failure)? Be honest — don't blame externals when I was wrong.
5. **What did I learn?** — New facts, preferences, workflows, or corrections from the user.

After writing the retro file, update `~/.agentbridge/memory/core/agent_notes.md` with any actionable lessons (max 10 lines total in that file — replace stale entries).

Create the retrospectives directory if it doesn't exist:
```bash
mkdir -p ~/.agentbridge/memory/retrospectives
```

## §2 Feedback Pass

Review today's conversations for recalled memories that appeared in agent responses. For each extracted memory that was surfaced via `agentbridge-recall`:

1. Check the user's reaction:
   - **User confirmed or continued the topic** → boost: `agentbridge-store --boost --id <memory_id>`
   - **User corrected or rejected the memory** → demote: `agentbridge-store --demote --id <memory_id>`
   - **Ambiguous or no reaction** → skip (no signal is better than noise)

Search messages for `agentbridge-recall` invocations. Each result has a `source` field — entries with `source: "extracted"` or `source: "extracted:original"` are extracted memories.

## §3 Reminder & Todo Extraction

Scan the day's messages for missed reminders and action items. Look for patterns like:
- "remind me", "tomorrow", "later", "don't forget", "need to", "should do"
- "emlékeztess", "holnap", "ne felejtsd", "meg kell", "kellene"

For each found item:
- Run `agentbridge-todo add "<description>"` (if the CLI is available)
- Check the existing todo list first — do not add duplicates

Current todo list:
${TODO_CONTENTS}

## §4 Garbage Collection

This is the most important maintenance task. Scan ALL messages in the DB and clean up noise.

**Classification rule**: Never process or surface SECRET (classification=3) memories. Use `--max-classification 2` on all recall commands. When storing new extracted memories, assign the correct NATO classification level (0=UNCLASSIFIED, 1=RESTRICTED, 2=CONFIDENTIAL, 3=SECRET).

### Scan Strategy

Dump all user messages for review:
```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT id, substr(content,1,100) FROM messages WHERE role='user' ORDER BY id;"
```
Classify each into: KEEP, GARBAGE, DUPE, or WRONG_CHAT. Then execute the steps below.

For any message you mark or delete, always include its paired assistant response:
```sql
SELECT id FROM messages WHERE id > <user_msg_id> AND role='assistant' ORDER BY id LIMIT 1;
```

### Step 1: Purge expired garbage

Read `~/.agentbridge/memory/garbage.json` (create `{}` if missing). Format: `{"<message_id>": "<ISO timestamp>"}`.
Delete any entry whose garbage timestamp is older than 7 days:

```bash
agentbridge-store --delete-ids <comma_separated_ids> --chat-id <chat_id>
```

Remove those entries from `garbage.json` and write the file back.

### Step 2: Immediate deletes (no grace period)

Find and cascade-delete directly using `agentbridge-store --delete-ids`:

**Duplicates** — find with:
```sql
SELECT a.id, b.id FROM messages a JOIN messages b
ON a.chat_id = b.chat_id AND a.content = b.content AND a.id < b.id
AND abs(a.timestamp - b.timestamp) < 300000;
```
Keep the first (lowest id), delete the rest + their paired assistant responses.

**Wrong chat** — messages where user says "wrong chat", "rossz chat", or similar. Delete the message, the one before it (the misdirected message), and both their assistant responses.

**Whisper/STT garbage** — garbled transcriptions that make no sense in any language (e.g., "Fønekur og sigtmær", "Týžkuťo.", "tu dotky mohlti"). These are speech-to-text errors. Delete immediately + paired responses.

### Step 3: Repeated probes

Find messages where the same question appears 3+ times:
```sql
SELECT content, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
FROM messages WHERE role='user'
GROUP BY content HAVING cnt >= 3 ORDER BY cnt DESC;
```

For each group: keep the **first occurrence** (lowest id) and its assistant response. Mark ALL subsequent occurrences + their responses as garbage in `garbage.json`.

This applies to memory test probes like "kiskutya?", "ki vagy?", "who are you?", "jelszó?" — the answer is already stored in extracted_memories, repeats have no value.

### Step 4: Noise marking (grace period)

Mark as garbage (add to `garbage.json`) messages that carry zero informational content:
- Single-word greetings with no follow-up context: "hi", "hallo", "hello", "hey"
- Pings with no content: "prof", "professor", "vagy prof?", "are you there?"
- Filler acknowledgments: "ja", "igen", "aha", "I see", "jaja"
- Single characters: "a", "?"
- Filler phrases: "Na nézzük", "Alakulsz akkor tesó", "de mar tudod.."

Do NOT mark as garbage:
- Action confirmations: "Approved", "Done", "Yeah, do it", "Ok do it now"
- Instructions: "Check tmux ls", "Run doctor on Molty pls"
- Questions with real content
- Facts or jokes meant to be remembered
- Messages that start a new conversation topic

Always mark both the user message AND its paired assistant response.

### Step 5: Verify extractions + mark verbose exchanges

Scan messages that haven't been captured in `extracted_memories`. For each conversation exchange:

1. Check if the key facts/outcomes are already in `extracted_memories`:
```sql
SELECT id, content_en FROM extracted_memories ORDER BY source_timestamp DESC;
```

2. If NOT yet extracted, extract now:
```bash
agentbridge-store --translated "<fact>" --original "<original>" --memory-type <TYPE> --emotion-score <SCORE> --chat-id <CHAT_ID> --keyword "<keyword>" --confidence <1-5> --source-ids "<msg_id1,msg_id2>" --trust 2 --integrity 2 --credibility 2
```

3. After confirming facts are stored, garbage-mark the verbose original messages.

**What to extract:** facts, decisions, preferences, events, lessons learned, tool configurations, workflow discoveries.
**What NOT to extract:** greetings, debugging noise, conversations that are purely instructional with no lasting fact.

### Step 6: Emotion harvest (verbal only)

Scan remaining messages for verbal emotional reactions with no informational content. Examples:
- Positive: "fasza!", "király!", "awesome!", "excellent!", "nice!", "Good job professor"
- Negative: "a faszomat!", "baszd meg!", "goddamn it!", "fuck!", "for fuck sake"

**Note:** Emoji reactions are already handled at runtime — they propagate to extracted_memories immediately. This step is for VERBAL emotions only.

For each:
1. Identify the nearest relevant message or extracted_memory that the emotion refers to
2. Update its `emotion_score` via `agentbridge-store` (positive: +1 to +3, negative: -1 to -3)
3. Add the message ID (and its paired assistant response ID) to `garbage.json`

### Step 7: Flush old messages

Delete all messages older than 24 hours. By this point, all valuable content has been:
- Extracted to `extracted_memories` (step 5)
- Summarized in the daily file (§9)
- Captured in the retrospective (§1)

```bash
agentbridge-store --delete-ids $(sqlite3 ~/.agentbridge/memory/memory.db "SELECT GROUP_CONCAT(id) FROM messages WHERE timestamp < $(date -d '24 hours ago' +%s%3N);") --chat-id <chat_id>
```

If the above is complex, use direct SQL:
```sql
sqlite3 ~/.agentbridge/memory/memory.db "DELETE FROM messages WHERE timestamp < $(date -d '24 hours ago' +%s%3N);"
```

### Database Maintenance

Run these maintenance commands:

```bash
# WAL checkpoint — prevents unbounded WAL growth
sqlite3 ~/.agentbridge/memory/memory.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

If any FTS5 index above shows **corrupt**:
```bash
# Rebuild the corrupt index (replace TABLE_NAME with the corrupt one)
sqlite3 ~/.agentbridge/memory/memory.db "INSERT INTO TABLE_NAME(TABLE_NAME) VALUES('rebuild');"
```

If embeddings show missing count > 0 and `EMBEDDING_ENABLED=true`:
```bash
EMBEDDING_ENABLED=true agentbridge-embed
```

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

## §5 Cron Verification

Cross-check any time-specific reminders found in §3 against existing cron entries.

Current cron entries:
${CRON_CONTENTS}

If a time-specific reminder was found but has no corresponding cron entry, log a warning.

## §6 Topic Reorg

Review topic files for staleness or merge opportunities:

${TOPIC_FILES_SECTION}

## §7 Fitness Review

Review extracted memories using Darwinism signals from the state snapshot (`dbStats.darwinism`).

Query the full picture:
```sql
SELECT id, substr(content_en,1,80), recall_count, relevance_score, confidence, classification, last_recalled_at, created_at
FROM extracted_memories WHERE classification < 3 ORDER BY recall_count DESC LIMIT 50;
```

Apply these rules:
- **High recall + high relevance** → no action needed
- **High recall + negative relevance** → candidate for deletion or rewording
- **Zero recall after 60+ days** → candidate for deletion
- **Low confidence (1-2) + low recall (0)** → first to prune

### Core Knowledge Maintenance

Review `~/.agentbridge/memory/core/user_profile.md` and `~/.agentbridge/memory/core/agent_notes.md`:
- Remove stale or redundant lines
- Keep each file ≤10 lines of high-signal facts only
- These files are injected into every context window — brevity is critical

### Translation Quality Check

Scan for memories where `content_en` contains untranslated foreign words:
```sql
SELECT id, substr(content_en,1,100), substr(content_original,1,100)
FROM extracted_memories
WHERE content_en != content_original AND content_original IS NOT NULL
ORDER BY id DESC LIMIT 20;
```

For each result: if `content_en` contains non-English words that should have been translated, fix with:
```sql
UPDATE extracted_memories SET content_en = '<corrected English>', embedding = NULL WHERE id = <N>;
```
Setting `embedding = NULL` ensures re-embedding on next batch-embed run.

## §8 Memory Merge

Review the top most-recalled extracted memories for near-duplicates:

```sql
SELECT id, content_en, recall_count, relevance_score
FROM extracted_memories WHERE recall_count > 0 ORDER BY recall_count DESC LIMIT 30;
```

For each pair that expresses the same fact in different words:
```bash
agentbridge-store --merge --merge-ids <id_A>,<id_B>
```

Rules:
- Max 5 merges per sleep cycle
- Only merge when confident both express the same fact
- When in doubt, skip — false merges lose information

## §9 Consolidation

Summarize today's messages into a daily file:
- Output: `~/.agentbridge/memory/daily/daily_${WAKEUP_DATE}.md` (format: `daily_YYYYMMDD.md`)
- If the daily file already exists and covers the full window, skip. If partial, overwrite.
- The date in the filename is the **wake-up date** (date portion of the previous sleep audit)
- Include: key topics discussed, decisions made, facts learned, action items, emotional highlights
- Exclude: routine greetings, tool execution noise, formatting artifacts
- **Classification**: Before writing any memory into the summary, check its classification level. Replace CONFIDENTIAL (2) and SECRET (3) content with `<REDACTED — classification N>`. The fact that a topic was discussed can be mentioned, but not the content itself.
- Write in English, concise prose, organized chronologically

Source data — query messages for the sleep window:
```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT role, content FROM messages WHERE timestamp > ${LAST_SLEEP_TS} AND timestamp <= ${CURRENT_TS} ORDER BY timestamp;"
```

After the daily file is written, check if rollups are needed:
- If 7+ daily files exist for a completed ISO week → create `~/.agentbridge/memory/weekly/weekly_YYYY-WXX.md`
- If 4+ weekly files exist for a completed quarter → create `~/.agentbridge/memory/quarterly/quarterly_YYYY-QN.md`
- Read source files, summarize, write target file
- Do NOT delete source files

## §9.5 Media Cleanup

Check `~/.agentbridge/received/` total size:
```bash
du -sb ~/.agentbridge/received/ 2>/dev/null | awk '{print $1}'
```

If total > 100MB (104857600 bytes), delete oldest files first (FIFO by modification time) until under 100MB:
```bash
find ~/.agentbridge/received/ -type f -printf '%T@ %p\n' | sort -n | head -20
```
Delete from the top of that list until the total is under budget.

For any images in `received/media/` that were received today and not yet described in the transcript:
- Read the image and generate a brief description
- Store as extracted memory via `agentbridge-store --translated "Photo: <description>" --chat-id <chatId> --type fact`

## §10 Report

In your sleep audit (`~/.agentbridge/memory/audit/sleep_YYYYMMDD_HHmmss.md`), include:

- **Retrospective:** written to `retrospectives/retro_YYYYMMDD.md` (yes/no, key insight)
- **Feedback:** memories boosted/demoted (count)
- **Todos:** items added (count)
- **GC summary:**
  - Messages immediately deleted (dupes + wrong chat + STT): count
  - Messages garbage-marked this cycle: count
  - Expired garbage purged: count
  - Conversations compacted (N messages → 1 extracted): count
  - Emotion scores updated: list of (memory_id, old → new)
- **Messages flushed:** count (>24h old)
- **Consolidation:** daily file written (yes/no), rollups created
- **Fitness:** memories pruned/merged (count)
- **Disk:** ${DISK_USAGE_MB} MB / ${DISK_BUDGET_MB} MB (flag if >80%)
