# ABM Simplification — Counter-Discussion

**Date:** 2026-04-09
**Context:** Review feedback on `abm-simplification.md` proposals

---

## Fully agree

**#1 Recall pipeline** — Fixes a real user-facing bug (válókezelő), biggest simplification, benchmark-backed. No objections.

**#6 Dead schema** — Free cleanup. No risk.

**#7 Emotion: 25 → single score** — The MemPalace benchmark is convincing. 25 regex-based emotion types add complexity for no measurable recall benefit. Keep emotion_score for flashbulb protection, drop the tagger. Clean.

---

## Agree with caveats

**#4 Sleep: 24 → 4 phases** — Conceptually right. Context accumulation across 24 steps is fragile and expensive. But this is the biggest refactor on the list. Should be done AFTER #1 is validated, not in parallel. Also: the current 24 steps are battle-tested and the sleep system works. Don't rush this.

**#2 Store English, Compress on Read** — The "improvements apply retroactively" argument is compelling. But the aging model depends on ABM-L surviving after English is NULLed. If you compress on read, you need English to survive forever (or at least much longer). The suggestion to keep a one-sentence summary instead of NULLing is a good middle ground, but that's a different aging model than what's built. Mark this as "nice to have" — the current store-time compression works, and backfills are a one-time cost.

---

## Skeptical

**#3 CIA-AAA → confidence + sensitive** — The current system is overkill for single-user, yes. But it's already built and tested. Simplifying it means a migration, updating every store/edit/recall path, and rewriting sleep audit steps. The ROI is low — these fields don't cause bugs or performance issues. Leave it unless it's actively blocking something.

**#5 Drop IPC** — WAL handles concurrent reads, but concurrent writes from CLI tools (store, edit, task) while the bridge holds the DB open can still hit SQLITE_BUSY. The IPC layer solves a real problem. Removing it and hoping WAL is enough feels risky. Keep it unless the IPC code is causing maintenance pain.

---

## Recommended priority order

| Priority | Item | Rationale |
|---|---|---|
| 1 | #1 Recall pipeline | Fixes real user-facing bug, biggest simplification |
| 2 | #6 Dead schema | Free cleanup, no risk |
| 3 | #7 Emotion | Low-risk simplification |
| 4 | #4 Sleep phases | High impact but high effort — do after #1 is stable |
| 5 | #2, #3, #5 | Lower priority, valid counter-arguments exist |
