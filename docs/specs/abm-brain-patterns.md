# ABM — Brain-Inspired Enhancements (Future)

Research notes on human memory patterns that could enhance ABM beyond v2.

## 1. Spaced Repetition Decay (Ebbinghaus Forgetting Curve)

**Brain:** Memories decay unless reinforced. Memories recalled at increasing intervals (1 day → 3 days → 7 days → 30 days) become permanent.

**ABM today:** We have `recall_count` and `last_recalled_at` but don't use them for decay. Darwinism deletes zero-recall memories after 60 days — binary, not gradual.

**Enhancement:** Confidence decays over time unless recalled. Each recall at a longer interval boosts confidence more. Formula:

```
effective_confidence = base_confidence × decay_factor(days_since_last_recall)
recall_boost = log2(interval_since_previous_recall_days + 1)
```

Memories that survive multiple recall cycles at increasing intervals become "permanent" (confidence 5, never decayed). Memories never recalled fade naturally.

**Impact:** Self-organizing memory — important facts surface, unimportant ones fade. No manual curation needed.

## 2. Emotional Recall Boost (Amygdala Effect)

**Brain:** Emotionally charged memories are stored more strongly and recalled more easily. You remember your wedding day but not last Tuesday's lunch.

**ABM today:** `emotion_score` exists but doesn't affect recall ranking.

**Enhancement:** Recall results weighted by |emotion_score| + emotion_tags richness:

```
recall_rank = semantic_similarity × (1 + 0.1 × |emotion_score|)
```

Memories with strong emotions (positive or negative) rank higher. A decision made with conviction (emotion_score +4) outranks a neutral observation.

**Impact:** Recall naturally prioritizes what mattered, not just what matched keywords.

## 3. Reconsolidation (Memory Updating on Recall)

**Brain:** When you recall a memory, it becomes malleable and can be updated with new context before being re-stored. This is why eyewitness testimony changes over time.

**ABM today:** Recall is read-only. The memory stays exactly as stored.

**Enhancement:** When a memory is recalled during conversation and the conversation adds new context, Dreamy can update the memory during sleep:

```
Original: "We use Auth0 for authentication"
Recalled during conversation about pricing
Updated: "We use Auth0 for authentication (considering switch due to pricing)"
```

Track `last_recall_context TEXT` — what was being discussed when this memory was recalled. Dreamy uses this to enrich memories during sleep.

**Impact:** Memories evolve with understanding. A fact stored 6 months ago gets enriched with context from every conversation that referenced it.

## 4. Flashbulb Protection

**Brain:** Highly emotional or surprising events create vivid, detailed memories that resist decay. You remember exactly where you were on 9/11.

**ABM today:** All memories decay equally under Darwinism.

**Enhancement:** Memories with |emotion_score| ≥ 4 OR importance_flag "pivot" are marked as flashbulb:
- Never decayed by Darwinism
- Stored with extra context (surrounding messages)
- Always included in topic arcs
- Protected from consolidation/merge

**Impact:** Critical moments are preserved permanently. The day the user's project launched, the argument that changed the architecture, the breakthrough after 3 days of debugging.

## 5. Source Monitoring

**Brain:** You track WHERE a memory came from — did you read it, hear it, experience it, or infer it? This affects how much you trust it.

**ABM today:** `source_message_ids` tracks which messages, but not the nature of the source.

**Enhancement:** Add `source_type` field:
- `conversation` — user told the agent directly
- `observation` — agent inferred from context
- `correction` — user corrected a previous belief
- `external` — from a document, URL, or tool output
- `inference` — agent reasoned this from other memories

Corrections override observations. Conversations override inferences. External sources get credibility based on the source.

**Impact:** The agent knows WHY it believes something and how much to trust it. "I think you prefer dark mode (observation, confidence 2)" vs "You told me you prefer dark mode (conversation, confidence 5)".

## 6. Semantic Network Activation (Spreading Activation)

**Brain:** Recalling "doctor" activates "hospital", "nurse", "medicine", "health" — related concepts light up automatically. This is why word association works.

**ABM today:** Cross-topic links (2.7) are static, built during sleep.

**Enhancement:** Real-time spreading activation during recall:
1. Query matches topic "auth"
2. Automatically also search topics linked to "auth" (security, users, Clerk)
3. Weight linked results lower than direct matches
4. Build activation map: which topics fire together frequently → strengthen links

**Impact:** The agent's recall becomes associative, not just keyword-based. Ask about "auth" and it also remembers the security audit, the user management refactor, and the Clerk pricing discussion — without being asked.

## 7. Prospective Memory (Future-Oriented)

**Brain:** "Remember to buy milk on the way home" — memory about something you need to do in the future.

**ABM today:** Cron/tasks handle scheduled actions, but the memory system doesn't support future-oriented memories.

**Enhancement:** Memories with `valid_from` in the future are "prospective" — they activate when the date arrives:
- "Remember to review the Clerk contract in January" → `valid_from = 2027-01-01`
- Wake-up on January 1st includes this memory automatically
- Dreamy flags upcoming prospective memories in the daily summary

**Impact:** The agent remembers commitments and future plans without cron tasks. More natural than scheduled reminders.

## 8. Interference Detection (Proactive/Retroactive)

**Brain:** Old memories can interfere with new learning (proactive interference) and new memories can overwrite old ones (retroactive interference). This is why you sometimes call your new partner by your ex's name.

**ABM today:** Contradiction detection (2.5) catches direct conflicts. But subtle interference — two similar but not contradictory memories causing confusion — isn't detected.

**Enhancement:** During recall, if two memories from the same topic have high semantic similarity but different content, flag as potential interference:
- "We use PostgreSQL for the main database" (stored March)
- "We're evaluating PostgreSQL vs SQLite for the new service" (stored April)
- Not contradictory, but could cause confusion → agent should clarify which context

**Impact:** The agent recognizes when its own memories might be confusing and proactively clarifies.

---

## Priority ranking for implementation

| Enhancement | Impact | Effort | Priority |
|---|---|---|---|
| Emotional recall boost (#2) | High — immediate recall improvement | Low (~5 lines in recall engine) | **Do in v2** |
| Spaced repetition decay (#1) | High — self-organizing memory | Medium (decay formula + Dreamy step) | **v2 or v2.1** |
| Flashbulb protection (#4) | Medium — preserves critical moments | Low (flag check in Darwinism) | **v2** |
| Source monitoring (#5) | Medium — trust calibration | Low (one column + store logic) | **v2.1** |
| Reconsolidation (#3) | Medium — memories evolve | Medium (recall context tracking + Dreamy step) | **v3** |
| Semantic network activation (#6) | High — associative recall | High (real-time graph traversal) | **v3** |
| Prospective memory (#7) | Low for us, medium for others | Low (valid_from filter in wake-up) | **v3** |
| Interference detection (#8) | Low — edge case | Medium (similarity comparison during recall) | **v3+** |
