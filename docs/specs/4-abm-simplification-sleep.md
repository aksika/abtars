# ABM Simplification #4 — Sleep: 24 Steps → 4 Phases

**Date:** 2026-04-09
**Status:** Planning — tasks 0b/0c/0d shipped, awaiting telemetry data before phase refactor
**Master plan:** `abm-simplification.md`
**Caveat from counter-discussion:** Biggest refactor on the list. Current 24 steps are battle-tested. Do AFTER #1 is validated. Don't rush.

---

## Problem

24 separate prompt files, each a turn in a multi-turn conversation. Context accumulates — step 20 has steps 1-19 in its context window. This causes:

- **Token cost:** By step 20, the context is full of previous responses. On a 128K model, this is ~50-80K tokens of accumulated sleep conversation.
- **Fragility:** Timeout at step 12 leaves steps 13-24 undone. Catch-up logic is complex (essential vs idempotent, cross-day recovery, lock files).
- **Per-step retry:** Each step has 3 attempts × 5-min timeout. 24 steps × worst case = 6 hours of retries.
- **Ordering dependencies:** Some steps depend on earlier steps' output (retro-extract needs retrospective, extract-from-daily needs daily summary). But most are independent.

## What works well (keep)

- **Code-driven steps** (4a daily summary, 4b extract from daily) — these bypass the context accumulation problem because they batch messages and control the LLM interaction directly
- **Conditional skip logic** — skip steps when there's nothing to do
- **Lock file lifecycle** — date-scoped, same-day resume, cross-day catch-up
- **Essential vs idempotent distinction** — essential steps (daily summary, extraction, retro) must run; idempotent steps catch up naturally
- **State snapshot** — SleepStateGatherer collects DB stats, FTS health, disk usage before sleep starts

## Current 24 steps mapped to 4 phases

### Phase 1: Extract (time-sensitive — data lost if skipped)

| Current step | What | LLM needed | Code-driven |
|---|---|---|---|
| 4c (§4c GC Noise) | Mark small talk/noise as garbage — **runs first so retro reads clean data** | Yes | No |
| 4a (§4a Daily Summary) | Batched summarization → daily file (watermark-scoped) | Yes | Yes (orchestrator) |
| 4b (§4b Extract from Daily) | Model reads daily, calls agentbridge-store | Yes | Yes (orchestrator) |
| 1 (§1 Retrospective) | Read **new messages only** (since watermark, noise-stripped), write retro, emotional attribution, update agent_notes | Yes | No |
| 9 (§5.5 Retro Extract) | Extract lessons/mistakes from retro with emotion scoring | Yes | No |
| 3 (§3 Reminders) | Extract todos | Yes | No |

**Reordered from current:** GC noise runs first (was step 4c, now first). Daily summary + extraction run before retro (was after). Retro now reads clean, watermark-scoped messages instead of all messages including noise. This is why the current retro takes 20 minutes on slower models — it reads everything.

**⚠️ GC → Daily Summary dependency:** GC marks messages in `garbage.json` but `buildDailySummary` doesn't filter them out (bug — task 0c). After fix: daily summary skips garbage-marked messages, retro reads only clean data. Both bugs (0b watermark + 0c garbage filter) must ship before the reordering has effect.

**Key property:** Steps have ordering dependencies (GC before daily, daily before retro, retro before retro-extract). Must run sequentially within the phase.

**Essential steps:** 4a, 4b, 1, 9. If these fail, catch-up is needed.

### Phase 2: Curate (quality — all idempotent)

| Current step | What | LLM needed | Code-driven |
|---|---|---|---|
| 2 (§2 Feedback) | Boost/demote recalled memories | Yes | No |
| 15 (§8e Topic Assignment) | Tag untagged memories | Yes | No |
| 16 (§8f Core Promotion) | Promote general → core (budget: 100) | Yes | No |
| 17 (§8g Temporal Review) | Invalidate stale core facts | Yes | No |
| 20 (§8j Contradiction Check) | Check core conflicts before promotion | Yes | No |
| 10 (§8 Merge) | Near-duplicate merge (max 5) | Yes | No |
| 7c (§7c Translation) | Fix bilingual quality | Yes | No |
| 18 (§8h Emotion/Flags Backfill) | Backfill legacy memories | No | Yes (pure regex) |
| 19 (§8i Compression Backfill) | ABM-L compress | No | Yes (pure regex) |
| 23 (§8m Entity Review) | Fix ABM-L references | Yes | No |
| 21 (§8k Emotional Arcs) | Per-topic trajectory | No | Yes (buildArc) |
| 7 (§7 Darwinism) | Fitness review, prune weak | Yes | No |
| 7b (§7b Core Knowledge) | Review core knowledge files | Yes | No |
| 14 (§8d Skill Review) | Review for reusable patterns | Yes | No |

**Key property:** No ordering dependencies between these. All idempotent — if skipped, next night catches up. Many can be combined into a single prompt.

**Code-driven subset (no LLM):** Emotion/flags backfill, compression backfill, emotional arcs. These can run as TypeScript before the LLM prompt, reducing what the LLM needs to do.

### Phase 3: Maintain (housekeeping)

| Current step | What | LLM needed | Code-driven |
|---|---|---|---|
| 22 (§8l Memory Aging) | Three-tier aging, pressure-based | No | Yes (pure SQL) |
| 11 (§9 Consolidation) | Weekly/quarterly rollups | Yes | Partially |
| 12 (§9.5 Media Cleanup) | FIFO 100MB | No | Yes (filesystem) |
| 8 (§7.5 Anomaly Audit) | CIA-AAA attribute audit | Yes | No |
| 5 (§5 Cron Verify) | Cross-check reminders vs cron | Yes | No |
| 6 (§6 Topic Reorg) | Topic file maintenance | Yes | No |

**Key property:** Mix of code-driven and LLM-driven. Code-driven steps can run without spawning a kiro-cli session.

### Phase 4: Report

| Current step | What | LLM needed | Code-driven |
|---|---|---|---|
| 13 (§10 Report) | Self-review, fix missed items, write audit | Yes | Partially |

**Key property:** Could be fully code-driven — aggregate results from phases 1-3 into an audit file. LLM self-review is nice but not essential.

---

## Proposed architecture

```
Sleep trigger
  │
  ├── State snapshot (SleepStateGatherer — per-phase subsets)
  │
  ├── Phase 1: EXTRACT (1 agent session, Dreamy role)
  │     ├── [bridge-injected: Dreamy persona + Phase 1 state snapshot]
  │     ├── 🤖 GC Noise (strip garbage FIRST — clean data for retro)
  │     ├── 🤖 Daily Summary (code-driven orchestrator, watermark-scoped)
  │     ├── 🤖 Extract from Daily (code-driven orchestrator)
  │     ├── 🤖 Retrospective (NEW messages only, noise-stripped)
  │     ├── 🤖 Retro Extract (lessons from retro)
  │     └── 🤖 Reminders
  │     Session destroyed. Results written to disk.
  │
  ├── Code-driven maintenance (NO agent session needed)
  │     ├── ⚙️ Emotion/Flags backfill (pure regex)
  │     ├── ⚙️ Compression backfill (pure regex)
  │     ├── ⚙️ Emotional arcs (buildArc per topic)
  │     ├── ⚙️ Memory aging (pure SQL)
  │     ├── ⚙️ Media cleanup (filesystem)
  │     └── ⚙️ effectiveConfidence decay (pure math)
  │
  ├── Phase 2: CURATE (1 agent session, Dreamy role)
  │     ├── [bridge-injected: Dreamy persona + Phase 2 snapshot + Phase 1 results]
  │     ├── 🤖 Batched curation (topics, promote, contradict, merge,
  │     │       translate, entity review, darwinism, feedback)
  │     ├── 🤖 Core knowledge review
  │     └── 🤖 Skill review
  │     Session destroyed. Results written to disk.
  │
  ├── Phase 3: MAINTAIN (1 agent session, Dreamy role — CONDITIONAL)
  │     ├── [bridge-injected: Dreamy persona + Phase 3 snapshot]
  │     ├── 🤖 Consolidation (weekly/quarterly rollups)
  │     ├── 🤖 Anomaly audit
  │     ├── 🤖 Cron verify
  │     └── 🤖 Topic reorg
  │     Skip entire phase if nothing needs doing.
  │
  └── Phase 4: REVIEW (Professor agent, not Dreamy)
        ├── ⚙️ Code writes raw audit file (aggregate phases 1-3)
        ├── 🧠 Audit injected to Professor as system message
        ├── 💬 Professor sends user "dream report" with summary
        ├── ⚠️ Flagged issues listed prominently
        ├── ⏱️ User has 5-min window before hardware sleep
        └── 🔮 Future: Professor triggers phase re-run if user flags issue
```

### Phase 4: Professor as supervisor

Dreamy's job ends after Phase 3. The Professor reviews the audit immediately after sleep completes:

- Code writes raw audit file (aggregate phases 1-3 results)
- Audit injected to Professor as system message
- Professor sends user a natural "dream report": "Oh I had a dream: extracted 5 memories, promoted 2 to core..."
- **Flagged issues listed prominently** — contradictions, failed steps, suspicious deletions, anything Dreamy was unsure about
- **Gated on `HARDWARE_SLEEP_AFTER_DREAMY`:** if false → dream report only, no sleep announcement, no hardware sleep. Platform-agnostic (replaces `MAC_SLEEP_AFTER_DREAMY`).
- **Gated on `MAC_SLEEP_AFTER_DREAMY`:** if false → dream report only, no sleep announcement, no `pmset sleepnow`
- Future: Professor can trigger targeted phase re-run if user flags an issue
- Hardware sleep timer already implemented

### Key changes from current

| Aspect | Current (24 steps) | Proposed (4 phases) |
|---|---|---|
| kiro-cli sessions | 1 (all steps in one session) | 2-3 (one per LLM phase, Phase 3 conditional) |
| Context accumulation | Steps 1-24 all in one context window | Each phase starts fresh |
| Code-driven steps | Mixed into LLM conversation | Extracted to run between phases (no LLM cost) |
| Phase 2 curation | 14 separate prompts | 1-3 focused prompts (batch curation) |
| Phase 4 report | LLM self-review | Code-driven aggregation |
| Failure recovery | Per-step retry + catch-up | Per-phase retry + catch-up (4 units, not 24) |
| Token cost | ~50-80K accumulated by step 20 | ~15-25K per phase (fresh context) |

### The big win: batched curation

Current Phase 2 sends 14 separate prompts. Each prompt:
1. Dreamy reads the task
2. Dreamy queries the DB (via tools)
3. Dreamy makes changes (via tools)
4. Response accumulates in context

By prompt 14, the context has 13 previous responses. Most of that is noise — "I reviewed 5 memories and assigned topics to 3 of them" repeated 14 times.

**Batched approach:** One prompt with a clear task list + a pre-queried batch of memories needing attention. The code pre-selects:
- Memories without topics
- General-tier memories with high recall_count (promotion candidates)
- Core memories older than 30 days (temporal review candidates)
- Memories with >60% content overlap (merge candidates)

Dreamy gets one focused prompt with the data already prepared. Less tool-calling, less context waste, more focused LLM attention.


## Prompt file disposition

28 files in `persona/prompts/sleep/`. What happens to each:

### Kept (used by Phase 1)

| File | Phase 1 step |
|---|---|
| `04c-gc-noise.md` | GC Noise (1st prompt) |
| `01-retrospective.md` | Retrospective (update: watermark-scoped, noise-filtered) |
| `10-retro-extract.md` | Retro Extract |
| `03-reminders.md` | Reminders |

`04a-daily-summary.md` and `04b-extract-from-daily.md` are already code-driven — prompts used internally by the orchestrator, not as standalone step files. Kept as-is.

### Merged into batched curation prompts (Phase 2)

These 14 files become 2-3 focused prompts:

| Files merged | New prompt |
|---|---|
| `02-feedback.md`, `16-topic-assignment.md`, `17-core-promotion.md`, `18-temporal-review.md`, `21-contradiction.md` | `phase2-curation-promote.md` — topics, promote, contradict, temporal, feedback |
| `11-merge.md`, `08c-translation-check.md`, `08a-darwinism.md`, `24-entity-review.md` | `phase2-curation-quality.md` — merge, translate, darwinism, entity review |
| `08b-core-knowledge.md`, `15-skill-review.md` | Kept as separate prompts (distinct tasks) |

### Kept (used by Phase 3)

| File | Phase 3 step |
|---|---|
| `12-consolidation.md` | Consolidation |
| `09-anomaly-audit.md` | Anomaly audit |
| `06-cron-verify.md` | Cron verify |
| `07-topic-reorg.md` | Topic reorg |

### Removed (replaced by code-driven steps)

| File | Replaced by |
|---|---|
| `00-identity.md` | Bridge-injected session context (future: agent registry) |
| `19-emotion-flags.md` | Code-driven: `detectEmotions()` + `detectFlags()` |
| `20-compress-backfill.md` | Code-driven: `compress()` |
| `22-emotion-arcs.md` | Code-driven: `buildArc()` |
| `23-memory-aging.md` | Code-driven: `ageMemoryTiers()` |
| `13-media-cleanup.md` | Code-driven: filesystem FIFO |
| `14-report.md` | Code-driven: audit aggregation + Professor review |

---
---

## Risk mitigation

**"Battle-tested" concern:** The current 24 steps work. Changing them risks regressions.

**Mitigation:**
1. Phase 1 (Extract) is the most critical and changes the least — same steps, same order, just in a fresh session. Ship this first.
2. Code-driven extraction (backfill, aging, arcs, cleanup) is pure TypeScript — testable without LLM, no regression risk.
3. Phase 2 (Curate) is the biggest change. Run old and new in parallel for 1 week — compare audit outputs.
4. Phase 3 and 4 are low-risk — consolidation and reporting.

**Incremental rollout:**
1. Extract code-driven steps out of the LLM conversation (no behavior change, just runs them as TypeScript between prompts)
2. Split into 2 sessions: Extract (steps 1-9) + Everything Else (steps 10-24)
3. Batch the curation prompts in session 2
4. Split session 2 into Curate + Maintain
5. Make Phase 4 code-driven

Each step is independently shippable and testable.

---

## Implementation Tasks

| # | Task | Effort | Depends on |
|---|---|---|---|
| 0 | ~~Unified agent registry~~ **Moved to separate backlog item.** Good infrastructure but not a sleep simplification — benefits all agents. Sleep orchestrator creates fresh transports per phase the same way it does now. | — | — |
| 0b | **BUG FIX — ✅ SHIPPED:** Retro reads pre-queried watermark-scoped messages. `${RETRO_MESSAGES}` injected into prompt — LLM no longer queries DB directly. Garbage-filtered, system messages stripped. | 30min | — |
| 0c | **BUG FIX — ✅ SHIPPED:** `buildDailySummary` filters garbage-marked messages via `loadGarbageIds()`. GC → Daily Summary reordering now works. | 30min | — |
| 0d | **Telemetry — ✅ SHIPPED:** `ctxBefore`/`ctxAfter` per step in lock file. First night of data validates tiering estimates. | 15min | — |
| 1 | Extract code-driven steps into standalone functions: emotion/flags backfill, compression backfill, emotional arcs (buildArc), memory aging, media cleanup, effectiveConfidence decay | 2hr | Item #6 (effectiveConfidence wiring) |
| 2 | Modify orchestrator to run code-driven steps between LLM prompts (no behavior change — same steps, just TypeScript instead of LLM) | 1hr | 1 |
| 3 | Split into 2 sessions: Extract (steps 1-9) + Curate+Maintain (steps 10-24). Fresh context for session 2. | 1.5hr | 2 |
| 3b | Per-phase state snapshots: split `SleepStateGatherer` output into phase-relevant subsets. Phase 1 gets message counts + watermarks. Phase 2 gets memory stats + untagged counts + merge candidates. Phase 3 gets disk usage + consolidation dates. Less tokens per prompt, more focused LLM. Phase result files already persist for a day — Phase 2 reads Phase 1's output from disk. | 1hr | 3 |
| 4 | Batch Phase 2 curation: pre-query candidates, batch into 2-3 focused prompts (10-15 memories each). Don't overload one prompt with 50 memories — sloppy results. E.g. prompt 1: topics+promote+contradict, prompt 2: merge+translate+darwinism, prompt 3: entity+feedback. | 2hr | 3 |
| 5 | Make Phase 3 conditional: skip if no consolidation due + no anomalies | 30min | 3 |
| 6 | Phase 4 review: code writes raw audit file after Phase 3. Inject audit to Professor as system message (immediately after sleep). Professor reviews, sends user a natural "dream report" message with summary. Must highlight flagged issues prominently — contradictions, failed steps, suspicious deletions. **Gate on `HARDWARE_SLEEP_AFTER_DREAMY`:** if true → include "going to sleep in 5 min" + platform-specific sleep call (pmset on Mac, systemctl suspend on Linux). If false → dream report only, skip sleep announcement and hardware sleep. Rename from `MAC_SLEEP_AFTER_DREAMY` — platform-agnostic. Already implemented: hardware sleep timer + wake-up announcement. | 1hr | 3 |
| 7 | Update lock file format: phase-based instead of step-based. Existing lock tracking + global state infrastructure stays — just update granularity from 24 steps to 4 phases. Per-phase token limits as normal control. **Keep global 12-call hard cap as emergency brake** — belt and suspenders, justified after burning a night of tokens. | 1hr | 3 |
| 8 | Implement SLEEP_QUALITY tiering (budget/normal/ultimate) + SLEEP_CURATION_DAY config. Model selection uses existing `SLEEP_MODEL` env — no new config. | 1hr | 3-5 |
| 9 | Run parallel comparison: old 24-step vs new 4-phase for 1 week, compare audit outputs | ongoing | 4-8 |
| 10 | Update as-built doc | 30min | 9 |

**Total: ~14hr** (spread across incremental rollout, task 0b ships immediately)

Branch: `simplify/sleep-phases`

---

## Validation

- **Extraction quality:** Compare daily summaries and extracted memories (old vs new) for same day's messages
- **Curation quality:** Compare audit outputs — topics assigned, memories promoted, merges performed
- **Token cost:** Measure total tokens consumed per sleep cycle (old vs new)
- **Wall time:** Measure total sleep duration (old vs new)
- **Completion rate:** Track phase success/failure rates over 1 week
- **Catch-up:** Verify phase-based catch-up works for missed days

---

## SLEEP_QUALITY Tiering

```env
SLEEP_QUALITY=normal          # budget | normal | ultimate
SLEEP_CURATION_DAY=sunday     # which day Phase 2 runs (normal tier only)
SLEEP_MODEL=<existing env>    # model for Dreamy — unchanged
```

### Budget — minimum viable sleep

```
Phase 1 (minimal extraction):
  🤖 GC Noise
  🤖 Daily Summary
  🤖 Extract from Daily

Code-driven (free, every night):
  ⚙️ all 6 steps

Phase 2: skip
Phase 3: skip
Phase 4: code audit only (no Professor review)

→ 3 LLM calls/night
  Facts captured. No self-reflection, no lessons, no curation.
```

### Normal (default) — daily extraction, weekly curation

```
Phase 1 (full, every night):
  🤖 GC Noise
  🤖 Daily Summary
  🤖 Extract from Daily
  🤖 Retrospective
  🤖 Retro Extract
  🤖 Reminders

Code-driven (free, every night):
  ⚙️ all 6 steps

Phase 2 (weekly, on SLEEP_CURATION_DAY):
  🤖 Batched curation
  🤖 Core knowledge review
  🤖 Skill review

Phase 3: when needed (consolidation due, anomalies)
Phase 4: code audit + Professor dream report

→ 6 LLM calls/night, +3 on curation day
  Full extraction + reflection daily. Curation weekly.
```

### Ultimate — everything, every night

```
Phase 1 (full):               6 LLM calls
Code-driven (free):           0 LLM calls
Phase 2 (full):               3 LLM calls
Phase 3 (when needed):        0-4 LLM calls
Phase 4: code audit + Professor dream report

→ 9-13 LLM calls/night. Everything, every night.
```

### Token estimates

| Tier | LLM calls/night | Est. tokens/night | Monthly (30 nights) |
|---|---|---|---|
| Budget | 3 | ~8-15K | ~250-450K |
| Normal | 6 (+3 weekly) | ~15-30K | ~550K-1M |
| Ultimate | 9-13 | ~30-55K | ~1-1.8M |

### What runs on ALL tiers (free, code-driven)

Every night, regardless of SLEEP_QUALITY:
- Emotion/flags backfill (pure regex)
- Compression backfill (pure regex)
- Emotional arcs — buildArc per topic (pure math)
- Memory aging — three-tier, pressure-based (pure SQL)
- Media cleanup — FIFO 100MB (filesystem)
- effectiveConfidence decay (pure math)

Zero LLM cost. ~300ms total. Memory stays healthy even on Budget.

---

## Decision Log

| # | Item | Decision | Date | Notes |
|---|---|---|---|---|
| 0 | Agent registry | Moved to backlog | 2026-04-09 | Not a sleep simplification |
| 0b | Retro watermark fix | ✅ Shipped | 2026-04-09 | `${RETRO_MESSAGES}` pre-queried |
| 0c | Daily summary garbage filter | ✅ Shipped | 2026-04-09 | `loadGarbageIds()` in buildDailySummary |
| 0d | Sleep telemetry | ✅ Shipped | 2026-04-09 | ctxBefore/ctxAfter per step |
| 1-10 | Phase refactor | Approved | 2026-04-09 | Incremental rollout, start after telemetry data |

## Already shipped (infrastructure)

These were shipped as part of the sleep stability work before the phase refactor:

| Item | What | Date |
|---|---|---|
| Lock file global status | `status: ongoing\|completed\|suspended\|failed` | 2026-04-09 |
| LLM call budget | `SLEEP_MAX_LLM_CALLS=12` hard cap, `suspended` on exhaust | 2026-04-09 |
| Duplicate spawn prevention | `hasSleepAuditToday()` checks pid alive + status | 2026-04-09 |
| Bedtime tick loop fix | `isDailyCycleDue()` checks lock status, stops at completed/suspended | 2026-04-09 |
| Sleep announcement timing | Post-Dreamy + 5min grace period, user can interrupt | 2026-04-09 |
| Per-step log files | `sleep/<YYYYMMDD>/<NN>-<step-name>.md` | 2026-04-09 |
| Sleep model | Changed to `qwen3-coder-next` (5x cheaper than deepseek-3.2) | 2026-04-09 |

---

## First Night Telemetry (2026-04-10)

Real data from the first night with telemetry, budget safety, and retro watermark fix.

### Raw results

```
Status: suspended (LLM budget hit at call 13/12)
Model: minimax-m2.5:cloud (BUG: used main model, not AGENT_SLEEP_MODEL)

Step                  Status    Duration   Context
identity              ok          0.8s     -1% → 1%
retrospective         ok         39.8s      1% → 14%    ← was 20min before watermark fix!
feedback              ok         63.4s     14% → 20%
reminders             ok         10.7s     20% → 23%
04a-daily-summary     ok         31.8s     (code-driven, separate ctx)
04b-extract           ok         30.1s     (code-driven, separate ctx)
04c-gc-noise          ok        112.6s     27% → 32%
cron-verify           ok          7.0s     32% → 33%
topic-reorg           skipped
darwinism             ok         28.8s     33% → 34%
core-knowledge        ok          5.5s     34% → 35%
translation-check     ok          6.8s     35% → 35%
anomaly-audit         ok         20.3s     35% → 37%
retro-extract         failed               37% → 37%    ← budget exhausted here
```

13 LLM calls, 12 steps attempted, context peaked at 37%. Total wall time: ~6 min.

### How 4-phase design would have performed

**Phase 1: EXTRACT (fresh session)**
```
GC noise          112.6s   0% → 5%     (runs first — clean data for retro)
04a daily summary  31.8s   (code-driven)
04b extract        30.1s   (code-driven)
retrospective      39.8s   5% → 18%    (reads clean, watermark-scoped messages)
retro-extract       ?.?s   18% → ~22%  (would have succeeded — budget not hit yet)
reminders          10.7s   22% → ~25%
                                        Session destroyed. 6 LLM calls.
```

**Code-driven (free, no session)**
```
Emotion/flags backfill, compression, arcs, aging, cleanup, confidence decay
~300ms total, 0 LLM calls
```

**Phase 2: CURATE (fresh session — weekly only on normal tier)**
```
feedback           63.4s   0% → 6%     (fresh context!)
darwinism          28.8s   6% → 7%
core-knowledge      5.5s   7% → 8%
translation-check   6.8s   8% → 8%
anomaly-audit      20.3s   8% → 10%
                                        Session destroyed. 5 LLM calls.
```

**Phase 3: MAINTAIN (conditional — skip if nothing needed)**
```
cron-verify         7.0s   (only step — could be code-driven)
                                        1 LLM call, or skip entirely.
```

### Comparison

| Metric | Current (single session) | 4-phase design |
|---|---|---|
| LLM calls | 13 (suspended at 12) | 12 (all complete) |
| Peak context | 37% (accumulated) | ~25% Phase 1, ~10% Phase 2 |
| retro-extract | ❌ Failed (budget) | ✅ Would succeed (within Phase 1 budget) |
| Context waste | Steps 10-13 see 30%+ of irrelevant prior responses | Each phase starts fresh |
| Wall time | ~6 min | ~6 min (same steps, different order) |

### With SLEEP_QUALITY tiering

| Tier | What runs | LLM calls | Would complete? |
|---|---|---|---|
| Budget | GC + daily + extract only | 3 | ✅ Yes, well within 12 |
| Normal | Phase 1 full (6) + Phase 2 weekly (5) | 6 nightly, 11 on curation day | ✅ Yes |
| Ultimate | All phases every night | 12 | ✅ Yes, exactly at budget |

### Validated estimates

The token estimates from the plan were close:
- Budget (3 calls): confirmed feasible
- Normal (6+3 weekly): confirmed — Phase 1 is 6 calls
- Ultimate (9-13): confirmed — 12 calls covers everything

### Bugs found

1. **Sleep model override not working**: `DirectApiTransport` used main model (`minimax-m2.5:cloud`) instead of `AGENT_SLEEP_MODEL=qwen3-coder-next`. The `createSleepTransport()` passes the model but DirectApiTransport config needs it in the constructor.
2. **15 BRIDGE STARTs**: Dark wake restart loop still happening (watchdog issue — separate from sleep).
3. **GC noise ran after retro**: Current step order has GC at step 4c (after retro). Phase 1 reorders GC first — retro reads cleaner data.

### Retro watermark fix impact

**Before fix (2026-04-09):** identity step took 1252s (20 min) — retro read ALL messages.
**After fix (2026-04-10):** retrospective took 39.8s — reads only watermark-scoped, noise-stripped messages.

**32× faster.** The single highest-impact fix in the entire sleep redesign.
