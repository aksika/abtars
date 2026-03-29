# Sleep Cycle Refactor — Multi-Turn Conversation

**Created:** 2026-03-29
**Status:** Not started

## Problem

The current sleep cycle is a single 400+ line monolith prompt. Dreamy often skips or half-asses later steps (context fatigue). If it fails mid-way, everything is lost. Can't conditionally skip steps. Hard to debug.

## Architecture

Replace the monolith with a multi-turn conversation — a series of focused prompts sent sequentially into the same kiro-cli session.

```
Transport spawns → Session created

Prompt 0: Identity + rules + state snapshot
Prompt 1: §1 Retrospective
Prompt 2: §2 Feedback pass
...
Prompt N: §13 Report (self-review + write audit)

Transport destroyed → Wake-up prompt to KP
```

Same session, same context window. Each step's response accumulates in context, so later steps know what earlier steps did. Zero extra kiro-cli spawns.

## Step Files

```
persona/sleep/
  00-identity.md          # Who Dreamy is, rules, tools, state snapshot template
  01-retrospective.md     # §1 — read messages, write retro, emotional attribution
  02-feedback.md          # §2 — boost/demote recalled memories
  03-reminders.md         # §3 — extract todos and reminders
  04-gc.md                # §4 — 7-step garbage collection
  05-db-maintenance.md    # §4+ — WAL, FTS rebuild, batch embed
  06-cron-verify.md       # §5 — cross-check cron entries
  07-topic-reorg.md       # §6 — topic file maintenance
  08-fitness.md           # §7 — Darwinism review, core knowledge, translation fixes
  09-anomaly-audit.md     # §7.5 — CIA-AAA attribute audit (daily)
  10-retro-extract.md     # §5.5 — extract durable facts from retro (replaces regex hack)
  11-merge.md             # §8 — near-duplicate memory merge
  12-consolidation.md     # §9 — daily/weekly/quarterly summaries
  13-media-cleanup.md     # §9.5 — FIFO 100MB cleanup
  14-report.md            # §10 — self-review, fix missed items, write audit
```

## Identity Prompt (00-identity.md)

Sets the tone for the entire session:
- You are Dreamy, KP's sleep maintenance agent
- You are running unsupervised — no human in this conversation
- Do not ask questions or wait for confirmation
- Act on your best judgment
- If unsure about a destructive action → skip and flag
- Available tools: agentbridge-edit, agentbridge-store, agentbridge-recall, agentbridge-todo, sqlite3, bash
- Convention: accumulate "Flagged for Review" items throughout all steps
- If instructions are ambiguous, note in report what needs clarification
- State snapshot: [injected from SleepStateGatherer]

## Conditional Skip Logic (TypeScript, not prompt)

The CLI decides which steps to skip based on state snapshot:

| Step | Skip condition |
|------|---------------|
| 02-feedback | No agentbridge-recall invocations in today's messages |
| 05-db-maintenance | FTS healthy AND no NULL embeddings |
| 07-topic-reorg | No topic files exist |
| 11-merge | <10 extracted memories |
| 13-media-cleanup | No received/ dir or under 100MB |

## Retry Logic

Each step gets up to 3 attempts with 5-min timeout:

```
attempt 1 → timeout → retry
attempt 2 → timeout → retry
attempt 3 → timeout → log failure, skip step
```

Failed steps are logged in the audit but don't kill the cycle. This is the key improvement over the monolith — a timeout at step 3 no longer means steps 4-14 never happen.

## Per-Step Outcome Tracking

The CLI measures each step:
- Duration (wall clock)
- Attempt count
- Response length
- Success/failure/skipped

Audit log becomes a structured table in the sleep audit file.

## Report Step (14-report.md)

The final prompt includes: "If you notice anything you missed or should have done differently, fix it now before writing the report."

Dreamy has full conversation history at this point — all prompts + all responses. The report IS the self-review. Dreamy can proactively go back and fix things it missed.

## Retro-Extract (10-retro-extract.md)

Replaces the fragile Phase 5.5 regex parser in TypeScript. Dreamy reads its own retro and stores durable facts via agentbridge-store. LLM understands its own writing better than regex.

## Memory Anomaly Audit (09-anomaly-audit.md)

Runs daily (not just Sundays). Checks:
1. Default attributes (trust=0, credibility=6, integrity=2 — never tagged)
2. Decisions at classification=0
3. Personal facts at low classification
4. Trust mismatches (KP decisions at trust=0)
5. Stale credibility=6 on old memories
6. NULL embeddings
7. Orphan entities
8. Exact duplicate content

Auto-fixes confident cases. Flags uncertain ones in "Flagged for Review".

## Flagged for Review Convention

Any step can flag items. Accumulated throughout the session. Written to retro file under `## Flagged for Review`. KP picks up on wake-up, discusses with user.

## Files to Create/Modify

1. **New:** `persona/sleep/*.md` — 15 step files
2. **New:** `skills/memory-anomalies.md` — anomaly definitions (reference for Dreamy + KP)
3. **Modify:** `src/cli/agentbridge-sleep.ts` — multi-turn loop, retry, per-step timing, skip logic
4. **Modify:** `src/components/sleep-prompt-loader.ts` — load individual step files + variable substitution
5. **Delete:** `persona/sleeping_prompt.md` — replaced by step files
6. **Modify:** `docs/asbuilts/memory.asbuilt.md` — update sleep section

## Migration

- Old `sleeping_prompt.md` content is split across the 15 step files
- No DB changes
- No config changes
- Backward compatible — same trigger, same audit output location
