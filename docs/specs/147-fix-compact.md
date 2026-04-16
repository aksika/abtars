# #147 Fix /compact — In-Memory Only

## Problem

/compact is broken:
1. Compaction prompt doesn't distinguish user conversation from system injections (SOUL, wake-up, tools) → summary includes system context → double injection after reset
2. Summary injected via `sendPrompt()` → agent responds to its own summary
3. No enforcement if agent calls tools despite "do not call tools" instruction
4. `extractSummary` falls back to raw text if no `<summary>` tags → garbage injection risk

## Design

### Compaction prompt
Tell agent to summarize USER CONVERSATION only. Ignore system context, SOUL, memory injections, tool definitions, tool calls/results.

### Storage
`compactionSummaries: Map<sessionKey, string>` — in-memory only, not persisted. Lives until consumed by session-start or cleared by /reset.

### Flow
```
/compact
  1. Send compaction prompt to agent
  2. Extract <summary> from response (strict — reject if missing/too short)
  3. Store summary in Map<sessionKey, string>
  4. Reset session (transport.resetSession)
  5. Mark pendingSessionStart
  6. Reply "📦 Compacted (N chars summary)"

Next user message triggers session-start pipeline:
  1. Inject SOUL bundle (normal)
  2. Inject wake-up per role (normal)
  3. Inject user identity (normal)
  4. Check compactionSummaries map for this sessionKey
  5. If found: inject as [COMPACTED CONVERSATION] block, delete from map
  6. Continue with user message
```

### No double injection
- SOUL, wake-up, memory context injected fresh by session-start pipeline
- Compaction summary contains only user conversation context
- No overlap

### Sessions are single-user
No userId filtering needed in compaction. Each session belongs to one user.

## Implementation

| Step | File | Change |
|------|------|--------|
| 1 | `compaction.ts` | Rewrite COMPACTION_PROMPT — "summarize user conversation only" |
| 2 | `compaction.ts` | Strict `extractSummary` — return null if no tags or < 50 chars |
| 3 | `message-pipeline.ts` | Add `compactionSummaries: Map<string, string>` |
| 4 | `compaction.ts` | `runCompaction` — store summary in map, reset, mark pendingSessionStart. Remove `sendPrompt(injection)` |
| 5 | `message-pipeline.ts` | `buildSessionStartPrompt` — check map, inject `[COMPACTED CONVERSATION]` block |
| 6 | `compaction.test.ts` | Tests for `extractSummary` (with tags, without tags, too short, analysis stripping) |

## Not doing
- Auto-compact threshold (separate backlog item)
- Persisting summary to DB
- Multi-user scoping
