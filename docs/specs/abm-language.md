# ABM-L — AgentBridge Memory Language

A purpose-built symbolic language for AI memory storage, recall, and context loading. Designed to be read natively by any LLM without training — it's structured text, not a binary format.

## Why a memory language?

Current state: memories stored in full English. Recall returns English. Wake-up loads English. This works but wastes tokens.

```
English (15 tokens):
"We decided to use Clerk instead of Auth0 because pricing is better and developer experience is cleaner"

ABM-L (6 tokens):
[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
```

The LLM reads both equally well. ABM-L carries the same information plus structured metadata (decision flag, topic, emotion, confidence, date) in ~40% of the tokens.

For wake-up context: 50 core memories in English ≈ 2500 tokens. In ABM-L ≈ 500 tokens. That's 2000 tokens freed for actual conversation.

## Format

```
[FLAGS|TOPIC|EMOTIONS|CONFIDENCE|DATE] CONTENT
```

### Flags (single character)

| Flag | Meaning | Keyword patterns |
|---|---|---|
| `D` | Decision | decided, chose, switched, instead of, trade-off |
| `P` | Preference | prefer, always use, never use, my rule is |
| `F` | Fact | is, has, uses, runs on, located at |
| `L` | Lesson | learned, realized, mistake, never again |
| `O` | Origin | created, founded, started, born, first time |
| `V` | Pivot | turning point, changed everything, breakthrough |
| `M` | Milestone | shipped, launched, deployed, it works, fixed |
| `C` | Correction | actually, was wrong, corrected, updated |
| `T` | Technical | architecture, config, deploy, infrastructure |
| `B` | Core belief | always, fundamental, essential, principle |

Multiple flags: `DT` = decision + technical.

### Topic

From the `topic` column. Lowercase, single word: `coding`, `personal`, `finance`, `health`, `work`, `projects`, `tools`, `people`, `decisions`.

### Emotions

Emotion tags, comma-separated. Arc notation with `→`: `hope→relief` means trajectory.

Special: `—` means neutral/no emotion.

### Confidence

Integer 1-5. Maps to CIA-AAA credibility.

### Date

`YYYY-MM` for month precision. `YYYY-MM-DD` when day matters.

### Content

Compressed English with entity references and relationship operators.

**Entity references:** `@name` for known entities.
- `@user` — the human user
- `@agent` — the AI agent (Molty)
- `@project-name` — projects (e.g. `@agentbridge`, `@openclaw`)
- `@tool-name` — tools (e.g. `@clerk`, `@auth0`, `@sqlite`)

**Relationship operators:**
- `>over` — chose X over Y: `@clerk >over @auth0`
- `>replaces` — X replaces Y: `@sqlite >replaces @postgres`
- `>causes` — X causes Y: `deadline >causes stress`
- `>blocks` — X blocks Y: `auth-bug >blocks deploy`
- `→` — leads to / becomes: `prototype → production`

**Compression rules:**
- Strip articles (a, the, an)
- Strip filler (basically, essentially, actually, really)
- Abbreviate common phrases: "because" → `∵`, "therefore" → `∴`
- Parentheses for reasons: `(pricing+DX)` = because of pricing and DX
- Plus for conjunction: `dark-mode+vim+minimal`
- Slash for alternatives: `HU/EN`

## Examples

### Full English → ABM-L

```
"We decided to use Clerk instead of Auth0 because pricing is better and developer experience is cleaner"
→ [D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)

"The user prefers dark mode, uses vim, and wants minimal code with no verbose implementations"
→ [P|personal|—|4|2026-03] @user prefers dark-mode+vim+minimal-code

"AgentBridge uses SQLite with FTS5 for keyword search and ollama for vector embeddings. Not ChromaDB."
→ [FT|coding|trust|5|2026-04] @agentbridge: SQLite+FTS5+ollama, not ChromaDB

"I realized the whole approach was wrong — we need to decouple memory from the bridge first"
→ [VL|coding|frustration→determination|4|2026-04] decouple memory from bridge first — approach was wrong

"The project launched on March 15th after 3 months of work. First real deployment."
→ [MO|projects|pride|5|2026-03-15] @agentbridge launched — first deploy, 3mo work

"User's name is aksika, timezone CET, bilingual Hungarian/English, environment WSL2"
→ [F|personal|—|5|2026-01] @user: aksika, CET, HU/EN, WSL2

"Learned that FTS5 breaks on Hungarian agglutination — always use English for search keywords"
→ [LT|coding|frustration|4|2026-03] FTS5 breaks on HU agglutination — EN for search

"The auth migration was stressful at first but ended well after we found the right approach"
→ [M|coding|fear→relief→pride|4|2026-02] auth migration: stressful start → good outcome
```

### Wake-up context in ABM-L

```
## Core Memory (12 entries)
[F|personal|—|5] @user: aksika, CET, HU/EN bilingual, WSL2, direct+sarcastic
[P|personal|—|4] @user prefers dark-mode+vim+minimal-code
[FT|coding|trust|5] @agentbridge: TS+Node, SQLite+FTS5+ollama, Telegram+Discord
[D|coding|convict|5] @clerk >over @auth0 (pricing+DX)
[LT|coding|frustration|4] FTS5 breaks on HU — EN for search keywords
[F|coding|—|5] memory system: standalone @agentbridge/memory, IMemorySystem interface
[B|work|conviction|5] A2A peers: consultants only, no memory/tool access
[F|work|—|4] deploy: scripts/deploy.sh → ~/.agentbridge/
[O|projects|pride|5] @agentbridge created 2025-06 — personal AI agent bridge
[M|projects|pride↑|4] ABM v1 shipped 2026-04 — topic+tier+temporal
[F|people|trust|4] @dreamy: sleep maintenance agent, runs overnight
[L|work|—|5] /mnt/c/ FORBIDDEN except screenshots (read-only)
```

12 core memories, ~180 tokens. In English this would be ~600+ tokens.

## How it's used in the system

### Storage
- `content_en` — full English (always preserved, used for deep recall)
- `content_compressed` — ABM-L (generated during core promotion by Dreamy)

### Recall
- Deep recall → returns `content_en` (full context)
- Quick recall / wake-up → returns `content_compressed` (ABM-L)
- Search operates on `content_en` (FTS5 + embeddings) — ABM-L is output format, not search format

### Wake-up
- `buildWakeUp()` → SELECT `content_compressed` from core tier → inject after SOUL
- LLM reads ABM-L natively — no decoder needed

### Compression pipeline
```
instant-store → content_en (English) + emotion_tags + importance_flags
                    ↓ (during sleep, core promotion)
Dreamy → compress(content_en, metadata) → content_compressed (ABM-L)
```

## ABM-L vs AAAK comparison

| Aspect | AAAK (MemPalace) | ABM-L (ours) |
|---|---|---|
| Entity format | 3-letter codes (ALC, BOB) | @references (@clerk, @user) |
| Metadata | Separate zettel header | Inline prefix `[FLAGS\|TOPIC\|...]` |
| Emotions | Codes (vul, joy, anx) | Full words (vulnerability, joy, anxiety) |
| Arcs | Separate ARC line | Inline with → notation |
| Relationships | Not encoded | Operators (>over, >replaces, →) |
| Readability | Needs learning | Self-explanatory |
| Compression | ~30x on verbose transcripts | ~3-5x on already-concise memories |
| Target | Conversation archives | Extracted memory facts |

## Entity registry (auto-built)

No manual config file. Built automatically from core-tier memories:

```typescript
function buildEntityMap(coreMemories: string[]): Map<string, string> {
  // Scan content_en for recurring proper nouns
  // Map to @references
  // User name from user_profile → @user
  // Agent name from SOUL → @agent
  // Project names from topic=projects memories
  // Tool names from topic=tools memories
}
```

Rebuilt during each compression pass. No maintenance needed.

## Future: ABM-L as query language?

Currently ABM-L is output-only. Future possibility: use it as a query format too:

```
recall [D|coding|*|>3|2026-*] @clerk
→ "find decisions about Clerk in coding topic, confidence >3, from 2026"
```

This would let the agent query memory in a structured way instead of natural language keywords. The recall engine parses the ABM-L prefix as filters and the content as search terms.

Not for v2 — but architecturally possible because the format is parseable.
