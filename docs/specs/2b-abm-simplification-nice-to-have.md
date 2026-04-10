# ABM Simplification #2b — Nice-to-Have Extensions

**Date:** 2026-04-10
**Status:** Planning
**Parent:** `2-abm-simplification-render-layer.md`

---

## Items

### 1. Weekly Timeline from Dailies

Compress a week of daily summaries into one narrative timeline instead of loading 7 separate daily files.

**Current:** Wake-up loads up to 7 daily `.md` files, each compressed via `compressDailySummary()`. 7 × ~80 tokens = ~560 tokens.

**Proposed:** Group the 7 dailies into a weekly narrative timeline:
```
[WEEK 2026-04-03→04-09]
Mon: refactor started (determination) → Tue: tests broken (frustration) → Wed: fixed+shipped (relief,pride)
Thu: sleep bug burned tokens (frustration) → Fri: ABM simplification 6/7 done (pride)
arc: ↑ | highlights: recall pipeline shipped, emotion system wired
```

~100 tokens instead of ~560. Same information density — the LLM sees the week's narrative arc.

**Implementation:** Reuse `buildTimelines()` on daily summary content. Each daily becomes a "memory" with date as created_at, extract key events + emotions. Render as a single timeline.

**Effort:** 1hr

---

### 2. L0 Signal Level — Memory Tag Cloud

For tiny models (<500 token budget), render ALL memories as a structured tag cloud:

```
[MEMORY MAP — 93 entries]
coding(34): @agentbridge @clerk @auth0 @sqlite — D:12 F:15 L:5 E:2
personal(8): @user @molty — F:5 P:3
work(18): cron deploy heartbeat — F:10 E:5 D:3
projects(6): @agentbridge @openclaw — M:3 E:2 F:1
```

~50 tokens. The agent sees its entire memory as a structured overview — topics, entity counts, memory type distribution. It knows WHAT it knows without the details. Enables "what do I know about X?" meta-queries.

**Implementation:** SQL aggregation query: `GROUP BY topic`, count by `memory_type`, extract top entities per topic. Render as compact lines. Add as a new level in `pickLevel()`.

**Effort:** 45min

---

### 3. Cross-Topic Timelines

Follow an entity across topic boundaries. Currently timelines are per-topic. But "@clerk" appears in coding (technical decision), work (deploy), and finance (pricing). A cross-topic timeline shows the full entity story:

```
[TL|@clerk] coding:chosen >over @auth0(Jan) → work:deployed(Feb) → finance:pricing review(Mar) → coding:reversed(Apr)
```

**Implementation:** `buildTimelines()` currently groups by `topic:entity`. Add a second pass that groups by `entity` only (across topics), for entities appearing in 3+ topics. Render with topic prefixes.

**Effort:** 1hr

---

### 4. Bidirectional ABM-L

Agent writes memories directly in ABM-L format:
```
agentbridge-store --abml "[D|coding|convict|5] @clerk >over @auth0 (pricing+DX)"
```

No compression step. Agent thinks in memory language. Requires format validation + English fallback if malformed.

**Implementation:** Parse ABM-L prefix to extract metadata (type, topic, emotion, confidence, date). Store the body as `content_en` (it's already compressed English). Validate format, reject malformed, fall back to normal store path.

**Risk:** Agent might produce inconsistent ABM-L. Mitigation: strict validation, reject and log if format doesn't parse.

**Effort:** 1.5hr

---

## Priority

| # | Item | Impact | Effort | Recommendation |
|---|---|---|---|---|
| 1 | Weekly timeline from dailies | High — 5× compression on daily context | 1hr | Do now |
| 2 | L0 signal level | Medium — enables tiny models, meta-queries | 45min | Do now |
| 3 | Cross-topic timelines | Medium — richer entity stories | 1hr | Do now |
| 4 | Bidirectional ABM-L | Low — needs validation, agent may produce bad format | 1.5hr | Later — needs more thought on validation |

**Total (items 1-3): ~2.75hr**
