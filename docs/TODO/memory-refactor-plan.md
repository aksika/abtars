# Memory System Refactor Plan

Created: 2026-03-21
Status: Complete

---

## Overview

Efficiency refactor of the AgentBridge memory system. Conservative approach — the system works, we're removing redundancy and tightening data flow without changing core behavior.

## Design Principles

- SQLite is the single source of truth
- `messages` table is a hot buffer (flushed after sleep extraction)
- `extracted_memories` is the permanent knowledge store
- JSONL is eliminated — raw content with emojis stored in messages.content
- FTS5 stripping happens at index level, not storage level
- All housekeeping lives in sleep — one place
- LLM judges, wired logic executes

---

## Changes

### R1: SQLite Single Source — Drop JSONL

**Problem:** Every message written to SQLite + JSONL + chat_backup (3 writes). cascadeDelete rewrites JSONL files. Drift check needed because stores desync. Emojis stripped from messages.content but preserved in JSONL — creates data quality split.

**Solution:** SQLite is the only store. Raw content (with emojis) stored in `messages.content`. Emoji stripping moves to FTS5 trigger only.

**Changes:**
- `recordMessage()`: remove TranscriptWriter call, store raw content (no stripEmojis on content)
- FTS5 insert trigger on `messages`: strip emojis before indexing into `messages_fts`
- `cascadeDelete()`: remove JSONL rewrite logic, remove timestamp:content signature matching
- Remove `checkTranscriptDbDrift()` from startup
- `daily-backup.sh`: add SQL→JSONL export step for archive (nightly, not runtime)

**Delete:**
- `TranscriptWriter` (`transcript-writer.ts`)
- `TranscriptParser` (`transcript-parser.ts`)
- All JSONL-related tests

**Migrate callers:**
- `parseTail()` → `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`
- Sleep subagent transcript reads → `SELECT role, content, emotion_score, timestamp FROM messages WHERE chat_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`

---

### R2: One Search Path (conservative recall cascade refactor)

**Problem:** 3 search systems (agentbridge-recall 8-stage, MemorySearchTool 5-step, RecallFallbackPipeline). Agent only uses agentbridge-recall. 8 stages have redundancy.

**Solution:** Single path (agentbridge-recall), extracted-first, 5 stages.

**New cascade:**

| Stage | What | Source |
|-------|------|--------|
| 1 | Extracted memories EN FTS5 (Darwinism-boosted) | `extracted_memories_fts` |
| 2 | Extracted memories original FTS5 (Darwinism-boosted) | `extracted_memories_original_fts` |
| 3 | Raw messages FTS5 (relaxed OR) | `messages_fts` |
| 4 | Consolidation file search | daily/weekly/quarterly .md |
| 5 | Raw messages LIKE (wide net) | `messages` |

Short-circuit after stages 1-2 if ≥10 results with high Darwinism scores. MMR + temporal decay on final merged output. Dedup across stages by content hash.

**Phase A — Reorder (zero risk):**
- Flip stage order: extracted first, raw messages fallback
- Add cross-stage dedup
- Confirm Darwinism boost wired in recall CLI path
- Validate: 10-20 real queries, compare old vs new results

**Phase B — Optimize (data-driven):**
- Add hit-rate logging per stage
- Run 1-2 sleep cycles to collect data
- Drop old LIKE substring stages after data confirms <5% unique contribution
- Add short-circuit (`MEMORY_RECALL_SHORT_CIRCUIT` env var toggle)

**Phase C — Cleanup:**
- Delete `MemorySearchTool` (`memory-search-tool.ts` + tests)
- Delete `RecallFallbackPipeline` (`recall-fallback-pipeline.ts` + tests)
- Delete `IntentDetector` (`intent-detector.ts` + tests)

**Rollback:** Phase A: revert stage order. Phase B: re-enable stages, disable short-circuit. Phase C: git restore.

---

### R3: Sleep Cycle Restructure

**Problem:** GC step order wastes work (harvests emotion from messages about to be deleted, harvests before extraction creates targets). No retrospective. No message flush. Consolidation not explicit.

**New sleep order:**

| Step | What | Behavior |
|------|------|----------|
| 1 | **Retrospective** | Reads full `messages` table (nothing deleted yet). Answers: what went well, what went wrong, how to improve, emotional attribution. Writes to `retrospectives/retro_YYYYMMDD.md` + updates `core/agent_notes.md` |
| 2 | Purge expired garbage (>7d) | Immediate delete via cascadeDelete |
| 3 | Immediate deletes (dupes, wrong-chat, STT) | Immediate delete via cascadeDelete |
| 4 | Repeated probes | Garbage-mark → 7d grace |
| 5 | Noise marking | Garbage-mark → 7d grace |
| 6 | Verify-extract-mark (creates extracted_memories) | Garbage-mark → 7d grace |
| 7 | Emotion harvest (verbal only) | Updates extracted_memories.emotion_score |
| 8 | **Flush old messages** | Delete all messages older than 24h (extracted facts are in extracted_memories) |
| 9 | Consolidation (working→daily→weekly→quarterly) | File writes |
| 10 | Report | Audit summary |

**Key changes from current:**
- Retrospective is NEW — runs first while data is complete
- Emotion harvest moved after extraction (can target freshly created memories)
- Emotion harvest scope: verbal only (reactions handled at runtime by R6)
- Message flush is NEW — keeps messages table compact
- Consolidation made explicit step

**Retrospective prompt (step 1):**

Read today's conversations from the messages table and answer:
1. What went well? — Tasks completed, user satisfaction, good decisions
2. What went wrong? — Failures, misunderstandings, repeated attempts, corrections
3. What could have been done better? — Faster approaches, missed context, unnecessary steps
4. Emotional attribution — For each negative moment: was the user upset at my performance (misunderstanding, wrong approach) or at external circumstances (bad news, tool limitations)? Be honest.
5. What did I learn? — New preferences, corrections, patterns to remember

Output:
- Full retrospective → `~/.agentbridge/memory/retrospectives/retro_${WAKEUP_DATE}.md`
- Durable lessons → update `core/agent_notes.md` (≤10 lines, replace stale)
- Wrong memories → correct via `agentbridge-store --reclassify` or store corrected version

**Update:** `persona/sleeping_prompt.md` + deployed copy.

---

### R4: chat_backup Debug-Only

**Problem:** chat_backup duplicates every message. Original risk (LLM raw SQL deletes) mitigated by cascadeDelete.

**Solution:** Wire behind `DEBUG_MODE` env var.

**Changes:**
- `recordMessage()`: skip chat_backup insert when `!config.debugMode`
- `pruneBackup()`: skip when `!config.debugMode`
- Table stays in schema (no migration needed)

---

### R5: Delete Dead Code

**Delete:**
- `src/components/context-assembler.ts` + tests
- `src/components/context-window-monitor.ts` + tests
- `src/components/recall-fallback-pipeline.ts` + tests (also in R2-C)
- `src/components/intent-detector.ts` + tests (also in R2-C)
- `src/components/compaction-engine.ts` + tests
- `src/components/daily-compaction-task.ts` + tests
- `src/components/sleep-cycle-runner.ts` + tests
- `src/components/sleep-prompt-builder.ts` + tests
- `src/components/transcript-writer.ts` + tests (from R1)
- `src/components/transcript-parser.ts` + tests (from R1)

**Also:** Remove imports/references from `memory-manager.ts`, `reflection-engine.ts`, `main.ts`.

---

### R6: Immediate Emotion Propagation on Reactions

**Problem:** Telegram reactions update `messages.emotion_score` but don't reach `extracted_memories` until sleep harvest (12-24h delay).

**Solution:** On reaction, immediately propagate to linked extracted_memory.

**Flow:**
1. Reaction arrives → update `messages.emotion_score` (existing)
2. **New:** Query `extracted_memories` where `source_message_ids` contains this message id, or nearest by timestamp
3. If found → update `extracted_memories.emotion_score` immediately
4. If not found → stays on `messages`, sleep verbal harvest catches context later

**Sleep harvest scope change:** No longer harvests emoji reactions (handled at runtime). Only harvests verbal emotion ("awesome!", "this is broken") where LLM reads conversation context and maps sentiment to relevant extracted_memories.

**Changes:**
- Reaction handler in `main.ts`: add extracted_memory lookup + update after `updateEmotionByPlatformId()`
- `sleeping_prompt.md` step 7: clarify verbal-only scope

---

## Implementation Order

1. **R5** — Delete dead code (clears noise, no behavior change)
2. **R1** — SQLite single source (biggest simplification: drop JSONL, fix emoji stripping)
3. **R4** — chat_backup debug-only (no more triple-write)
4. **R6** — Immediate emotion propagation (small addition to reaction handler)
5. **R3** — Sleep cycle restructure (prompt rewrite: new order, retrospective, message flush)
6. **R2** — Recall cascade refactor (most sensitive — phased, validated, last)

## What Stays Unchanged

- 4 consolidation tiers (working→daily→weekly→quarterly) — verified working
- All 4 NATO security fields (classification, trust, integrity, credibility) — reference project
- Extraction via sleep + agent instant store — sufficient coverage
- All GC in sleep — one place for all housekeeping
- Both emotion columns (messages + extracted_memories) — messages is staging area
- Memory Darwinism (recall tracking, relevance, confidence, merge, fitness)
- `messages` table schema (just stores raw content now instead of stripped)
- `extracted_memories` table schema (permanent knowledge store)

## Net Effect

| What | Current | After |
|------|---------|-------|
| Writes per message | 3 (SQLite + JSONL + chat_backup) | 1 (SQLite) |
| Search paths | 3 | 1 |
| Recall stages | 8 | 5 |
| Dead components | ~10 files | 0 |
| messages.content | Emoji-stripped | Raw (emojis preserved) |
| FTS5 indexing | Strips at storage | Strips at index trigger |
| messages table size | Grows unbounded (GC slow) | Hot buffer — flushed after sleep |
| JSONL files | Permanent, cascade-rewritten | None (nightly SQL export for backup) |
| Emotion propagation | Sleep-only (12-24h delay) | Immediate for reactions, sleep for verbal |
| Sleep steps | 9 (no retro, no flush) | 10 (retro + flush added) |
| Self-reflection | None | Daily retrospective with emotional attribution |

---

## Future Feature: Derived Facts from Retrospective

**Not part of this refactor — new feature, implement after refactor is stable.**

After the daily retrospective (step 1) produces lessons learned, the agent should update a set of derived facts that get loaded into every new session. This closes the learning loop:

```
conversation → retro → lessons → derived facts → next session context
```

Currently `core/user_profile.md` and `core/agent_notes.md` are manually maintained. The derived facts system would make this automatic — retro insights flow into session-start context without the agent having to remember to update the files.

Design TBD: could be a new `core/derived_facts.md` file, or an evolution of the existing core files with structured sections (retro-generated vs manually set).
