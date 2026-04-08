# ABM v2 — Detailed Implementation Plan

**Status:** Planning
**Depends on:** ABM v1 (Phase 0 + Phase 1) ✅ complete

## Overview

ABM v2 adds intelligence to the memory system: emotion awareness, importance classification, compression, contradiction detection, dynamic wake-up, cross-topic linking, and emotional arcs. All additive — v1 behavior unchanged.

---

## 2.1 Emotion Tagger (`src/memory/emotion-tagger.ts`)

Pattern-based emotion detection. Pure function, no LLM, ~1ms per call.

```typescript
type EmotionTag = "joy" | "trust" | "hope" | "fear" | "grief" | "anger" |
  "doubt" | "relief" | "pride" | "curiosity" | "frustration" | "surprise" |
  "determination" | "exhaustion" | "anxiety" | "gratitude" | "love" |
  "humor" | "vulnerability" | "conviction" | "peace" | "confusion" |
  "excitement" | "tenderness" | "raw_honesty";

detectEmotions(text: string): EmotionTag[]
```

- ~25 emotion types with keyword/phrase regex patterns
- Runs on every instant-store (real-time, cheap)
- Stored as `emotion_tags TEXT` (comma-separated)
- Existing `emotion_score` INTEGER stays — LLM's subjective weight
- `emotion_tags` is the objective, consistent classification

## 2.2 Importance Flags (`src/memory/importance-flagger.ts`)

Pattern-based importance classification. Pure function.

```typescript
type ImportanceFlag = "decision" | "origin" | "core_belief" | "pivot" |
  "technical" | "correction" | "preference" | "milestone";

detectFlags(text: string): ImportanceFlag[]
```

- ~8 flag types with keyword patterns
- Runs on every instant-store alongside emotion tagging
- Stored as `importance_flags TEXT` (comma-separated)
- Helps Dreamy prioritize core promotion: flagged memories promote faster

## 2.3 Emotional Arcs (`src/memory/emotion-arc.ts`)

Track emotional trajectory per topic over time.

```typescript
type ArcDirection = "rising" | "falling" | "volatile" | "stable";
type EmotionArc = { tags: EmotionTag[]; direction: ArcDirection; symbol: string };

buildArc(memories: { emotion_tags: string; created_at: number }[]): EmotionArc
// → { tags: ["hope","doubt","fear","relief","pride"], direction: "rising", symbol: "↑" }
```

- Built per-topic during sleep (not real-time)
- Stored on topic's most recent core memory: `emotion_arc TEXT`
- Wake-up includes arc symbol: `[coding ↑] Clerk > Auth0 | SQLite+FTS5`
- Use cases: burnout detection, project health, relationship dynamics
- For large databases: arc is a 1-token summary of hundreds of entries

## 2.4 Memory Compressor (`src/memory/memory-compressor.ts`)

Structured compression to ABM-L format. Runs at STORE TIME, not sleep time.

See `docs/specs/abm-language.md` for full ABM-L spec.

```typescript
compress(memory: {
  content_en: string; topic: string;
  emotion_tags: string; importance_flags: string;
  confidence?: number; date?: string;
}): string
// → "[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)"
```

- Entity references: @user, @agent, @project-name — auto-built from core-tier
- Relationship operators: >over, >replaces, >causes, >blocks, →
- Compression rules: strip articles/filler, abbreviate, parentheses for reasons
- Stored as `content_compressed TEXT` on every memory (not just core)
- ~1-5ms per call (pure string manipulation)
- Recall returns ABM-L by default, `--full` for English
- Wake-up loads ALL core + recent in ABM-L (~700 tokens vs ~3000 English)

## 2.5 Contradiction Checker (`src/memory/contradiction-checker.ts`)

Check new facts against existing core entries before promotion.

```typescript
checkContradiction(
  newContent: string, topic: string, existingCore: CoreMemory[]
): ContradictionHit | null
```

- Same topic + overlapping entities + different assertion = potential contradiction
- Heuristic (keyword overlap + negation detection), not perfect
- Resolution: invalidate old (`valid_to = now`), promote new, log change
- Sleep step only (during core promotion)

## 2.6 Dynamic Wake-up (`src/memory/wake-up-builder.ts`)

Build session-start context from core-tier memories + compressed dailies/weekly/quarterly.

### Session start budget: 3% of context window

| Component | Budget | Content |
|---|---|---|
| SOUL package | ~2% | SOUL.md + TOOLS.md + core_facts.md + agent_notes.md |
| Memory context | ~1% | Core memories + dailies + weekly + quarterly (all ABM-L) |

### Memory context breakdown (1% budget)

| Model | 1% budget | What fits in ABM-L |
|---|---|---|
| 4K | 40 tokens | Top 4 core memories only |
| 32K | 320 tokens | 30 core memories |
| 128K | 1,280 tokens | 7 dailies + 1 weekly + 100 core memories |
| 1M | 10,000 tokens | 7 dailies + 1 weekly + 1 quarterly + 500 core memories |

### Injection logic (greedy budget fill)

```typescript
function buildMemoryContext(ctxWindowSize: number): string {
  const budget = Math.floor(ctxWindowSize * 0.01); // 1% of context
  let remaining = budget;
  const parts: string[] = [];

  // Priority 1: core memories (always first)
  const core = loadCoreTierABML();
  parts.push(core); remaining -= tokenCount(core);

  // Priority 2: latest daily
  if (remaining > 100) {
    const daily = loadLatestDailyABML();
    parts.push(daily); remaining -= tokenCount(daily);
  }

  // Priority 3: more dailies (up to 7)
  for (const d of loadRecentDailiesABML(7).slice(1)) {
    if (remaining < 100) break;
    parts.push(d); remaining -= tokenCount(d);
  }

  // Priority 4: weekly summary
  if (remaining > 100) {
    const weekly = loadLatestWeeklyABML();
    if (weekly) { parts.push(weekly); remaining -= tokenCount(weekly); }
  }

  // Priority 5: quarterly summary
  if (remaining > 100) {
    const quarterly = loadLatestQuarterlyABML();
    if (quarterly) { parts.push(quarterly); remaining -= tokenCount(quarterly); }
  }

  return parts.join("\n");
}
```

Auto-adapts to any context window. Core memories always loaded. Dailies/weekly/quarterly fill remaining budget greedily. Always ABM-L — tokens cost money regardless of context size.

## 2.7 Cross-topic Links

Lightweight topic linking for recall expansion.

- `related_topics TEXT` column on extracted_memories
- Dreamy builds links during sleep: shared entities/keywords across topics
- Recall follows links when primary topic results are thin

---

## Schema (migration v8)

```sql
ALTER TABLE extracted_memories ADD COLUMN emotion_tags TEXT;
ALTER TABLE extracted_memories ADD COLUMN importance_flags TEXT;
ALTER TABLE extracted_memories ADD COLUMN content_compressed TEXT;
ALTER TABLE extracted_memories ADD COLUMN emotion_arc TEXT;
ALTER TABLE extracted_memories ADD COLUMN related_topics TEXT;
ALTER TABLE extracted_memories ADD COLUMN signature BLOB;
ALTER TABLE extracted_memories ADD COLUMN source_type TEXT DEFAULT 'conversation';
ALTER TABLE extracted_memories ADD COLUMN last_recall_context TEXT;
```

All nullable, backward compatible. v1 queries unaffected.

`signature` is a 32-byte binary hash (256-bit) generated via Random Indexing at store time. Used for Hamming distance search — no ollama needed. See `docs/specs/hippocampus-study.md`.

## Search modes (configurable via `memory.env`)

| Mode | How it works | Needs ollama | Quality | Speed |
|---|---|---|---|---|
| `hybrid` (default) | Signatures pre-filter → embedding rerank | Yes | Best | Fast |
| `embedding` | Ollama embeddings only (legacy) | Yes | Good | Medium |
| `signature` | Binary signatures + Hamming distance only | No | Good (approximate) | Fastest |

Search pipeline:
```
Query → generate query signature (Random Indexing, ~0.1ms)
  │
  ├── signature mode: Hamming distance scan → top N → return
  ├── embedding mode: embedding cosine similarity → top N → return
  └── hybrid mode: Hamming pre-filter (top 50) → embedding rerank (top N) → return
```

Signatures always generated at store time (cheap, ~0.1ms). Embeddings only generated when `MEMORY_SEARCH_MODE=hybrid` or `embedding`.

## Sleep steps

| Step | File | What | When |
|---|---|---|---|
| Topic assignment | `16-topic-assignment.md` | Tag untagged memories with topics | Phase 1 completion |
| Core promotion | `17-core-promotion.md` | Promote best general → core | Phase 1 completion |
| Temporal review | `18-temporal-review.md` | Invalidate stale core facts | Phase 1 completion |
| Emotion + flags backfill | `19-emotion-flags.md` | Tag untagged core memories | v2 |
| Compression backfill | `20-compress-backfill.md` | ABM-L compress memories lacking content_compressed | v2 |
| Contradiction check | `21-contradiction.md` | Check before promotion | v2 |
| Emotional arcs | `22-emotion-arcs.md` | Build per-topic arcs | v2 |
| Memory aging | `23-memory-aging.md` | NULL original/English past TTL, clean FTS5 | v2 |
| Entity review | `24-entity-review.md` | Scan ABM-L for misassigned/ambiguous/missing @references, re-compress | v2 |

## Implementation order

```
Phase 1 sleep steps (16-18) →
2.1 (emotion tagger) → 2.2 (importance flags) → 2.4 (compressor) → migration v8
  ↑ these three run at STORE TIME — every memory gets tags+flags+ABM-L immediately
2.3 (emotional arcs — sleep) → 2.5 (contradiction — sleep) →
2.6 (wake-up — session start) → 2.7 (links — sleep) →
brain patterns (recall boost, flashbulb, decay, source monitoring, reconsolidation,
  semantic networks, prospective memory, interference detection)
```

Key: 2.1 + 2.2 + 2.4 are store-time. Recall benefits from ABM-L immediately without waiting for sleep.

## What's NOT borrowed from MemPalace

- No "AAAK" naming — our language is "ABM-L" (AgentBridge Memory Language)
- No entity registry file — auto-built at compression time
- No zettel format — `[FLAGS|TOPIC|EMOTIONS|CONFIDENCE|DATE] content` with @entity references
- No 40+ emotion codes — trimmed to ~25 useful ones
- No palace metaphor — topics, not wings/rooms/halls

## Brain-inspired enhancements (all included in v2)

See `docs/specs/abm-brain-patterns.md` for full study. All 8 patterns included:

| Pattern | Implementation |
|---|---|
| Emotional recall boost | Recall ranking weighted by \|emotion_score\| |
| Flashbulb protection | \|emotion_score\| ≥ 4 or "pivot" flag → never decayed |
| Spaced repetition decay | Confidence decays unless recalled at intervals |
| Source monitoring | `source_type` column: conversation/observation/correction/external/inference |
| Reconsolidation | `last_recall_context` tracked, Dreamy enriches during sleep |
| Semantic network activation | Real-time spreading activation across linked topics |
| Prospective memory | Future `valid_from` memories activate when date arrives |
| Interference detection | Flag similar-but-different memories during recall |

### Additional schema (migration v8, extended)

```sql
ALTER TABLE extracted_memories ADD COLUMN source_type TEXT DEFAULT 'conversation';
ALTER TABLE extracted_memories ADD COLUMN last_recall_context TEXT;
```

## ABM-L (Memory Language)

See `docs/specs/abm-language.md` for full spec. ABM-L is the compressed format stored in `content_compressed`:

```
[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
[P|personal|—|4|2026-03] @user prefers dark-mode+vim+minimal-code
[LT|coding|frustration|4|2026-03] FTS5 breaks on HU — EN for search
```

~3-5x compression on extracted memories. 50 core memories ≈ 500 tokens (vs 2500 in English).

## ABM-L Compression Level 2

Three enhancements to the wake-up builder and ABM-L format for deeper compression.

### C1: Wake-up entity header + topic grouping

Instead of repeating entities and topics per-line, declare once:

```
@: AB=agentbridge, CK=clerk, AK=aksika
## coding ↑
[D] CK >over auth0 (pricing+DX)
[F] AB: TS+Node, SQLite+FTS5+ollama
[L|frust] FTS5 breaks on HU — EN for search
## personal →
[F] AK: CET, HU/EN, WSL2, direct+sarcastic
[P] dark-mode+vim+minimal-code
```

Rules:
- Entity header: auto-built from core-tier, top N most-referenced entities get 2-letter codes
- Topic sections: group memories by topic, topic+arc as header
- Elide: date (unless recent <7d), confidence (unless unusual), neutral emotions
- Only in wake-up rendering — stored ABM-L stays full format

### C2: Daily summary compression

Dreamy compresses daily summaries to ABM-L during sleep step 20 (compress-backfill). Wake-up builder loads compressed dailies.

```
## 2026-04-07
[M] ABM Phase 0 complete — 27 files decoupled
[D] sleep decoupled — optional addon
[M] ABM v1 shipped — topic+tier+temporal
```

~80 tokens per daily vs ~400 in English. 5× compression.

### C3: SOUL compression for small models

Compressed SOUL variant for context windows <32K:

```
## identity
Agent: Molty. Personal AI for aksika. HU/EN bilingual.
## rules
Store aggressively. Recall before "I don't know". <NO_REPLY> when not needed.
## tools
recall, store, edit, todo, cron, browse, tweet, rss, skill
```

~100 tokens vs ~2000. Generated from full SOUL.md by stripping examples, verbose explanations, keeping only rules and facts.

### Adaptive compression in wake-up builder

```typescript
function compressionLevel(budgetTokens: number): "full" | "compact" | "ultra" {
  if (budgetTokens > 5000) return "full";     // 128K+ models
  if (budgetTokens > 500) return "compact";    // 32K models
  return "ultra";                               // 4K models
}
```

| Level | Entity header | Topic grouping | Date/confidence elision | SOUL | Dailies |
|---|---|---|---|---|---|
| full | No | No | No | Full SOUL.md | English markdown |
| compact | Yes | Yes | Yes | Full SOUL.md | ABM-L compressed |
| ultra | Yes | Yes | Yes | Compressed SOUL | ABM-L compressed |

## D5: Embedding tiering — separate table + int8 quantization

### Problem
Embedding BLOB (1536 bytes float32) is 73% of each row. Dominates storage, bloats main table pages, slows non-embedding queries.

### Solution

**Separate table:**
```sql
CREATE TABLE memory_embeddings (
  memory_id INTEGER PRIMARY KEY,
  embedding BLOB,
  quantized INTEGER DEFAULT 0  -- 0=float32, 1=int8
);
```

**Tiered aging:**
```
Day 0:      float32 (1536 bytes) + signature (32 bytes)
~14 days:   int8 (384 bytes) + signature (32 bytes)      ← quantize, 4× smaller
Forever:    int8 (384 bytes) + signature (32 bytes)       ← keep forever, good quality
```

int8 quantization: map float32 range to -128..127 per dimension. ~1-2% recall quality drop. 384 bytes per memory — negligible at any scale.

**Config:**
```env
MEMORY_EMBEDDING_QUANTIZE_DAYS=14    # quantize float32→int8 after N days
```

No drop — int8 persists forever. Only float32 gets aged.

**Storage projection:**

| Scale | Current (float32 in main) | Separate + int8 at 14d |
|---|---|---|
| 10K memories | 15MB embeddings | ~4MB average |
| 100K memories | 150MB | ~40MB |

**Full per-memory aging:**
```
Day 0:      Original + English + ABM-L + float32 + signature    ~2100 bytes
~14 days:   Original + ████████ + ABM-L + int8 + signature      ~900 bytes
~90 days:   ████████ + ████████ + ABM-L + int8 + signature      ~600 bytes
Forever:                         ABM-L + int8 + signature        ~500 bytes
```

## ABM-L Compression Rules v2

Refinements based on production data analysis. Replaces the naive compressor.

### Entity rules
- **Only @reference known entities**: user (@user), agent (@agent), project names from core-tier
- **Never @reference**: platform names (Telegram, Discord), severity levels (High, Low), common nouns
- **Abbreviate platforms**: Telegram→TG, Discord→DC, OpenRouter→OR
- **Entity whitelist** built from core-tier memories at compression time, not greedy capitalization scan

### Content rules
- **Pipe-separate list items**: `bug1 | bug2 | bug3` instead of `1) bug1. 2) bug2.`
- **Arrow for cause→effect**: `fail→self-healed`, `invalid→text fallback`
- **Parenthetical severity/context**: `(H)`, `(L)`, `(pricing+DX)`
- **Abbreviate known terms**: authentication→auth, configuration→config, development→dev, experience→XP
- **No truncation limit** — let wake-up builder handle length via budget. Stored ABM-L captures everything.

### Flag rules
- **Primary flag from memory_type**: fact→F, decision→D, preference→P, event→E, lesson→L, feedback→K, story→S
- **Secondary flags from detection**: additive, appended. `[ET|...]` = event + technical
- **Never override memory_type** with detected flag

### Filler stripping
- Strip for all memory types (LLMs understand stripped text)
- Preserve: paths, URLs, commands, numbers, error codes, emoji
- Don't strip negations: "don't", "not", "never" — these change meaning

### FTS5 on ABM-L only
- Single FTS5 index on `content_compressed` (replaces `content_en` FTS5)
- Stored ABM-L keeps `@entity` references (not short codes) — FTS5 tokenizer strips `@`, matches "clerk"
- Short codes (CK, AB) only in wake-up rendering, never in stored ABM-L
- English FTS5 index dropped — ABM-L + signatures + int8 embeddings cover all search paths

### Search pipeline (post-migration)
```
Query → ABM-L FTS5 (keyword) + signature Hamming (semantic) + int8 cosine (semantic)
  → merge + deduplicate + emotional boost → return
```
No English text needed at any stage.
