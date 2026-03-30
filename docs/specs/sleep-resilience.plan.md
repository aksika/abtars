# Sleep Resilience — Implementation Plan

**Created:** 2026-03-30
**Status:** Not started

## 1. Wall-Clock Timeout (20 min)

`setTimeout` that kills the transport and exits after 20 minutes. Successful run was 10 min, so 20 min gives 2x headroom. Completed steps saved in state file, remaining marked `timeout`.

## 2. Lock File → State File

Current: `sleep_20260330.lock` contains just a PID.

Proposed: JSON state file tracking per-step progress:

```json
{
  "pid": 612317,
  "startedAt": 1743328332000,
  "wiredResults": { "purged": 3, "deduped": 1, "embedded": 4, "anomaliesFixed": 2 },
  "steps": {
    "identity": { "status": "ok", "duration": 15.1 },
    "retrospective": { "status": "ok", "duration": 54.6 },
    "gc-noise": { "status": "failed", "duration": 300.0, "attempts": 3 },
    "gc-extract": { "status": "pending" }
  }
}
```

Written after each step. If process dies, state file shows exactly where it stopped.

## 3. Resume on Retry

When retry fires (attempt 2/3), CLI reads existing state file:

1. Wired pre-tasks always re-run (fast, idempotent)
2. Create transport (new kiro-cli session)
3. Identity prompt always re-runs (new session needs context)
4. Skip LLM steps that are `ok` or `skipped`
5. Retry steps that are `failed`, `pending`, or `timeout`
6. Report step always re-runs
7. Wired post-task (flush) only if Dreamy succeeded

## 4. Execution Flow

```
WIRED PRE-TASKS (TypeScript, fast, idempotent):
  → purge expired garbage.json entries (>7d)
  → dedup consecutive exact messages (TRIM match, same role, no gap limit)
  → WAL checkpoint
  → FTS rebuild if corrupt
  → batch embed NULL embeddings
  → anomaly auto-fixes (deterministic UPDATEs)
  → log rotation (delete bridge-*.log >7d)

DREAMY MULTI-TURN (LLM, tracked in state file):
  → 00   identity (always)
  → 01   retrospective
  → 02   feedback (skip if no recall invocations)
  → 03   reminders
  → 04b  gc-noise (pre-filtered: messages <20 chars)
  → 04c  gc-extract + emotion harvest (watermark-based, LIMIT 20)
  → 06   cron-verify
  → 07   topic-reorg (skip if no topic files)
  → 08a  darwinism (pre-filtered: zero-recall >60d + negative relevance)
  → 08b  core-knowledge
  → 08c  translation-check (skip if no bilingual memories)
  → 09   anomaly-audit (flag-for-review only, LIMIT 10)
  → 10   retro-extract
  → 11   merge (skip if <10 memories)
  → 12   consolidation
  → 13   media-cleanup (skip if no received/ dir)
  → 14   report (always)

WIRED POST-TASK (only if Dreamy succeeded):
  → flush messages >24h
```

## 5. Split Fitness into 3 Sub-Steps

| File | What | Skip condition |
|------|------|---------------|
| `08a-darwinism.md` | Pre-filtered: zero-recall >60d + negative relevance | <10 memories |
| `08b-core-knowledge.md` | Review user_profile.md + agent_notes.md (≤10 lines each) | never |
| `08c-translation-check.md` | Pre-filtered: bilingual memories with issues | no bilingual memories |

### Pre-filtered queries

**Darwinism:**
```sql
SELECT id, substr(content_en,1,80), recall_count, confidence, created_at
FROM extracted_memories WHERE recall_count = 0 AND created_at < (strftime('%s','now','-60 days') * 1000) AND classification < 3
ORDER BY confidence ASC LIMIT 20;

SELECT id, substr(content_en,1,80), relevance_score
FROM extracted_memories WHERE relevance_score < 0 AND classification < 3 LIMIT 10;
```

**Translation:**
```sql
SELECT id, substr(content_en,1,100), substr(content_original,1,100)
FROM extracted_memories WHERE content_en != content_original AND content_original IS NOT NULL
ORDER BY id DESC LIMIT 10;
```

## 6. Split GC — Wired + LLM

Old `04-gc.md` (7 sub-steps, 95s) split into:
- **Wired:** purge, dedup, flush (moved to pre/post tasks)
- **LLM:** `04b-gc-noise.md` (noise marking), `04c-gc-extract.md` (extract + emotion)

### Dedup query (wired, consecutive exact match)
```sql
SELECT b.id FROM messages a JOIN messages b
ON a.chat_id = b.chat_id AND a.role = b.role
AND TRIM(a.content) = TRIM(b.content)
AND b.id > a.id
AND NOT EXISTS (
  SELECT 1 FROM messages m
  WHERE m.chat_id = a.chat_id AND m.id > a.id AND m.id < b.id AND m.role = a.role
);
```

### GC extract watermark query
```sql
SELECT id, content FROM messages
WHERE timestamp > (SELECT COALESCE(last_processed_timestamp, 0) FROM extraction_watermarks WHERE chat_id = ?)
ORDER BY timestamp LIMIT 20;
```

### Noise pre-filter
```sql
SELECT id, content FROM messages WHERE role='user' AND length(content) < 20 ORDER BY id;
```

## 7. Wake-Up Summary in Log

One-line headline after sleep completes:
```
[SLEEP] 🏁 13 ok, 0 failed, 2 skipped | pruned 25 | 3 anomalies fixed | daily written | 9.8 min
```

## 8. Scaling Guards

All LLM-facing queries: hard `LIMIT 20-30`. Over multiple nights, everything gets covered.

| Query | Limit |
|-------|-------|
| GC extract | LIMIT 20 (watermark-based) |
| Anomaly flag-for-review | LIMIT 10 |
| Consolidation | Naturally bounded (flush runs after) |
| Darwinism / translation / merge | LIMIT 10-30 |

## 9. Wired Tasks — Error Handling

Wired tasks are non-blocking. If one fails: log the error, continue. Dreamy's identity prompt includes wired results summary so it knows what succeeded/failed:

"Wired maintenance completed: 3 garbage purged, 1 dedup deleted, WAL ok, FTS ok, 4 embedded, 2 anomalies fixed. Log rotation: 0 files deleted."

If a wired task fails: "Wired maintenance: garbage purge FAILED (corrupt JSON), dedup ok, ..."

## 10. Classification Escalation Rules

In `09-anomaly-audit.md`:

**Do NOT flag:** operational emails, translations user asked for, business email mentions, agent inference without user confirmation.

**DO flag:** content user explicitly confirmed as personal/private, health/finance/relationship confirmed by user.

**Key principle:** Classification comes from user context, not agent inference.

## Step File Changes

| Action | File |
|--------|------|
| Delete | `04-gc.md`, `05-db-maintenance.md`, `08-fitness.md` |
| Create | `04b-gc-noise.md`, `04c-gc-extract.md` |
| Create | `08a-darwinism.md`, `08b-core-knowledge.md`, `08c-translation-check.md` |
| Update | `00-identity.md` — wired results + resume context |
| Update | `09-anomaly-audit.md` — classification rules (done) |

## State File Lifecycle

```
No lock → trigger fires → create state file (all "pending")
  → wired pre-tasks run → results saved to state file
  → Dreamy steps run → state updated per step
  → all done → write audit → wired post-task (flush) → mark "completed"

Process dies:
  → state file shows partial progress
  → retry fires → wired re-runs (idempotent) → Dreamy resumes from failed/pending

Next day:
  → trigger checks date → fresh start
```

## Effort

- Wired pre/post tasks: ~100 lines in agentbridge-sleep.ts
- State file + timeout + resume: ~60 lines
- Wake-up summary: ~10 lines
- GC split: 2 new prompt files, delete 2 (gc + db-maintenance)
- Fitness split: 3 new prompt files, delete 1
- Identity prompt update: ~5 lines
