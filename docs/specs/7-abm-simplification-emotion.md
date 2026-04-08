# ABM Simplification #7 — Emotion: Improve, Don't Drop

**Date:** 2026-04-09
**Status:** Planning
**Master plan:** `abm-simplification.md`

---

## Revised Direction

Original proposal: drop the 25-type emotion tagger, keep only emotion_score for flashbulb protection.

**New direction: keep the tagger, wire the arc system, add emotion-aware recall and wake-up.**

The emotion system is half-built, not over-built. The tagger runs and stores 25 emotion types on every memory (~1ms, no LLM). But nothing reads the tags. The fix is wiring, not removal.

Emotion over time is what no other system does. MemPalace has 40+ emotion codes but uses them only for per-memory scoring. OpenClaw has no emotion system at all. ABM's unique opportunity: **emotional trajectories across sessions** — arcs, continuity, proactive behavior. That's the human-like quality.

---

## What exists vs what's wired

| Component | Exists | Wired | Gap |
|---|---|---|---|
| `emotion_score` (-5 to +5) | ✅ | ✅ Flashbulb, recall boost, emoji reactions | None |
| `emotion_tags` (25 types) | ✅ Stored on every memory | ❌ Never read | Wire into recall filter + wake-up |
| `emotion_arc` column | ✅ In schema | ❌ Never written | Wire buildArc() in sleep |
| `buildArc()` function | ✅ Tested | ❌ Never called | Wire in sleep step |
| Wake-up renderer arc display | ✅ Reads emotion_arc | ❌ Always gets NULL | Needs data from buildArc() |
| Emotion-aware wake-up | ❌ | ❌ | New: emotionally strong memories in wake-up |
| Emotion recall filter | ❌ | ❌ | New: `--emotion` flag on recall |
| Cross-session emotional tone | ❌ | ❌ | New: last session's emotion in session-start |

---

## New features

### 1. Emotional wake-up: top memories by emotional weight

**Inspired by MemPalace L1:** Their always-loaded layer picks the top 15 memories scored by `importance / emotional_weight / weight`. The most emotionally significant memories are always in context.

**Current ABM wake-up priority:**
```
1. Core tier memories (by topic, then recency)
2. Recent dailies (up to 7)
3. Weekly summary
4. Quarterly summary
```

No emotional ranking. A neutral fact about deploy commands ranks the same as the pivotal moment the user's project launched.

**New priority — insert emotional memories after core:**
```
1. Core tier memories (by topic, then recency)
2. Emotional highlights (top N by |emotion_score|, not already in core)  ← NEW
3. Recent dailies (up to 7)
4. Weekly summary
5. Quarterly summary
```

The query:
```sql
SELECT content_compressed, topic, emotion_score, emotion_tags, importance_flags
FROM extracted_memories
WHERE valid_to IS NULL
  AND content_compressed IS NOT NULL
  AND ABS(COALESCE(emotion_score, 0)) >= 3
  AND tier != 'core'  -- not already loaded
ORDER BY ABS(emotion_score) DESC, created_at DESC
LIMIT 10
```

This loads emotionally strong memories that aren't in core tier — pivotal moments, strong reactions, lessons learned the hard way. The agent starts every session knowing not just the facts, but the stories that matter.

**Budget:** shares the 1% context window budget. Emotional highlights fill after core, before dailies. If core already fills the budget, emotional highlights are skipped (core is more important). If budget is generous (128K+ model), both fit easily.

### 2. Emotion as a recall filter

`agentbridge-recall --emotion "frustration"` returns memories tagged with frustration. The agent can search by emotional context:

- "What was I frustrated about?" → `--emotion frustration`
- "What went well recently?" → `--emotion pride,joy`
- "What decisions did I make under pressure?" → `--emotion determination,conviction`

Implementation: add `emotion` param to `RecallParams`, filter `WHERE emotion_tags LIKE '%frustration%'` in Sf. Trivial — one WHERE clause.

### 3. Wire buildArc() into sleep

Dreamy calls `buildArc()` per topic during sleep step 22 (emotion-arcs). Writes the direction (↑↓↕→) to `emotion_arc` on the topic's most recent core memory.

The wake-up renderer already handles this — it groups by topic and shows the arc symbol in the header: `## coding ↑`. Currently always empty because nobody writes the data.

### 4. Cross-session emotional tone

Session-start context includes the emotional tone of the last session:

```
[Last session: productive (pride, determination). One frustration: FTS5 Hungarian issue.]
```

Built from the last N messages' emotion_tags (already stored on extracted memories from that session). Gives the agent emotional continuity — it knows how the last conversation ended without the user repeating themselves.

Implementation: in `buildSessionStartContext()`, query recent extracted memories' emotion_tags, summarize the dominant emotions. ~10 lines.

### 5. Emotion tags in ABM-L wake-up

Currently ABM-L format includes emotion from the compressor:
```
[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
```

The `convict` is from emotion_tags. This already works — the compressor reads emotion_tags at store time. No change needed here.

### 6. Emotion-triggered proactive behavior (future)

If a topic's arc is ↓ for 3+ sessions, the agent proactively checks in. Not for this iteration — requires agent behavior changes, not just infrastructure. Document as future direction.

---

## What we're NOT changing

- **emotion_score** stays as-is — LLM-assigned, -5 to +5, used for flashbulb + recall boost
- **emotion tagger** stays as-is — 25 types, regex-based, ~1ms, runs at store time
- **importance_flags** stay as-is — 8 types, used for flashbulb detection
- **Flashbulb protection** stays as-is — |emotion| ≥ 4 + pivot → never aged
- **Emotional recall boost** stays as-is — Sa/Ss weight by |emotion_score|

---

## MemPalace comparison

| Aspect | MemPalace | ABM (current) | ABM (after this) |
|---|---|---|---|
| Emotion detection | 40+ codes, keyword regex | 25 types, keyword regex | Same — already good |
| Per-memory emotion | ✅ Stored | ✅ Stored | ✅ Same |
| Emotion in L1/wake-up | ✅ Top 15 by emotional_weight | ❌ No emotional ranking | ✅ Emotional highlights after core |
| Emotion arcs | ❌ None | ❌ Column exists, never written | ✅ buildArc() wired in sleep |
| Emotion recall filter | ❌ None | ❌ None | ✅ --emotion flag |
| Cross-session continuity | ❌ None | ❌ None | ✅ Last session emotional tone |
| Proactive behavior | ❌ None | ❌ None | 🔮 Future |

ABM goes beyond MemPalace on the temporal dimension — arcs, trajectories, continuity. No other system in the competitive analysis does this.

---

## Implementation Tasks

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | Emotional wake-up: add `loadEmotionalHighlights()` to `wake-up-builder.ts` — top 10 by \|emotion_score\| ≥ 3, not in core tier. Insert after core, before dailies. | 30min | — |
| 2 | Emotion recall filter: add `emotion` param to `RecallParams`, add WHERE clause to Sf in `recall-engine.ts`, add `--emotion` flag to `agentbridge-recall` CLI | 30min | Item #1 recall pipeline |
| 3 | Wire `buildArc()` in sleep: code-driven step that queries per-topic emotion_tags, calls buildArc(), writes result to `emotion_arc` column via `agentbridge-edit` | 45min | — |
| 4 | Cross-session emotional tone: in `buildSessionStartContext()`, query recent memories' emotion_tags, build one-line summary, prepend to session context | 30min | — |
| 5 | Update as-built: document emotional wake-up, recall filter, arc wiring, session tone | 15min | 1-4 |

**Total: ~2.5hr**

Branch: `improve/emotion-system`

---

## Validation

- Wake-up output before/after: count emotional memories included, verify budget respected
- Recall benchmark: add emotion-filtered queries to test set (e.g. "frustration", "pride")
- Sleep audit: verify emotion_arc populated after sleep cycle
- Session-start context: verify emotional tone line appears
