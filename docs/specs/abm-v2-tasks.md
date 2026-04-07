# ABM v2 — Task List

Ordered by dependency. Each batch can be branched, implemented, tested, and merged independently.

---

## Batch A: Store-time pipeline (foundation — everything else depends on this)

| ID | Task | Depends on | Effort |
|---|---|---|---|
| A1 | Schema migration v8 — all new columns (emotion_tags, importance_flags, content_compressed, emotion_arc, related_topics, signature, source_type, last_recall_context) | — | 30min |
| A2 | `emotion-tagger.ts` — 25 emotion types, keyword regex patterns, `detectEmotions(text): EmotionTag[]` | — | 2hr |
| A3 | `importance-flagger.ts` — 8 flag types, keyword patterns, `detectFlags(text): ImportanceFlag[]` | — | 1hr |
| A4 | `signature-generator.ts` — Random Indexing, 256-bit binary signatures, `generateSignature(text): Uint8Array` + `hammingDistance(a, b): number` | — | 2hr |
| A5 | `memory-compressor.ts` — ABM-L format, entity auto-detection, relationship operators, `compress(memory): string` | A2, A3 | 2hr |
| A6 | Wire A2-A5 into instant-store — memory-editor.ts runs tagger+flagger+compressor+signature on every store | A1-A5 | 1hr |
| A7 | Tests: emotion tagger, importance flagger, signature generator, compressor, store integration | A1-A6 | 2hr |

**Batch A delivers:** Every new memory gets emotion_tags + importance_flags + content_compressed (ABM-L) + signature at store time.

---

## Batch B: Search enhancements

| ID | Task | Depends on | Effort |
|---|---|---|---|
| B1 | `memory.env` config file — MEMORY_SEARCH_MODE, MEMORY_MAX_DB_SIZE_MB, aging TTLs, signature bits | — | 30min |
| B2 | Signature search — Hamming distance scan in recall-engine.ts, new search stage | A4, A6 | 1hr |
| B3 | Hybrid search — signature pre-filter (top 50) → embedding rerank (top N) | B2 | 1hr |
| B4 | Multi-resolution recall — signal/compact/standard/full, auto-pick by available tokens | A5 | 1hr |
| B5 | Recall returns ABM-L by default — `content_compressed` as default output, `--full` for `content_en` | A5 | 30min |
| B6 | Emotional recall boost — recall ranking weighted by \|emotion_score\| + emotion_tags richness | A2 | 30min |
| B7 | Tests: search modes, multi-resolution, ABM-L recall, emotional boost | B1-B6 | 1.5hr |

**Batch B delivers:** Three search modes (hybrid/embedding/signature), multi-resolution recall, ABM-L as default output, emotion-weighted ranking.

---

## Batch C: Sleep-time intelligence

| ID | Task | Depends on | Effort |
|---|---|---|---|
| C1 | Sleep step `19-emotion-flags.md` — backfill emotion_tags + importance_flags on existing memories | A2, A3 | 30min |
| C2 | Sleep step `20-compress-backfill.md` — ABM-L compress memories lacking content_compressed | A5 | 30min |
| C3 | `contradiction-checker.ts` + sleep step `21-contradiction.md` — check core before promotion | A5 | 1hr |
| C4 | `emotion-arc.ts` + sleep step `22-emotion-arcs.md` — per-topic trajectory (↑↓↕—) | A2 | 1hr |
| C5 | Memory aging + sleep step `23-memory-aging.md` — three-tier aging, pressure-based TTL | B1 | 1hr |
| C6 | Sleep step `24-entity-review.md` — fix ABM-L @reference anomalies, re-compress | A5 | 30min |
| C7 | Cross-topic links — `related_topics` field, Dreamy builds links, recall follows links | A1 | 1hr |
| C8 | Self-improving compression — entity relationship stability tracking, correction feedback | C3 | 1hr |
| C9 | Tests: contradiction checker, emotion arcs, aging, cross-topic links | C1-C8 | 1.5hr |

**Batch C delivers:** Dreamy gains 6 new sleep steps. Memories age progressively. Contradictions caught. Emotional arcs tracked. Entity references cleaned up.

---

## Batch D: Session start

| ID | Task | Depends on | Effort |
|---|---|---|---|
| D1 | `wake-up-builder.ts` — 1% budget greedy fill: core → dailies → weekly → quarterly. All ABM-L. | A5, B4 | 1.5hr |
| D2 | Wire into session-start prompt (message-pipeline.ts) — inject after SOUL, before session context | D1 | 30min |
| D3 | ABM-L format hint — 20-token decoder line injected before core memories | D1 | 15min |
| D4 | Tests: wake-up builder budget logic, format output | D1-D3 | 1hr |

**Batch D delivers:** Agent wakes up knowing everything important. 50 core facts + 7 dailies in ~700 tokens.

---

## Batch E: Brain patterns

| ID | Task | Depends on | Effort |
|---|---|---|---|
| E1 | Flashbulb protection — \|emotion_score\| ≥ 4 + "pivot" flag → exempt from Darwinism + aging | A2, A3 | 30min |
| E2 | Spaced repetition decay — confidence decays unless recalled at intervals, formula in maintenance | A1 | 1hr |
| E3 | Source monitoring — `source_type` set on store (conversation/observation/correction/external/inference), `--source-type` on CLI | A1 | 30min |
| E4 | Reconsolidation — `last_recall_context` tracked on recall, Dreamy enriches during sleep | A1 | 1hr |
| E5 | Prospective memory — future `valid_from` memories included in wake-up when date arrives | D1 | 30min |
| E6 | Interference detection — flag similar-but-different memories during recall, warn agent | B2 | 1hr |
| E7 | Semantic network activation — spreading activation across linked topics during recall | C7 | 2hr |
| E8 | Tests: flashbulb, decay, source monitoring, reconsolidation, prospective, interference, spreading | E1-E7 | 2hr |

**Batch E delivers:** Memory behaves like a brain — emotional memories persist, unused ones fade, corrections update beliefs, related topics auto-activate.

---

## Summary

| Batch | Tasks | Effort | Depends on |
|---|---|---|---|
| **A: Store pipeline** | 7 | ~10.5hr | — |
| **B: Search** | 7 | ~6hr | A |
| **C: Sleep intelligence** | 9 | ~7.5hr | A, B1 |
| **D: Session start** | 4 | ~3.25hr | A, B |
| **E: Brain patterns** | 8 | ~8.5hr | A, B, C7, D1 |
| **Total** | **35 tasks** | **~36hr** | |

## Implementation order

```
A1 → A2+A3+A4 (parallel) → A5 → A6 → A7
  → B1 → B2+B3+B4+B5+B6 (parallel) → B7
  → C1+C2 (parallel) → C3 → C4 → C5 → C6 → C7 → C8 → C9
  → D1 → D2+D3 (parallel) → D4
  → E1+E2+E3 (parallel) → E4 → E5 → E6 → E7 → E8
```

Each batch is a branch. Merge to main when batch is complete + tested.
