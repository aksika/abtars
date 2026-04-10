# ABM Simplification #4 — Sleep Refactor: Code Pre-Pass + Conditional Prompts

**Date:** 2026-04-10
**Status:** Ready to implement
**Master plan:** `abm-simplification.md`
**Replaces:** Previous 4-phase design. Single session, code-driven pre-pass, conditional LLM prompts.

---

## Problem

27 step files, 22+ LLM calls in one session, hits the 12-call budget. Half the steps are mechanical tasks the LLM does via tool calls that code could do directly. The other half fire even when there's nothing to do.

## Solution

**Code pre-pass + conditional LLM prompts.** One session. Code handles all mechanical work first (~500ms). LLM prompts only fire when the pre-pass found actual work. Each prompt gets pre-loaded data — no "query the DB yourself."

---

## Step 1: Code Pre-Pass (0 LLM calls, ~500ms)

Runs before any LLM prompt. Handles everything mechanical:

| Task | Function | Already exists? |
|---|---|---|
| Garbage purge (expired entries) | `runWiredPreTasks()` | ✅ Yes |
| Message dedup | `deduplicateMessages()` | ✅ Yes |
| WAL checkpoint + FTS rebuild | `runWalCheckpoint()` + `rebuildFtsIndexes()` | ✅ Yes |
| Embedding backfill | `backfillEmbeddings()` | ✅ Yes |
| Anomaly auto-fixes | `fixMemoryDefaults()` | ✅ Yes |
| Emotion/flags backfill | `detectEmotions()` + `detectFlags()` on untagged | ✅ Functions exist, wiring needed |
| Emotional arcs | `buildArc()` per topic → write `emotion_arc` | ✅ Function exists, wiring needed |
| Memory aging | `ageMemoryTiers()` | ✅ Yes |
| Media cleanup | FIFO 100MB filesystem | ✅ Yes |
| effectiveConfidence decay | `effectiveConfidence()` | ✅ Function exists, wiring needed |
| Temporal review | SQL: core memories older than X, not recalled → invalidate | New (simple SQL) |
| Contradiction pre-scan | `checkContradiction()` on core candidates → candidate list | ✅ Function exists, wiring needed |
| Darwinism pre-scan | effectiveConfidence < threshold → candidate list | New (simple query) |
| Merge pre-scan | signature similarity > 0.8 within same topic → candidate pairs | New (uses existing `hammingSimilarity`) |
| User emotional profile | Analyze emotion_tags + emotion_context across topics/time. Extract patterns (frustration triggers, recovery style, peak positive). Write to `user_profile.md`. Weekly. | New (from #7 emotion) |

**Output:** candidate lists for each LLM step. Empty list → skip that prompt.

---

## Step 2: LLM Prompts (conditional, pre-loaded data)

| # | Prompt | Fires when | Pre-loaded data |
|---|---|---|---|
| 01 | GC Noise | always (messages exist) | Messages since watermark |
| 02 | Daily Summary | always | Messages (code-driven batches) |
| 03 | Extract from Daily | daily file written | Daily file content |
| 04 | Retrospective | always | Clean messages since watermark |
| 05 | Retro Extract | retro file written | Retro content |
| 06 | Feedback | recalls happened today | Recalled memory IDs + conversation context |
| 07 | Topic Assignment | untagged memories found by pre-pass | List of untagged memories |
| 08 | Core Promotion | promotion candidates found by pre-pass | Candidate list with scores |
| 09 | Merge | duplicate candidates found by pre-pass | Candidate pairs with similarity scores |
| 10 | Translation | bilingual quality issues found | Flagged memories |
| 11 | Skill Review | weekly (SLEEP_CURATION_DAY) | Recent conversations |
| 12 | Core Knowledge | weekly (SLEEP_CURATION_DAY) | Core files |
| 13 | Consolidation | weekly/quarterly due | Period's dailies |
| 14 | Emotion Context | memories without emotion_context | Flagged memories |

---

## Step 3: Code Report + Professor Review (0 Dreamy LLM calls)

- Code aggregates results from pre-pass + prompts → audit file
- Audit injected to Professor as system message (immediately after sleep)
- Professor sends user "dream report" with summary + flagged issues
- User has 5-min window before hardware sleep (gated on `HARDWARE_SLEEP_AFTER_DREAMY`)

---

## SLEEP_QUALITY Tiering

| Tier | Prompts that run | LLM calls |
|---|---|---|
| Budget | 01-03 only (GC + daily + extract) | 3-5 |
| Normal | 01-10 always, 11-13 weekly, 14 when needed | 6-11 |
| Ultimate | 01-14 all eligible | 8-15 |

Code pre-pass runs on ALL tiers (free, ~500ms).

---

## Prompt File Renaming

Delete 27 old files. Create 14 new files with clean numbering:

```
persona/prompts/sleep/
  01-gc-noise.md
  02-daily-summary.md
  03-extract-from-daily.md
  04-retrospective.md
  05-retro-extract.md
  06-feedback.md
  07-topic-assignment.md
  08-core-promotion.md
  09-merge.md
  10-translation.md
  11-skill-review.md
  12-core-knowledge.md
  13-consolidation.md
  14-emotion-context.md
```

No identity prompt (bridge-injected session context). No report prompt (code-driven). No mechanical steps (code-driven). No reminders (main agent handles live).

**Files deleted (replaced by code):**
- `00-identity.md` → bridge-injected
- `19-emotion-flags.md` → `detectEmotions()` + `detectFlags()`
- `22-emotion-arcs.md` → `buildArc()`
- `23-memory-aging.md` → `ageMemoryTiers()`
- `13-media-cleanup.md` → filesystem FIFO
- `14-report.md` → code aggregation
- `09-anomaly-audit.md` → `fixMemoryDefaults()` (already code)
- `18-temporal-review.md` → SQL in pre-pass
- `21-contradiction.md` → `checkContradiction()` in pre-pass
- `08a-darwinism.md` → `effectiveConfidence()` in pre-pass (candidates passed to merge/promotion prompts)
- `03-reminders.md` → main agent handles live (SOUL update)

**Files renamed/kept (content updated for pre-loaded data):**
- `00b-gc-noise.md` → `01-gc-noise.md`
- `04a-daily-summary.md` → `02-daily-summary.md`
- `04b-extract-from-daily.md` → `03-extract-from-daily.md`
- `01-retrospective.md` → `04-retrospective.md`
- `10-retro-extract.md` → `05-retro-extract.md`
- `02-feedback.md` → `06-feedback.md`
- `16-topic-assignment.md` → `07-topic-assignment.md`
- `17-core-promotion.md` → `08-core-promotion.md`
- `11-merge.md` → `09-merge.md`
- `08c-translation-check.md` → `10-translation.md`
- `15-skill-review.md` → `11-skill-review.md`
- `08b-core-knowledge.md` → `12-core-knowledge.md`
- `12-consolidation.md` → `13-consolidation.md`
- `25-emotion-context-backfill.md` → `14-emotion-context.md`

---

## SOUL Update

Add to SOUL.md Continuity section:

```
When the user mentions a task, deadline, or reminder — store it immediately via
`agentbridge-todo`. Don't wait for sleep. Dreamy doesn't handle reminders —
the main agent captures them in real-time.
```

---

## Orchestrator Rewrite

The sleep orchestrator (`agentbridge-sleep.ts`) changes from:

```
Current: load all step files → loop through all → send each as prompt → retry/skip
```

To:

```
New:
  1. runCodeMaintenance(db, memory)     → all mechanical tasks + candidate lists
  2. for each prompt 01-14:
       if candidates[prompt] is empty → skip
       if previous dependency failed → skip (mark in lock)
       inject candidates into prompt template (substituteVars)
       send prompt → log result
  3. writeAuditFile(results)
  4. injectToMainAgent(auditFile)
```

### Prompt ordering dependencies

Some prompts depend on previous prompt output, not just pre-pass data:

```
01-gc-noise        → independent
02-daily-summary   → independent
03-extract-from-daily → DEPENDS ON 02 (needs daily file)
04-retrospective   → independent (reads messages, not daily file)
05-retro-extract   → DEPENDS ON 04 (needs retro file)
06-14              → independent (use pre-pass data only)
```

If a dependency fails, the dependent prompt is skipped and marked `skipped:dependency` in the lock file.

### Identity injection

When `createAgentTransport("dreamy", ...)` creates a session, the agent registry constructs the identity context (Dreamy persona + state snapshot + wired results). This is prepended to prompt 01 (GC noise) as a single message — identity + first task in one LLM call. Not a separate identity step.

### Pre-loaded data format

Prompts use variable substitution via existing `substituteVars()`. The code pre-pass populates variables:

```
${UNTAGGED_MEMORIES}     → list of memories without topics (for 07-topic-assignment)
${PROMOTION_CANDIDATES}  → memories with high recall + general tier (for 08-core-promotion)
${MERGE_CANDIDATES}      → similar memory pairs (for 09-merge)
${TRANSLATION_ISSUES}    → bilingual quality flags (for 10-translation)
${EMOTION_CONTEXT_GAPS}  → memories with tags but no context (for 14-emotion-context)
```

If a variable is empty, the corresponding prompt is skipped.

### Watermark advancement

- Watermark advances ONLY after prompt 03 (extract-from-daily) succeeds
- Essential prompts: 01-05. If any fail, watermark stays put
- Prompts 06-14 are idempotent — failure doesn't affect watermark

### Watermark recovery (stuck forever protection)

If the watermark hasn't advanced in 3+ days (consecutive sleep failures):
1. **Auto-advance** watermark to `now - 24h`. Accept data loss for the stuck period. Log ERROR.
2. **Flag to user** after 2 consecutive failures: Professor reports "Sleep extraction has failed 2 nights. Messages since [date] haven't been processed." User can intervene.
3. Daily summary targets the watermark date and processes forward to present — may contain multiple days if catching up.

### Catch-up for missed days

Daily summary is dated from where the watermark points. If watermark is 2 days behind, the daily summary covers 2 days of messages up to present. The file is named with the watermark date. Watermark advances to present after successful extraction.

---

## Implementation Tasks

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | `runCodeMaintenance()` — extract all mechanical steps into one function. Wire existing functions (emotion backfill, arcs, aging, contradiction scan, darwinism scan, merge scan). Return candidate lists per prompt. | 2hr | — |
| 2 | Create 14 new prompt files with clean numbering. Update each to accept pre-loaded data instead of "query the DB yourself." | 1.5hr | — |
| 3 | Rewrite orchestrator: code pre-pass → conditional prompt loop → code report. Remove phase/session logic. Single session. | 2hr | 1, 2 |
| 4 | SLEEP_QUALITY tiering: budget/normal/ultimate controls which prompts are eligible. | 30min | 3 |
| 5 | Professor dream report: code writes audit → inject to Professor → flagged issues. | 30min | 3 |
| 6 | SOUL update: reminders handled live by main agent. | 5min | — |
| 7 | Delete old prompt files (27 files). | 5min | 2 |
| 8 | Update lock file format + keep global call cap as emergency brake. | 15min | 3 |
| 9 | Test: run full cycle, compare output with old system. | 1hr | 3-7 |

**Total: ~8hr**

Branch: `refactor/sleep-v2`

---

## Comparison

| Metric | Current | After |
|---|---|---|
| Prompt files | 27 | 14 |
| LLM calls (quiet night) | 22+ (hits cap) | 6 |
| LLM calls (normal night) | 22+ (hits cap) | 8-10 |
| LLM calls (heavy night) | 22+ (hits cap) | 12-15 |
| Mechanical steps | LLM via tool calls | Code (~500ms) |
| Empty steps | Fire anyway, "nothing to do" | Skipped |
| Data loading | LLM queries DB | Pre-loaded in prompt |
| Sessions | 1 | 1 |
| Identity | LLM prompt (was 21 min) | Bridge-injected (0s) |
