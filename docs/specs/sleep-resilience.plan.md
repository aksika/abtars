# Sleep Resilience — Implementation Plan

**Created:** 2026-03-30
**Status:** Not started

## 1. Wall-Clock Timeout (20 min)

`setTimeout` in the step loop that kills the transport and exits after 20 minutes total. Successful run was 10 min, so 20 min gives 2x headroom. Whatever steps completed are saved in the state file, whatever didn't are marked as `timeout`.

## 2. Lock File → State File

Current: `sleep_20260330.lock` contains just a PID number.

Proposed: JSON state file tracking per-step progress:

```json
{
  "pid": 612317,
  "startedAt": 1743328332000,
  "steps": {
    "identity": { "status": "ok", "duration": 15.1 },
    "retrospective": { "status": "ok", "duration": 54.6 },
    "feedback": { "status": "skipped" },
    "gc": { "status": "failed", "duration": 300.0, "attempts": 3 },
    "db-maintenance": { "status": "pending" }
  }
}
```

Written after each step completes. If the process dies, the state file shows exactly where it stopped.

## 3. Resume on Retry

When the sleep trigger fires a retry (attempt 2/3), the CLI reads the existing state file:

1. Load state file → see which steps are `ok`/`skipped` vs `failed`/`pending`/`timeout`
2. Create transport (new kiro-cli session)
3. Send identity prompt (always — new session needs context)
4. Skip steps that are `ok` or `skipped`
5. Retry steps that are `failed`, `pending`, or `timeout`
6. Report step always re-runs (needs to summarize the full cycle)
7. Update state file as it goes

## 4. Split Fitness into 3 Sub-Steps

Current `08-fitness.md` (127s) does 3 things in one prompt. Split with sub-numbering:

| File | Step | What | Skip condition |
|------|------|------|---------------|
| `08a-darwinism.md` | Darwinism review | Pre-filtered: only zero-recall >60d + negative relevance | <10 memories |
| `08b-core-knowledge.md` | Core knowledge maintenance | Review user_profile.md + agent_notes.md (≤10 lines each) | never |
| `08c-translation-check.md` | Translation quality | Pre-filtered: only bilingual memories with potential issues | no bilingual memories |

### Smarter queries (Option C)

Instead of `LIMIT 50` on all memories, only query candidates that need action:

**Darwinism:**
```sql
-- Prune candidates: zero recall, older than 60 days
SELECT id, substr(content_en,1,80), recall_count, confidence, created_at
FROM extracted_memories WHERE recall_count = 0 AND created_at < (strftime('%s','now','-60 days') * 1000) AND classification < 3
ORDER BY confidence ASC LIMIT 20;

-- Reword candidates: negative relevance
SELECT id, substr(content_en,1,80), relevance_score
FROM extracted_memories WHERE relevance_score < 0 AND classification < 3 LIMIT 10;
```

**Translation check:**
```sql
-- Only bilingual memories where content_en might have untranslated words
SELECT id, substr(content_en,1,100), substr(content_original,1,100)
FROM extracted_memories WHERE content_en != content_original AND content_original IS NOT NULL
ORDER BY id DESC LIMIT 10;
```

## 5. Split GC into 3 Sub-Steps

Current `04-gc.md` (95s) does 7 things in one prompt. Split into fast (SQL-driven) and slow (LLM-driven):

| File | What | Skip condition |
|------|------|---------------|
| `04a-gc-cleanup.md` | Purge expired garbage, dedup, wrong-chat, STT, flush >24h | <5 messages |
| `04b-gc-noise.md` | Noise marking — pre-filtered: only messages <20 chars | no short messages |
| `04c-gc-extract.md` | Verify extractions + verbal emotion harvest | no unextracted messages |

### Pre-filtered noise query
```sql
-- Only short messages likely to be noise
SELECT id, content FROM messages WHERE role='user' AND length(content) < 20 ORDER BY id;
```

## 6. Wake-Up Summary in Log

After sleep completes, log a one-line headline to bridge.log parsed from the report step:
```
[SLEEP] 🏁 13 ok, 0 failed, 2 skipped | pruned 25 | 3 anomalies fixed | daily written | 9.8 min
```

## 7. Step File Changes

| Action | File |
|--------|------|
| Delete | `04-gc.md` |
| Create | `04a-gc-cleanup.md` — purge, dedup, wrong-chat, STT, flush |
| Create | `04b-gc-noise.md` — noise marking (pre-filtered <20 chars) |
| Create | `04c-gc-extract.md` — verify extractions + emotion harvest |
| Delete | `08-fitness.md` |
| Create | `08a-darwinism.md` — pre-filtered prune/reword candidates |
| Create | `08b-core-knowledge.md` — user_profile + agent_notes review |
| Create | `08c-translation-check.md` — pre-filtered bilingual check |
| Renumber | None — sub-numbering keeps 05-07, 09-14 stable |

## 6. State File Lifecycle

```
No lock → trigger fires → create state file (all "pending") → run steps
  → step completes → update state file → next step
  → all done → write audit .md → mark state "completed"

Process dies:
  → state file shows partial progress
  → retry fires → reads state → resumes from failed/pending
  → completes → writes audit

Next day:
  → trigger checks date → ignores yesterday's state file → fresh start
```

## Implementation

| File | Change |
|------|--------|
| `agentbridge-sleep.ts` | State file read/write, skip completed on resume, 20-min timeout, wake-up summary log, wired tasks before LLM |
| `sleep-trigger.ts` | Detect partial state for retry |
| `persona/sleep/00-identity.md` | Add: "Maintenance tasks already completed. Some steps may be done from a previous attempt." |
| `persona/sleep/04-gc.md` | Delete |
| `persona/sleep/04a-gc-cleanup.md` | New — wired (TypeScript): purge, dedup, wrong-chat, STT, flush |
| `persona/sleep/04b-gc-noise.md` | New — LLM: pre-filtered noise marking |
| `persona/sleep/04c-gc-extract.md` | New — LLM: verify extractions + emotion harvest (watermark-based) |
| `persona/sleep/08-fitness.md` | Delete |
| `persona/sleep/08a-darwinism.md` | New — pre-filtered queries |
| `persona/sleep/08b-core-knowledge.md` | New |
| `persona/sleep/08c-translation-check.md` | New — pre-filtered queries |
| `persona/sleep/09-anomaly-audit.md` | Update — add classification escalation rules |

## 8. Scaling Guards

All LLM-facing queries must have hard `LIMIT 20-30`. The LLM can't meaningfully process hundreds of rows. Over multiple nights, everything gets covered.

| Query | Limit | Rationale |
|-------|-------|-----------|
| GC extract (unprocessed messages) | LIMIT 20 | Use extraction watermark to skip already-processed. Dreamy handles 20/night. |
| Anomaly flag-for-review | LIMIT 10 | Auto-fixes are SQL-only (unlimited). Flagging needs LLM judgment — cap it. |
| Consolidation | Naturally bounded | GC flushes >24h messages before consolidation runs. If GC fails, cap at 50. |
| Darwinism / translation / merge | Already capped | LIMIT 10-30 in prompts. |

### GC extract watermark optimization

Current prompt tells Dreamy to cross-reference messages vs extracted_memories manually. Update to use the extraction watermark:
```sql
SELECT id, content FROM messages
WHERE timestamp > (SELECT COALESCE(last_processed_timestamp, 0) FROM extraction_watermarks WHERE chat_id = ?)
ORDER BY timestamp LIMIT 20;
```

## 9. Wired (TypeScript) vs Smart (LLM) Split

Some sleep tasks are pure SQL that don't need LLM judgment. Run these as TypeScript functions before the multi-turn conversation starts.

**Wire (run before Dreamy):**
- Purge expired garbage (read garbage.json, delete >7d)
- Dedup messages (deterministic self-join)
- Flush >24h messages (DELETE WHERE timestamp < cutoff)
- WAL checkpoint (PRAGMA)
- FTS rebuild if corrupt (INSERT INTO table VALUES('rebuild'))
- Batch embed NULL embeddings (agentbridge-embed)
- Anomaly auto-fixes (deterministic UPDATE queries)
- Log rotation cleanup (find -delete >7d)

**Keep as LLM tasks:**
- Retrospective, noise marking, extract verification, emotion harvest
- Core knowledge review, translation quality, consolidation, report

Dreamy's identity prompt updated: "Maintenance tasks (purge, dedup, flush, WAL, FTS, embed, anomaly fixes) already completed. Focus on tasks requiring judgment."

## 10. Anomaly Audit — Classification Escalation Rules

Update `09-anomaly-audit.md` with clearer rules for flagging classification:

**Do NOT flag as needing escalation:**
- Internal operational emails (e.g. newsletter subscriptions, tool confirmations) — classification=1 (RESTRICTED) is correct
- Content where the user asked for a translation/explanation but didn't confirm a personal plan — agent inference is not user confirmation
- General facts that happen to mention an email address used for business purposes

**DO flag:**
- Content the user explicitly marked as personal/private
- Health, medical, financial details confirmed by user
- Travel plans, relationship details confirmed by user

**Key principle:** Classification should primarily come from user context. If the user didn't confirm something as personal, the agent's inference alone is not enough to escalate. When in doubt, keep current classification.

## Effort

- State file + timeout + resume: ~55 lines in agentbridge-sleep.ts
- Wake-up summary: ~10 lines
- GC split: 3 new prompt files, delete 1
- Fitness split: 3 new prompt files, delete 1
- Skip conditions for sub-steps: ~10 lines
