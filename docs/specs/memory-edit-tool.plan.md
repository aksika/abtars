# Memory Edit Tool — Implementation Plan

**Created:** 2026-03-29
**Status:** Not started

## New CLI: `agentbridge-edit`

```bash
# By memory ID
agentbridge-edit --memory-id 42 --translated "corrected English" --caller dreamy

# By platform message ID (finds linked memories, edits all matches)
agentbridge-edit --message-id 12345 --chat-id 7773842843 --emotion-score 3

# Attribute edits
agentbridge-edit --memory-id 42 --credibility 1 --trust 3
agentbridge-edit --memory-id 42 --classification 2
agentbridge-edit --memory-id 42 --relevance-score +10

# Dry run (show what would change, don't commit)
agentbridge-edit --memory-id 42 --translated "corrected" --dry-run
```

## Schema changes

1. Consolidate `source_timestamp` into `created_at` (single creation timestamp, migrate existing data)
2. Add `edited_at INTEGER DEFAULT NULL`
3. Add `edited_by TEXT DEFAULT NULL`
4. Add FTS5 AFTER UPDATE triggers for `content_en` and `content_original`

## Lookup modes

- `--memory-id N` — direct extracted_memory ID
- `--message-id N --chat-id C` — find memories linked via `source_message_ids`, edit all matches, return count + list of IDs affected

## Editable fields

| Flag | Field | Notes |
|------|-------|-------|
| `--translated` | content_en | Tier 2 (user must stress) |
| `--original` | content_original | Tier 2 (user must stress) |
| `--keyword` | preserved_keyword | |
| `--memory-type` | memory_type | fact/decision/preference/event |
| `--emotion-score` | emotion_score | -5 to +5 |
| `--confidence` | confidence | 1-5 |
| `--trust` | trust | 0-3 |
| `--integrity` | integrity | 0-3 (verbatim/translated/extracted/compacted) |
| `--credibility` | credibility | 1-6 |
| `--classification` | classification | 0-3, with guards |
| `--relevance-score` | relevance_score | supports relative: `+10`, `-10` |

## Special flags

| Flag | Purpose |
|------|---------|
| `--caller` | Audit trail — "kp" or "dreamy", stored in `edited_by` |
| `--dry-run` | Show what would change without committing |
| `--user-override` | Required to declassify from SECRET (3) |

## Non-editable fields (set automatically)

- `edited_at` — set to `Date.now()` on every edit, not in recall output
- `edited_by` — set from `--caller`, not in recall output, not directly queryable

## Two-tier usage for KP

**Tier 1 — Attribute edits (free to use):**
All fields except content_en and content_original.

**Tier 2 — Content edits (user must explicitly stress):**
content_en, content_original. Default for wrong content: store corrected version as new memory, let Darwinism fade the old.

## Attribute editing rules (from CIA-AAA)

- **classification**: escalate freely, declassify only 2→1, SECRET (3) locked without `--user-override`
- **trust**: set 0-2 freely, set 3 only when user explicitly stated the fact
- **credibility**: improve/degrade based on evidence, 1 (confirmed) needs corroboration from user + independent source
- **integrity**: one-way toward compacted (higher number), exception for Dreamy translation fixes (can set to `translated`)
- **emotion_score, confidence, relevance_score, keyword, memory_type**: free

## Callers

- `kp` — direct user conversation
- `dreamy` — sleep maintenance mode

No external agents have access to KP's memory system. Molty and other A2A peers are consultants only — zero memory access.

## What it replaces

### In code (routed through editMemory)

1. `adjustRelevance()` — `--relevance-score +10`
2. `reclassifyMemory()` — `--classification N`
3. `updateEmotionByPlatformId()` — `--message-id N --emotion-score`

### In sleep prompt (raw SQL → CLI calls)

4. §6 emotion harvest → `--memory-id N --emotion-score`
5. §7 translation fix → `--memory-id N --translated "..."`
6. §7 fitness rewording → `--memory-id N --translated "..." --original "..."`

## What stays unchanged

- `mergeMemories()` — different operation (combine + delete)
- Embedding updates — internal pipeline
- `bumpRecallCount` — automatic Darwinism bookkeeping
- `--boost/--demote/--reclassify` in agentbridge-store — deprecated over time, kept for backward compat

## Safety

- Prompt injection scan on content edits (same as instantStore)
- Classification guard: SECRET can't be declassified without `--user-override`
- Content change → null embedding (auto re-embed)
- `--dry-run` for pre-commit verification

## Multi-match behavior

When `--message-id` matches multiple extracted memories:
- Edit ALL matching memories
- Return `{ ok: true, memoriesUpdated: N, ids: [1, 2, 3], fieldsUpdated: [...] }`

## Files to create/modify

1. **New:** `src/cli/agentbridge-edit.ts` — CLI entry point
2. **New:** types in `src/types/memory.ts` — EditMemoryParams, EditMemoryResult
3. **Modify:** `src/components/memory-db.ts` — FTS5 UPDATE triggers + `edited_at`/`edited_by` columns + `source_timestamp` migration
4. **Modify:** `src/components/memory-manager.ts` — `editMemory()` method, refactor `adjustRelevance`/`reclassifyMemory`/`updateEmotionByPlatformId` to route through it
5. **Modify:** all files referencing `source_timestamp` → `created_at`
6. **Modify:** `package.json` — add `agentbridge-edit` bin entry
7. **Steering:** `instant-store.md` — add edit section with two-tier rules
8. **Steering:** `TOOLS.md` — add `agentbridge-edit` syntax (always-on, so KP knows how to call it)
9. **Steering:** `sleeping_prompt.md` — §6 and §7 use `agentbridge-edit` instead of raw SQL
10. **Tests:** editMemory happy path, missing ID, content nulls embedding, classification guards, FTS5 sync, message-id lookup, multi-match, relative relevance delta, dry-run

## Implementation order

1. Schema migration (source_timestamp consolidation + new columns + FTS triggers) — riskiest, do first and verify
2. `editMemory()` method in MemoryManager
3. `agentbridge-edit` CLI + package.json bin entry
4. Refactor existing methods to route through editMemory
5. Steering updates (instant-store.md, TOOLS.md, sleeping_prompt.md)
6. Tests

## Related backlog items

- **#48** — Review A2A agent autonomy model (High)
- **#49** — Digital signature for `edited_by` field (Medium)
- **#50** — Decouple memory system from bridge (Medium)
