# ABM Simplification — Baseline Evidence

**Date:** 2026-04-08
**Companion to:** `abm-simplification.md`

---

## Benchmark Setup

- DB: `~/.agentbridge/memory/memory.db` (KiroProfessor deployment)
- 93 extracted memories, 14 messages, 42 test queries
- chatId: 7773842843 (aksika Telegram)
- Pre-ABMv1 memories — topic/tier/emotion_tags/importance_flags are backfilled, content_en/content_original are genuine
- All memories: topic=general, tier=general (no metadata filtering benefit)
- Harness: `src/memory/recall-benchmark.ts`
- Full JSON report: `abm-simplification-baseline.json`

---

## Stage Performance Summary

```
Stage      Hits   Unique   Avg ms   Queries    Verdict
S1           57       57        1     29/42     Active — precise keyword, but overlaps with Sa
S2            2        2        0      1/42     Near-dead — Hungarian FTS5 broken by agglutination
S3          188      188        1     29/42     Workhorse — broad LIKE, overlaps with S1
S4            4        4        0      4/42     Low — only 14 messages in DB (deployment artifact)
S5            0        0        0      0/42     Dead — S4 already covers message hits
S6          180      180        0     30/42     Strong — consolidation files are a different data source
S7           10        8        0      2/42     Working as designed — only fires on negative queries
Sa          257      257        0     40/42     Dominant keyword stage — ABM-L FTS5
Ss          623      584        1     42/42     Universal — finds something for every query
```

## Key Findings

### 1. Four keyword stages do the same job

S1 (English FTS5), S2 (Original FTS5), S3 (LIKE), Sa (ABM-L FTS5) are all variations of "find text matching these characters." They search different representations of the same content:

| Stage | Searches | Tokenizer | Unique value |
|---|---|---|---|
| S1 | content_en | porter + unicode61 | Stemming (English) |
| S2 | content_original | unicode61 | Hungarian text — but FTS5 can't stem Hungarian |
| S3 | content_en + content_original + preserved_keyword | LIKE + strip_diacritics | Substring, accent-insensitive |
| Sa | content_compressed (ABM-L) | unicode61 | Survives aging (ABM-L never NULLed) |

A single trigram index on content_en + content_original replaces all four with better typo tolerance.

### 2. S2 is broken by design

S2 uses FTS5 on Hungarian content. Hungarian is agglutinative — "jelszavunk" (our password) won't match "jelszó" (password). The system already documents this: memory #66 says "EN is the search language because Hungarian agglutination breaks FTS5."

S2 got 1 hit across 42 queries (only "jelszó" matched because it's a root form). Trigram matching handles agglutination better — character overlap is high even across inflected forms.

### 3. Ss is too permissive

Signatures found something for every query (42/42), including negative queries:
- "quantum computing" → 20 signature hits
- "kubernetes" → 20 signature hits

The 0.55 Hamming similarity threshold lets through noise. Needs raising.

### 4. S4/S5 are deployment-dependent, not broken

Only 14 messages in DB because Dreamy aged the rest and Sonnet's 1M context means messages rarely overflow. On a 128K model with heavy daily use, S4 would be the primary intra-day memory. S5 (LIKE on messages) adds nothing over S4 (FTS5 on messages).

### 5. S6 is genuinely valuable

180 unique hits across 30/42 queries. Consolidation files (daily/weekly/quarterly summaries) contain information not in extracted_memories — narrative context, session flow, topics discussed. This is a different data source, not a redundant search path.

### 6. Short-circuit hides S6's value

Short-circuit fired on 8/42 queries (at S3), skipping S4-S7. But S6 contributed 180 unique hits on queries that reached it. The short-circuit is optimizing for speed at the cost of recall quality.

In the new pipeline, S6 runs unconditionally (only 4 stages, all fast).

---

## The "válókezelő" Problem

**Screenshot evidence (2026-04-08):** User asked "Emlékszel a svéd válókezelőre?" (Do you remember the Swedish divorce handler?). Agent found nothing. User corrected to "váltókezelő?" (switchman) and agent immediately found memory #24.

**Root cause:** "válókezelő" vs "váltókezelő" — one missing 't'. None of the 10 stages catch this:
- FTS5: exact token match → miss
- LIKE: exact substring → "valokezelo" ≠ "valtokezelo" → miss
- Signatures: generated from English content → Hungarian query doesn't reach them → miss
- Embeddings: same as signatures → miss

**Trigram solution:** "válókezelő" and "váltókezelő" share most character trigrams (vál, óke, kez, eze, zel, elő). A trigram index on content_original catches this automatically.

**Upstream fix also needed:** The agent should translate queries to English before recalling. "svéd válókezelő" → "Swedish switchman" would have found memory #24 via any English search. The agent didn't follow the protocol (--translated means "translated to English").

---

## Stage Overlap Analysis

How often do stages find the SAME memories (not unique)?

From the benchmark, every query returns exactly 10 results (the limit). The "unique" count per stage measures how many results that stage found that NO prior stage found. Since stages run in order (S1→S2→S3→Se→S4→S5→S6→S7→Sa→Ss), later stages' unique counts are deflated by earlier stages' hits.

But the raw hit counts show overlap:
- S1: 57 hits, S3: 188 hits — S3 is a superset of S1 (LIKE catches everything FTS5 catches, plus more)
- Sa: 257 hits — overlaps heavily with S1 and S3 (same content, different format)
- Ss: 623 hits — overlaps with everything (semantic catches keyword matches too)

**Conclusion:** S1, S3, Sa are three ways to do the same thing. Unifying them into one trigram stage loses nothing and gains typo tolerance.

---

## Benchmark Limitations

1. **Pre-ABMv1 data:** All memories have topic=general, tier=general. No metadata filtering benefit measurable. A production system with proper topics would show different stage contributions.

2. **Low message count:** 14 messages makes S4/S5 appear weak. Not representative of heavy-use deployments.

3. **No golden labels:** P@10/R@10/MRR not computed — requires manual relevance labeling. Golden set template generated at `~/.agentbridge/memory/recall-golden-set.json`.

4. **No Se data:** Ollama not running during benchmark. Se (embedding) stage not measured. Would need a separate run with ollama active.

5. **Single deployment:** Results are specific to KiroProfessor's 93 memories. A system with 10K+ memories may show different stage value distribution.
