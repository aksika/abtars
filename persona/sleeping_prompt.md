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

## §1 Feedback Pass

Review today's conversations for recalled memories that appeared in agent responses. For each extracted memory that was surfaced via `agentbridge-recall`:

1. Read the transcript around where the memory was used
2. Check the user's reaction:
   - **User confirmed or continued the topic** → boost: `agentbridge-store --boost --id <memory_id>`
   - **User corrected or rejected the memory** → demote: `agentbridge-store --demote --id <memory_id>`
   - **Ambiguous or no reaction** → skip (no signal is better than noise)

To find which memories were recalled, search transcripts for `agentbridge-recall` invocations and their JSON output. Each result has a `source` field — entries with `source: "extracted"` or `source: "extracted:original"` are extracted memories.

## §2 Daily Summary

Read the JSONL transcript files for the period between the previous sleep audit and now. Each line is a JSON object with `role`, `content`, and `timestamp` fields.

Summarize into a daily file:
- Output: `~/.agentbridge/memory/daily/daily_${WAKEUP_DATE}.md` (replace hyphens: `daily_YYYYMMDD.md`)
- If the daily file already exists, **read it first**. If it already covers the full window (previous sleep → now), skip. If it only covers a partial window (e.g., written by an earlier run that didn't capture later activity), **overwrite it** with a complete summary covering the full window.
- The date in the filename is the **wake-up date** (date portion of the previous sleep audit), not today's date
- Include: key topics discussed, decisions made, facts learned, action items, emotional highlights
- Exclude: routine greetings, tool execution noise, formatting artifacts, step-by-step reasoning
- Write in English, concise prose, organized chronologically

After the daily file is written, check if rollups are needed:
- If 7+ daily files exist for a completed ISO week → create `~/.agentbridge/memory/weekly/weekly_YYYY-WXX.md`
- If 4+ weekly files exist for a completed quarter → create `~/.agentbridge/memory/quarterly/quarterly_YYYY-QN.md`
- Read source files, summarize, write target file
- Do NOT delete source files

## §3 Reminder & Todo Extraction

Scan the day's transcript for missed reminders and action items. Look for patterns like:
- "remind me", "tomorrow", "later", "don't forget", "need to", "should do"
- "emlékeztess", "holnap", "ne felejtsd", "meg kell", "kellene"

For each found item:
- Run `agentbridge-todo add "<description>"` (if the CLI is available)
- Check the existing todo list first — do not add duplicates

Current todo list:
${TODO_CONTENTS}

## §4 Garbage Collection (Primary Task)

This is the most important maintenance task. Scan ALL messages in `~/.agentbridge/memory/memory.db` and clean up noise.

**Classification rule**: Never process or surface SECRET (classification=3) memories. Use `--max-classification 2` on all recall commands. When storing new extracted memories, assign the correct NATO classification level (0=UNCLASSIFIED, 1=RESTRICTED, 2=CONFIDENTIAL, 3=SECRET). See the classification skill for auto-classification triggers.

### Scan Strategy

First, dump all user messages for review:
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
Delete from the `messages` table any entry whose garbage timestamp is older than 7 days:

```sql
DELETE FROM messages WHERE id IN (<expired_ids>);
```

Remove those entries from `garbage.json` and write the file back.

### Step 2: Immediate deletes (no grace period)

Find and delete directly from the `messages` table:

**Duplicates** — find with:
```sql
SELECT a.id, b.id FROM messages a JOIN messages b
ON a.chat_id = b.chat_id AND a.content = b.content AND a.id < b.id
AND abs(a.timestamp - b.timestamp) < 300000;
```
Keep the first (lowest id), delete the rest + their paired assistant responses.

**Wrong chat** — messages where user says "wrong chat", "rossz chat", or similar. Delete the message, the one before it (the misdirected message), and both their assistant responses.

**Whisper/STT garbage** — garbled transcriptions that make no sense in any language (e.g., "Fønekur og sigtmær", "Týžkuťo.", "tu dotky mohlti"). These are speech-to-text errors. Delete immediately + paired responses.

### Step 3: Emotion harvest + garbage marking

Scan remaining messages for emotional reactions with no informational content. Examples:
- Positive: "fasza!", "király!", "awesome!", "excellent!", "nice!", "Good job professor", "Gracias", "Oh yes!"
- Negative: "a faszomat!", "baszd meg!", "goddamn it!", "fuck!", "for fuck sake"
- Pure reactions: ":D", "😂", exclamations with no info

For each:
1. Identify the nearest relevant message or extracted_memory that the emotion refers to
2. Update its `emotion_score` via `agentbridge-store` (positive reactions: +1 to +3, negative: -1 to -3, scale by intensity)
3. Add the message ID (and its paired assistant response ID) to `garbage.json` with current ISO timestamp

### Step 4: Pure noise marking

Mark as garbage (add to `garbage.json`) messages that carry zero informational content:
- Single-word greetings with no follow-up context: "hi", "hallo", "hello", "hey"
- Pings with no content: "prof", "professor", "vagy prof?", "are you there?", "vagyunk prof?"
- Filler acknowledgments that add nothing: "ja", "igen", "aha", "I see", "jaja"
- Single characters: "a", "?"
- Filler phrases: "Na nézzük", "Alakulsz akkor tesó", "de mar tudod..", "you tell me"

Do NOT mark as garbage:
- Action confirmations: "Approved", "Done", "Yeah, do it", "Ok do it now"
- Instructions: "Check tmux ls", "Run doctor on Molty pls"
- Questions with real content
- Facts or jokes meant to be remembered
- Messages that start a new conversation topic

Always mark both the user message AND its paired assistant response.

### Step 5: Repeated probe marking

Find messages where the same question appears 3+ times:
```sql
SELECT content, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
FROM messages WHERE role='user'
GROUP BY content HAVING cnt >= 3 ORDER BY cnt DESC;
```

For each group: keep the **first occurrence** (lowest id) and its assistant response. Mark ALL subsequent occurrences + their responses as garbage in `garbage.json`.

This applies to memory test probes like "kiskutya?", "ki vagy?", "who are you?", "jelszó?" — the answer is already stored in extracted_memories, repeats have no value.

### Step 6: Verify extractions + mark verbose exchanges

Scan messages that haven't been captured in `extracted_memories`. For each conversation exchange (group of messages on the same topic within a session):

1. Check if the key facts/outcomes are already in `extracted_memories`:
```sql
SELECT id, content_en FROM extracted_memories ORDER BY source_timestamp DESC;
```

2. If an exchange's facts are NOT yet extracted, extract them now using `agentbridge-store`:
```bash
agentbridge-store --content-en "<fact>" --content-original "<original>" --memory-type <TYPE> --emotion-score <SCORE> --chat-id <CHAT_ID> --keyword "<keyword>" --confidence <1-5> --source-ids "<msg_id1,msg_id2>"
```

3. After confirming the facts are stored, garbage-mark the verbose original messages (add to `garbage.json`). Keep 1-2 representative messages if the exchange is historically significant.

**What to extract:** facts, decisions, preferences, events, lessons learned, tool configurations, workflow discoveries.

**What NOT to extract:** greetings, debugging noise (already handled by Steps 2-5), conversations that are purely instructional with no lasting fact.

**Example:** A 10-message exchange about setting up X.com cookies:
- Extract: "X.com access works via Dockerized Patchright browser with cookies from ~/.agentbridge/titok/x-cookies.json. Must start Docker container first."
- Garbage-mark all 10 original messages (facts now live in extracted_memories)

### Step 7: Report

In your sleep audit, include a GC summary:
- Messages immediately deleted (dupes + wrong chat + STT garbage): count
- Messages garbage-marked this cycle: count
- Expired garbage purged: count
- Conversations compacted: count (N messages → 1, per exchange)
- Emotion scores updated: list of (memory_id, old_score → new_score)

### Database Maintenance

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

If a time-specific reminder was found in the transcript (e.g. "remind me Sunday at 2am") but has no corresponding cron entry, log a warning in your response.

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
- **High recall + high relevance** → no action needed (search ranking boost handles surfacing)
- **High recall + negative relevance** → candidate for deletion or rewording. If the fact is wrong, delete it. If it's poorly worded, re-extract with `agentbridge-store` and delete the old one.
- **Zero recall after 60+ days** → candidate for deletion. Check if the fact is still relevant before deleting.
- **Low confidence (1-2) + low recall (0)** → first to prune. Delete unless the content is clearly valuable.

Time-decayed fitness: `fitness ≈ Σ(1 / (1 + days_since_recall))` weighted by relevance_score. Memories with fitness near zero are candidates for pruning.

### Core Knowledge Maintenance

Review `~/.agentbridge/memory/core/user_profile.md` and `~/.agentbridge/memory/core/agent_notes.md`:
- Remove stale or redundant lines
- Keep each file ≤10 lines of high-signal facts only
- These files are injected into every context window — brevity is critical

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

This keeps the newer record, sums recall counts, takes the higher relevance and confidence scores, and deletes the older record.

Rules:
- Max 5 merges per sleep cycle
- Only merge when you're confident both express the same fact
- When in doubt, skip — false merges lose information

## §9 Disk Budget

Current usage: ${DISK_USAGE_MB} MB / ${DISK_BUDGET_MB} MB

If over 80%, flag in your response. Do not auto-delete anything.
