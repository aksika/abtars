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

Structured compression for wake-up context.

```typescript
compress(memory: {
  content_en: string; topic: string;
  emotion_tags: string; importance_flags: string;
}): string
// → "[decision|coding] Clerk > Auth0 (pricing+DX)"
```

- Entity abbreviation: auto-built from core-tier entities at compression time
- Strip filler, keep facts. Prefix with `[flags|topic]`
- Stored as `content_compressed TEXT`
- Only on core-tier memories (Dreamy compresses during promotion)
- Wake-up loads compressed; deep recall returns full English
- Target: ~5-10x compression on already-concise extracted memories

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

Build session-start context from core-tier memories.

```typescript
buildWakeUp(): string
// "[coding ↑] Clerk > Auth0 (pricing+DX) | SQLite+FTS5 | TS+Node
//  [personal →] CET timezone | HU/EN bilingual | direct+sarcastic"
```

- `SELECT content_compressed, topic, emotion_arc FROM extracted_memories WHERE tier = 'core' AND valid_to IS NULL`
- Group by topic, one line per topic, arc symbol prefix
- Inject after SOUL, before session context
- `user_profile.md` facts migrate here over time
- Dynamic — evolves as Dreamy promotes/invalidates

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
```

All nullable, backward compatible. v1 queries unaffected.

## Sleep steps

| Step | File | What | When |
|---|---|---|---|
| Topic assignment | `16-topic-assignment.md` | Tag untagged memories with topics | Phase 1 completion |
| Core promotion | `17-core-promotion.md` | Promote best general → core | Phase 1 completion |
| Temporal review | `18-temporal-review.md` | Invalidate stale core facts | Phase 1 completion |
| Emotion + flags backfill | `19-emotion-flags.md` | Tag untagged core memories | v2 |
| Compression | `20-compress-core.md` | Compress core memories | v2 |
| Contradiction check | `21-contradiction.md` | Check before promotion | v2 |
| Emotional arcs | `22-emotion-arcs.md` | Build per-topic arcs | v2 |

## Implementation order

```
Phase 1 sleep steps (16-18) →
2.1 (emotion tagger) → 2.2 (importance flags) → migration v8 →
2.3 (emotional arcs) → 2.4 (compressor) →
2.5 (contradiction) → 2.6 (wake-up) → 2.7 (links)
```

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
