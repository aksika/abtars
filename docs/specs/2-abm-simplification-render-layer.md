# ABM Simplification #2 — ABM-L as Render Layer + Memory Timelines

**Date:** 2026-04-09
**Status:** Planning
**Master plan:** `abm-simplification.md`
**Previously:** Closed as "resolved by #1." Reopened with new framing.

---

## Reframing

Original #2: "store English, compress on read." Closed because content_en preserved forever resolved the main pain point.

**New framing:** ABM-L's value is context window efficiency at read time, not storage savings. Plus: memory timelines as a higher-level narrative compression that also enables smarter deduplication.

---

## Part A: ABM-L as render layer

### Problem with current approach (store-time compression)

- Compression bugs baked into stored data permanently
- Backfill sleep step needed when compressor improves
- Entity review sleep step needed to fix @reference anomalies
- `content_compressed` column maintained alongside `content_en`
- ABM-L FTS5 index (already dropped in #1)

### Proposed: compress on read

- **Store:** English only (`content_en`). Drop `content_compressed` column via migration.
- **Render:** When wake-up builder or recall engine needs ABM-L, compress on the fly from `content_en`.
- **No cache.** Render is 1-5ms per memory. Not worth caching.

**What this kills:**
- `content_compressed` column — dropped via migration
- Compression backfill sleep step (20-compress-backfill.md)
- Entity review sleep step (24-entity-review.md) — no stored ABM-L to get stale
- Store-time compression call in `instantStore()` — simpler store path
- `abml_fts` triggers (already dropped in #1, but triggers may remain)

**What this keeps:**
- The compressor (`memory-compressor.ts`) — same code, just called at read time
- Emotion tagger + importance flagger — still run at store time (cheap, used by other features)
- Signature generator — still runs at store time (used by search)

**Existing data:** 93 memories have stored `content_compressed`. Ignored after migration — column dropped. No data loss, English is the source of truth.

**Performance:** 50 memories × 1-5ms = 50-250ms at session start. Acceptable. Recall renders 10 memories × 1-5ms = 10-50ms per recall. Negligible.

**Retroactive improvements:** When the compressor improves, ALL memories benefit immediately. No backfill. No migration. Just deploy the new compressor.

### Model-adaptive rendering

| Model tier | Wake-up rendering | Recall rendering |
|---|---|---|
| Frontier (Sonnet, Gemini 2.5 Pro) | ABM-L — saves tokens, no comprehension loss | ABM-L default, English with `--full` |
| Budget (deepseek, qwen, local llama) | English — better comprehension for weaker models | English default |

Configurable via existing `SLEEP_MODEL` / model detection. The wake-up builder checks the model and picks the rendering format.

---

## Part B: Memory Timelines — narrative compression

### The idea

Group related memories (same topic + overlapping entities) into chronological narrative arcs. Multiple memories become one timeline entry.

**Before (4 separate memories, ~40 tokens in ABM-L):**
```
[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
[M|coding|fear→relief|4|2026-02] auth migration complete — stressful→good
[L|coding|frust|3|2026-02] OAuth token refresh was root cause
[C|coding|—|5|2026-04] @auth0 >replaces @clerk (reversed decision)
```

**After (1 timeline, ~20 tokens):**
```
[TL|coding|auth] @auth0→issues(OAuth)→@clerk(pricing+DX)→back @auth0(reversed)
  arc: fear→relief→conviction→reversal | current: @auth0
```

4 memories → 2 lines. Same information. The LLM sees the full story arc.

### Three rendering levels

All rendered on the fly from stored English. Wake-up builder picks level based on context budget:

```
L0 — Signal (~3 tokens/memory):     [D|coding] @clerk
L1 — ABM-L (~10 tokens/memory):     [D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
L2 — Timeline (~5 tokens/memory):   [TL|coding|auth] @auth0→@clerk→back @auth0 | current: @auth0
L3 — English (~50 tokens/memory):   Full English text
```

| Context budget | Rendering strategy |
|---|---|
| <500 tokens (4K model) | L0 signal for all — agent sees topic map |
| 500-2K tokens (32K model) | L2 timelines for core, L0 for general |
| 2K-5K tokens (128K model) | L1 ABM-L for core, L2 timelines for general |
| >5K tokens (1M model) | L1 ABM-L for all, L3 English for recent |

### Timeline-based deduplication

Building timelines naturally exposes duplicates:

1. Group memories by topic + entity
2. Sort chronologically
3. If two entries in the same timeline say the same thing → merge candidate
4. If an entry contradicts an earlier one → the later one supersedes

This replaces the current merge step's approach (compare every pair for >60% content overlap). Timeline-based dedup is:
- **Cheaper:** only compares within a group, not all pairs
- **More accurate:** has topic + entity + temporal context
- **More natural:** duplicates are obvious when you see them in sequence

Dreamy's merge step becomes: "render timelines → flag redundant entries → merge or invalidate."

### Timeline building (code-driven, sleep time)

```typescript
function buildTimelines(memories: Memory[]): Timeline[] {
  // Group by topic + primary entity
  const groups = groupBy(memories, m => `${m.topic}:${primaryEntity(m)}`);
  
  // For each group with 2+ memories, build a timeline
  return Object.entries(groups)
    .filter(([, mems]) => mems.length >= 2)
    .map(([key, mems]) => ({
      topic: mems[0].topic,
      entity: primaryEntity(mems[0]),
      entries: mems.sort((a, b) => a.created_at - b.created_at),
      arc: buildArc(mems), // reuse existing buildArc()
      current: mems[mems.length - 1], // latest state
    }));
}
```

Pure TypeScript, no LLM. Runs during code-driven maintenance phase (between Phase 1 and Phase 2 in #4). Timelines are rendered at read time, not stored.

### Timelines in recall output

When a recalled memory belongs to a timeline, include the timeline context in the result. The agent sees where a single memory fits in the bigger story:

```
Query: "auth decision"
Result: [D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
Timeline: @auth0→issues(OAuth)→@clerk(pricing+DX)→back @auth0(reversed) | current: @auth0
```

The agent knows this decision was later reversed without needing a separate recall.

### ABM-L hint line — conditional

The format hint (`Memory format: [TYPE+FLAGS|topic|emotion|confidence|date]...`) is only injected when ABM-L is rendered. Budget models get English — no hint needed.

---

## What changes

| Component | Current | After |
|---|---|---|
| `instantStore()` | Runs compressor, stores `content_compressed` | Stores English only. Tagger + flagger + signature still run. |
| `content_compressed` column | Written at store time, read by wake-up + recall | **Dropped** via migration |
| Wake-up builder | Reads `content_compressed` from DB | Renders ABM-L/timeline on the fly from `content_en`. Model-adaptive. ABM-L hint conditional. |
| Recall engine | Returns `content_compressed` by default | Renders ABM-L on the fly from `content_en`. `--full` returns English. Timeline context included when available. |
| Sleep: compress-backfill | Runs nightly | Eliminated |
| Sleep: entity-review | Runs nightly | Eliminated |
| Sleep: merge | Compares all pairs for overlap | Timeline-based: group → compare within group |
| Compressor code | Called at store time | Called at render time (same code, different caller) |

---

## Implementation Tasks

| # | Task | Effort | Depends on |
|---|---|---|---|
| 0 | Fix compressor filler bug: stop stripping meaningful verbs (is, are, was, should, will, could). Split FILLER regex into safe-to-strip (basically, essentially, actually, really, very, just, quite) and keep (verbs that carry meaning). | 15min | — |
| 1 | Migration: drop `content_compressed` column + remove abml_fts triggers (if any remain from #1). Update `instantStore()` to stop calling compressor. | 30min | — |
| 2 | Update wake-up builder: render ABM-L on the fly from `content_en` using compressor. Model-adaptive: ABM-L for frontier, English for budget models. ABM-L hint line only when ABM-L rendered. | 1hr | 0, 1 |
| 3 | Update recall engine: all stages return `content_en`. Render ABM-L on the fly for default output. `--full` returns `content_en` directly. | 30min | 0, 1 |
| 4 | Remove compress-backfill sleep step (20-compress-backfill.md) and entity-review sleep step (24-entity-review.md) — no longer needed | 15min | 1 |
| 5 | `timeline-builder.ts` — group memories by topic+entity, sort chronologically, build narrative arcs. Threshold: 2+ memories per group. Pure TypeScript, no LLM. Reuses `buildArc()`. | 1.5hr | #7 (buildArc — done) |
| 6 | Timeline rendering in wake-up builder — L2 level, used when budget allows | 1hr | 5 |
| 7 | Timeline context in recall output — when a recalled memory belongs to a timeline, include the timeline summary alongside the result | 1hr | 5 |
| 8 | Timeline-based dedup in Dreamy merge step — replace pair comparison with group comparison | 1hr | 5 |
| 9 | Update as-built doc | 30min | 1-8 |

**Total: ~7.5hr**

Branch: `improve/abml-render-layer`

---

## Nice to Have (future)

| Item | Description |
|---|---|
| Weekly timeline from dailies | Compress a week of daily summaries into one narrative timeline. "Mon: refactor started → Tue: tests broken → Wed: fixed, shipped → Thu: user feedback positive." Richer than current weekly rollup. |
| L0 signal level for meta-queries | `[D\|coding] @clerk [F\|personal] @user [M\|projects] @agentbridge` — the agent sees its entire memory as a structured tag cloud in ~100 tokens. Enables "what do I know about?" queries. |
| Cross-topic timelines | Timelines that span topics — e.g. "the auth story" touches coding + security + work. Currently timelines are per-topic. Cross-topic would follow an entity across topic boundaries. |
| Bidirectional ABM-L | Agent writes memories directly in ABM-L format (`--abml "[D\|coding] @clerk >over @auth0"`). No compression step. Agent thinks in memory language. Requires format validation + English fallback. |

---

## Validation

- **Wake-up token count:** before/after — should decrease (same info, fewer tokens)
- **Wake-up render time:** measure the 50-250ms overhead — acceptable?
- **Recall render time:** measure per-query overhead
- **Comprehension test:** same 42 benchmark queries, compare result quality with rendered ABM-L vs stored ABM-L
- **Timeline coverage:** how many memories group into timelines vs remain standalone?
- **Dedup quality:** compare timeline-based merge candidates vs current pair-overlap candidates
