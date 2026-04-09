# ABM Simplification #7 — Emotion: Improve, Don't Drop

**Date:** 2026-04-09
**Status:** Planning
**Master plan:** `abm-simplification.md`

---

## Revised Direction

Original proposal: drop the 25-type emotion tagger, keep only emotion_score for flashbulb protection.

**New direction: unify to tags-only. Keep the tagger, wire the arc system, add emotion-aware recall and wake-up. Derive emotion_score from tags automatically.**

### Emotion unification: tags as single source of truth

Two parallel emotion systems is redundant. `emotion_score` (LLM-assigned integer) and `emotion_tags` (regex-detected types) measure the same thing differently.

**New model:**
- `emotion_tags` is the single source of truth
- Regex tagger runs at store time as baseline (free, instant, consistent)
- LLM can override via `--emotion-tags "pride,bittersweet"` when it senses nuance regex misses
- `emotion_score` column stays but becomes auto-derived from tags (cached for SQL performance)
- Nobody sets `emotion_score` directly — it's always computed from tags via `scoreFromTags()`
- Emoji reactions map to tags: ❤️→`love`, 🔥→`excitement`, 😂→`humor`

```
Store path:  regex detects tags → scoreFromTags() → both written to DB
LLM override: --emotion-tags "pride,bittersweet" → replaces regex tags → score recomputed
Emoji react: ❤️ → adds "love" to tags → score recomputed
Read path:   SQL queries use emotion_score (cached) for filtering/ranking
```

One system. Tags are truth. Score is a materialized cache for SQL performance.

---

## What exists vs what's wired

| Component | Exists | Wired | Change |
|---|---|---|---|
| `emotion_tags` (25 types) | ✅ Stored on every memory | ❌ Never read by recall/wake-up | Wire into recall filter + wake-up. Becomes single source of truth. |
| `emotion_score` (-5 to +5) | ✅ | ✅ Flashbulb, recall boost, emoji reactions | Becomes auto-derived from tags. No longer LLM-assigned. Column stays as cached value. |
| `emotion_arc` column | ✅ In schema | ❌ Never written | Wire buildArc() in sleep |
| `buildArc()` function | ✅ Tested | ❌ Never called | Wire in sleep step |
| Wake-up renderer arc display | ✅ Reads emotion_arc | ❌ Always gets NULL | Needs data from buildArc() |
| Emotion-aware wake-up | ❌ | ❌ | New: emotionally strong memories in wake-up |
| Emotion recall filter | ❌ | ❌ | New: `--emotion` flag on recall |
| Cross-session emotional tone | ❌ | ❌ | New: last session's emotion in session-start |
| LLM tag override | ❌ | ❌ | New: `--emotion-tags` on agentbridge-store |
| Emoji → tags mapping | ❌ | ❌ | New: emoji reactions add tags instead of setting score |

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

- **emotion tagger** stays as-is — 25 types, regex-based, ~1ms, runs at store time (now the baseline, LLM can override)
- **importance_flags** stay as-is — 8 types, used for flashbulb detection
- **Flashbulb protection** stays as-is — derived score ≥ 4 + pivot → never aged
- **Emotional recall boost** stays as-is — SQL uses cached emotion_score column
- **emotion_score column** stays in schema — but becomes auto-derived cache, never set directly

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

### Core (memory system)

| # | Task | Effort | Depends on |
|---|---|---|---|
| -1 | Migration: reverse-derive emotion_tags from emotion_score for existing memories that have score but no tags. Map score ranges to tag sets (e.g. score +4 → `"pride"`, score -3 → `"frustration"`). One-time backfill. Prerequisite for tag-derived scoring. | 30min | — |
| 0 | `scoreFromTags()` function: derive emotion_score from emotion_tags using **max absolute valence** (not sum — compound emotions like pride+grief should score high, not cancel to zero). Update `instantStore()` to compute score from tags. Update `editMemory()` to recompute score when tags change. | 30min | -1 |
| 0b | `effectiveEmotion()` function: apply recency decay to derived emotion_score. Same pattern as `effectiveConfidence()` — `score × recencyFactor(daysSinceCreated)`. Old emotions fade, recent ones are vivid. Used by wake-up ranking and recall boost. Doesn't change stored data — computed on read. | 20min | 0 |
| 1 | Emoji → tags mapping: update `emojiToScore()` to `emojiToTags()`. ❤️→`love`, 🔥→`excitement`, 😂→`humor`, etc. Reaction updates tags, score auto-derives. | 30min | 0 |
| 2 | `--emotion-tags` override on `agentbridge-store` CLI: if provided, replaces regex-detected tags. Score auto-derives. Also accept optional `--emotion-context "deploy failures"` — short cause phrase (3-5 words). Stored as `emotion_context TEXT` column. Regex tagger can't produce this; LLM provides it on override. | 30min | 0 |
| 3 | Emotion groups in recall filter: `--emotion "positive"` expands to joy,pride,excitement,relief,gratitude,love,hope,humor. `--emotion "negative"` expands to frustration,anger,fear,grief,anxiety,exhaustion,doubt. `--emotion "high-energy"` expands to excitement,anger,determination,surprise. Exact tags still work: `--emotion "frustration"`. | 30min | Item #1 recall pipeline |
| 4 | Emotional wake-up: add `loadEmotionalHighlights()` to `wake-up-builder.ts` — top 10 by `effectiveEmotion()` ≥ 3, not in core tier. Insert after core, before dailies. Include `emotion_context` when available for richer context. | 30min | 0b |
| 5 | Wire `buildArc()` in sleep: code-driven step that queries per-topic emotion_tags, calls buildArc(), writes result to `emotion_arc` column via `agentbridge-edit`. **Re-add `emotion_arc` to wake-up builder SELECT** (removed in #6 because it was always NULL — now it has data). | 45min | — |
| 6 | Cross-session emotional tone: in `buildSessionStartContext()`, query recent memories' emotion_tags + emotion_context, build one-line summary, prepend to session context. E.g. "Last session: frustration (deploy failures), then relief (fixed)." | 30min | — |

### Dreamy sleep task

| # | Task | Effort | Depends on |
|---|---|---|---|
| 7 | User emotional profile: new Dreamy sleep task (code-driven). Analyze emotion_tags + emotion_context across topics and time. Extract patterns: frustration triggers, recovery patterns, peak positive contexts, communication style shifts. Write to `user_profile.md` emotional patterns section. Runs weekly (normal tier) or nightly (ultimate). | 1hr | 5 (needs arcs) |
| 7b | Emotion context backfill: Dreamy sleep task. For memories with emotion_tags but no emotion_context, infer the cause from memory content + tags. E.g. memory "FTS5 breaks on Hungarian" + tags "frustration" → context "Hungarian FTS5 limitation". LLM-driven (needs to read content and reason about cause). Runs during curation phase. | 30min | 2 |

### SOUL / prompt behavior

| # | Task | Effort | Depends on |
|---|---|---|---|
| 8 | Real-time emotion detection: add to SOUL.md — "Detect emotional signals in the user's current message (swearing, short messages, exclamation marks, emoji, Hungarian expressions like 'fasza', 'basszus'). When frustration detected: respond with empathy + immediate solution, no meta-commentary. When excitement detected: match the energy, celebrate with the user." | 15min | — |
| 9 | Emotional mirroring: add to SOUL.md — "Mirror the user's emotional tone. If they're analytical and calm, be precise and measured. If they're excited and fast-paced, be energetic and concise. If they're frustrated, be empathetic and action-oriented. Don't be cheerful when they're angry. Don't be flat when they're celebrating." | 15min | — |
| 10 | Update TOOLS.md: document `--emotion-tags` override, `--emotion` groups (positive/negative/high-energy), remove `--emotion-score` guidance | 15min | 2, 3 |
| 11 | Update as-built: document unified emotion model, tag-derived score, emoji→tags, emotional profile, SOUL changes | 15min | 0-10 |

**Total: ~7hr**

Branch: `improve/emotion-system`

---

## Validation

- Wake-up output before/after: count emotional memories included, verify budget respected
- Recall benchmark: add emotion-filtered queries to test set (e.g. "frustration", "pride")
- Sleep audit: verify emotion_arc populated after sleep cycle
- Session-start context: verify emotional tone line appears
