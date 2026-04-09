# ABM Simplification #4 — Sleep: 24 Steps → 4 Phases

**Date:** 2026-04-09
**Status:** Planning
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
  ├── State snapshot (SleepStateGatherer — unchanged)
  │
  ├── Phase 1: EXTRACT (1 kiro-cli session)
  │     ├── Identity prompt (Dreamy rules + state snapshot)
  │     ├── GC Noise prompt (strip garbage FIRST — clean data for retro)
  │     ├── Daily Summary (code-driven, batched, watermark-scoped)
  │     ├── Extract from Daily (code-driven)
  │     ├── Retrospective prompt (NEW messages only, noise-stripped, watermark-scoped)
  │     ├── Retro Extract prompt (extract lessons from retro)
  │     └── Reminders prompt
  │     Session destroyed after phase completes.
  │
  ├── Code-driven maintenance (NO kiro-cli needed)
  │     ├── Emotion/Flags backfill (pure regex)
  │     ├── Compression backfill (pure regex)
  │     ├── Emotional arcs (buildArc per topic)
  │     ├── Memory aging (pure SQL)
  │     ├── Media cleanup (filesystem)
  │     └── effectiveConfidence decay (pure math)
  │
  ├── Phase 2: CURATE (1 kiro-cli session)
  │     ├── Identity prompt (Dreamy rules + state snapshot + Phase 1 results)
  │     ├── Single curation prompt:
  │     │     "Here are memories needing curation. For each:
  │     │      - Assign topics to untagged
  │     │      - Promote worthy to core (budget: 100)
  │     │      - Check contradictions in core
  │     │      - Merge near-duplicates (max 5)
  │     │      - Fix translations
  │     │      - Review entity references
  │     │      - Prune weak memories (Darwinism)
  │     │      - Boost/demote based on recall feedback"
  │     ├── Core knowledge review prompt
  │     └── Skill review prompt
  │     Session destroyed after phase completes.
  │
  ├── Phase 3: MAINTAIN (1 kiro-cli session, only if needed)
  │     ├── Consolidation (weekly/quarterly rollups)
  │     ├── Anomaly audit
  │     ├── Cron verify
  │     └── Topic reorg
  │     Skip entire phase if no consolidation due + no anomalies + no cron changes.
  │
  └── Phase 4: REVIEW (main agent, after sleep completes)
        ├── Code writes raw audit file (aggregate phases 1-3 results)
        ├── Audit injected to main agent as system message (immediately, not at wake-up)
        ├── Main agent reviews what Dreamy did, flags issues to user
        └── Future: main agent can trigger targeted phase re-run if issues found
```

### Phase 4: Main agent as supervisor

Dreamy's job ends after Phase 3. The main agent reviews the audit immediately after sleep completes — not at next wake-up. This makes the main agent the **supervisor** of the sleep cycle:

- Dreamy does the work (phases 1-3)
- Main agent quality-checks it (phase 4)
- Future enhancement: if the main agent spots an issue (e.g. stale fact promoted to core), it can trigger a targeted re-run of that specific phase without waiting for the next night

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
| 1 | Extract code-driven steps into standalone functions: emotion/flags backfill, compression backfill, emotional arcs (buildArc), memory aging, media cleanup, effectiveConfidence decay | 2hr | Item #6 (effectiveConfidence wiring) |
| 2 | Modify orchestrator to run code-driven steps between LLM prompts (no behavior change — same steps, just TypeScript instead of LLM) | 1hr | 1 |
| 3 | Split into 2 sessions: Extract (steps 1-9) + Curate+Maintain (steps 10-24). Fresh context for session 2. | 1.5hr | 2 |
| 4 | Batch Phase 2 curation: pre-query candidates, single focused prompt instead of 14 separate prompts | 2hr | 3 |
| 5 | Make Phase 3 conditional: skip if no consolidation due + no anomalies | 30min | 3 |
| 6 | Phase 4 review: code writes raw audit file after Phase 3. Inject audit to main agent as system message (immediately after sleep, not at wake-up). Main agent reviews and flags issues. | 1hr | 3 |
| 7 | Update lock file format: phase-based instead of step-based | 1hr | 3 |
| 8 | Run parallel comparison: old 24-step vs new 4-phase for 1 week, compare audit outputs | ongoing | 4-7 |
| 9 | Update as-built doc | 30min | 8 |

**Total: ~10hr** (spread across incremental rollout)

Branch: `simplify/sleep-phases`

---

## Validation

- **Extraction quality:** Compare daily summaries and extracted memories (old vs new) for same day's messages
- **Curation quality:** Compare audit outputs — topics assigned, memories promoted, merges performed
- **Token cost:** Measure total tokens consumed per sleep cycle (old vs new)
- **Wall time:** Measure total sleep duration (old vs new)
- **Completion rate:** Track phase success/failure rates over 1 week
- **Catch-up:** Verify phase-based catch-up works for missed days
