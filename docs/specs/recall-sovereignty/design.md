# Recall Sovereignty — Design

## Architecture Change

```
BEFORE (bridge-driven, broken):
  User msg → Bridge assembles [RECALLED MEMORIES] on every msg → sends to Kiro
  (Bridge decides when to recall — gets it wrong on generic messages)

AFTER (agent-driven):
  User msg → Bridge sends [CONVERSATION] + [INPUT] only → Kiro
  Kiro thinks: "This doesn't make sense. Let me search memory."
  Kiro runs: agentbridge-recall --keywords "kiskutya,puppy" --chat-id 7773842843
  Kiro gets results → responds with context
```

## Components

### 1. ContextAssembler (modified)

Assembly order (updated):
1. Soul + User Core Facts (system prompt + user_core_facts.md)
2. Scratchpad
3. **Last Session Summary** (session-start only — replaces auto-recalled memories)
4. Working Memory (with `[SESSION START — <timestamp>]` marker)
5. New Input

The `buildRecalledSection()` call is removed from `assemble()`. Replaced with `buildLastSessionSummary()` which only fires when `shouldInjectSessionContext` is true.

### 2. Session-Start Summary Format

```
[LAST SESSION SUMMARY — ended 2026-03-02T23:45:11.000Z]
User asked about Whisper STT language detection issues. Configured Groq
whisper-large-v3 with language: "hu" for Hungarian...

[SESSION START — 2026-03-04T17:42:06.123Z]
[CONVERSATION]
user: Meg tudod nézni ma Molty miért nem küldött jelentést?
...
[INPUT]
Ok do it now
```

The 2-day gap between "ended" and "SESSION START" makes it obvious to Kiro that the summary is stale context, not the current task.

### 3. agentbridge-recall CLI

Standalone Node.js script at `src/cli/agentbridge-recall.ts`. Opens `memory.db` read-only.

**Search pipeline:**
1. FTS5 on `extracted_memories_fts` (English keywords)
2. LIKE on `compactions` table (daily/weekly/quarterly summaries)
3. LIKE on `extracted_memories.content_original` (original-language fallback)
4. Temporal decay: `score × 2^(-age_days / 14)`
5. Deduplication + sort by decayed score
6. JSON output to stdout

**CLI interface:**
```bash
agentbridge-recall --keywords "kw1,kw2" --chat-id <id>
agentbridge-recall --keywords "puppy" --original "kiskutya" --chat-id 7773842843
agentbridge-recall --keywords "budget" --time-start <ms> --time-end <ms> --chat-id <id>
```

### 4. isSessionStart Flag

Tracked via `pendingSessionStart: Set<string>` in main.ts:
- Added to set after `/new` or `/reset` (both Telegram and Discord)
- Checked before `assembleContext()`, passed as `isSessionStart: true`, then removed
- Controls whether `buildLastSessionSummary()` and CoreFacts/RollingSummary are injected

### 5. Dead Code Retention

The `RecallFallbackPipeline`, `buildRecalledSection()`, and `IntentDetector` are retained but disconnected. They can be cleaned up in a future PR or repurposed if needed.
