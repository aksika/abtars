# Memory System — Design Decisions

Architectural decisions and trade-off verdicts for the memory subsystem.

---

## D1. Typo Misinterpretation in Extraction (2026-03-22)

**Context:** When the user types with typos in a non-English language, the LLM may misinterpret the meaning. Since both `content_en` and `content_original` are LLM-generated, a misinterpretation poisons both fields. Example: "idd ki a bilit" (typo for "vidd ki a bilit" = take the potty out) → LLM reads "idd ki" = "drink up" → wrong memory stored.

**Options considered:**

A. **Accept the gap** — rely on LLM's ~95%+ typo recognition and Stage 3-5 raw message fallback.
B. **Verbatim original + index all** — store raw user text in `content_original`, index all entries in original FTS (not just `preserve_original=1`).

**Decision: Accept the gap (Option A).**

**Rationale:**
- LLM typo recognition is 95%+ — this is a rare edge case
- Storing verbatim typo text degrades `content_original` for the 95% case where it's a clean, readable native-language summary
- Original FTS index would grow ~10-20x for marginal benefit
- Recall Stage 2 (`--original` search) was designed for clean native-language queries — filling it with raw typo text makes it noisier
- Stage 5 (raw messages LIKE search) already exists as a last-resort fallback
- Schema migration on live DB adds risk for low payoff

**Revisit if:** misinterpretation becomes a recurring problem in practice. Better targeted fix would be LLM confidence flagging on ambiguous extractions rather than changing the whole pipeline.

---

## D2. Translation Quality — Prompt-Only Fix (2026-03-22)

**Context:** Non-English idioms, jokes, sarcasm, and cultural references were being translated literally in `content_en`, producing memories that lost meaning and were hard to find via FTS5 recall.

**Decision: Fix via extraction prompt rules only. No schema or code changes.**

**Rationale:**
- FTS5 with porter stemming already indexes every word in `content_en` — a separate keywords column would be redundant
- Better English translations naturally produce better FTS5 tokens
- Three prompt rules added: meaning-first translation, tone context (joke/sarcasm prefix), cultural reference annotations
- No DB migration, no new columns, no index changes needed

**Commit:** `998d93d`
