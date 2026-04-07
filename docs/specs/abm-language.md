# ABM-L — AgentBridge Memory Language

A purpose-built symbolic language for AI memory storage, recall, and context loading. Designed to be read natively by any LLM without training — it's structured text, not a binary format.

## The core insight

**ABM-L is the PRIMARY format for LLM consumption. English is the archive.**

Every memory is stored in both formats at write time. The LLM always sees ABM-L. English is preserved for human reading, deep investigation, and full-context recall when needed.

This is not a compression afterthought — it's the fundamental architecture decision.

## Why: the context window math

| Scenario | English | ABM-L | Savings |
|---|---|---|---|
| 50 core memories at wake-up | ~2500 tokens | ~500 tokens | 2000 tokens |
| 10 recalled memories per query | ~500 tokens | ~150 tokens | 350 tokens |
| Recent session context (20 msgs) | ~800 tokens | ~250 tokens | 550 tokens |
| **Total per session** | **~3800 tokens** | **~900 tokens** | **~2900 tokens** |

For a 128K context model: nice optimization.
For a 32K context model: significant improvement.
For a 4K local model: the difference between "unusable" and "works well."

### What fits in a 4K local model

**Without ABM-L:**
```
SOUL:           ~500 tokens
Core memories:  ~1500 tokens (30 facts in English)
Recent context: ~500 tokens
─────────────────────────────
Used:           2500 tokens
Remaining:      1500 tokens for conversation ← barely usable
```

**With ABM-L:**
```
SOUL:           ~500 tokens
Core memories:  ~300 tokens (50 facts in ABM-L)
Recent context: ~200 tokens (ABM-L compressed)
Recent recall:  ~150 tokens (10 memories in ABM-L)
─────────────────────────────
Used:           1150 tokens
Remaining:      2850 tokens for conversation ← usable
```

More memories loaded, more room for conversation. ABM-L makes small models viable.

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

## Three-tier storage with progressive aging

Every memory exists in three representations, each progressively more compressed:

```
Tier 1: Original    → raw user language (Hungarian, etc.)     ~200 bytes
Tier 2: English     → translated, full description            ~150 bytes
Tier 3: ABM-L       → compressed symbolic format              ~50 bytes
         + metadata  → columns (emotion, flags, topic, etc.)  ~100 bytes
```

### Aging policy

Memories age like human memory — sensory detail fades first, narrative next, essence persists:

```
Day 0          Tier 1 + Tier 2 + Tier 3    ~400 bytes    full fidelity
~2 weeks       ██████  Tier 2 + Tier 3      ~200 bytes    original NULLed
~2 months      ██████  ████████  Tier 3      ~50 bytes     English NULLed
Forever                          Tier 3      ~50 bytes     ABM-L + metadata
```

**Storage savings over time:**
- 10,000 memories, all tiers: ~4 MB
- After aging: ~500 KB (87.5% reduction)

### Protection from aging

Not all memories age equally. Protected memories keep all tiers longer:

| Condition | Original TTL | English TTL |
|---|---|---|
| Default | 14 days | 60 days |
| High emotion (\|score\| ≥ 4) | 90 days | 1 year |
| Frequently recalled (count ≥ 3) | 90 days | 1 year |
| Core tier | 90 days | 1 year |
| Flashbulb (\|score\| ≥ 4 AND "pivot" flag) | Never | Never |

Flashbulb memories — the pivotal moments — keep full fidelity forever. Everything else gradually compresses to its essence.

### What survives aging

When English is NULLed, these persist:
- `content_compressed` (ABM-L) — the fact itself
- `embedding` BLOB — vector for semantic search (computed from English, but independent)
- All metadata columns — emotion_tags, importance_flags, topic, tier, confidence, etc.
- FTS5 entry removed (no text to index) — but embedding search still works

### Implementation

Aging is a Dreamy sleep step, not real-time:

```sql
-- Step 1: NULL originals past TTL (protected memories exempt)
UPDATE extracted_memories
SET content_original = NULL
WHERE content_original IS NOT NULL
  AND created_at < :original_cutoff
  AND ABS(COALESCE(emotion_score, 0)) < 4
  AND COALESCE(recall_count, 0) < 3
  AND tier != 'core';

-- Step 2: NULL English past TTL (protected memories exempt)
UPDATE extracted_memories
SET content_en = NULL
WHERE content_en IS NOT NULL
  AND created_at < :english_cutoff
  AND ABS(COALESCE(emotion_score, 0)) < 4
  AND COALESCE(recall_count, 0) < 3
  AND NOT (importance_flags LIKE '%pivot%' AND ABS(COALESCE(emotion_score, 0)) >= 4);

-- Step 3: Clean up FTS5 for NULLed English entries
INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en)
  SELECT 'delete', id, '' FROM extracted_memories WHERE content_en IS NULL;
```

### Configuration

Memory system has its own config file (`~/.agentbridge/memory.env`), separate from the bridge:

```env
# Storage limits
MEMORY_MAX_DB_SIZE_MB=4096           # default: 4096 (4GB). 0 = unlimited.

# Aging TTLs (base values — adjusted by pressure)
MEMORY_ORIGINAL_TTL_DAYS=14          # default: 14 days
MEMORY_ENGLISH_TTL_DAYS=60           # default: 60 days
MEMORY_AGING_ENABLED=true            # default: true

# Embedding
EMBEDDING_ENABLED=true
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_URL=http://localhost:11434
```

### Pressure-based aging

Aging TTLs are base values. As the database approaches `MEMORY_MAX_DB_SIZE_MB`, aging accelerates:

```
DB usage    Pressure    Original TTL    English TTL    Effect
─────────────────────────────────────────────────────────────
0-50%       none        14 days         60 days        normal aging
50-75%      low         10 days         45 days        gentle acceleration
75-90%      medium      5 days          20 days        noticeable acceleration
90-95%      high        2 days          7 days         aggressive aging
95-100%     critical    0 (immediate)   2 days         emergency — only ABM-L survives
```

Formula:
```typescript
function pressureMultiplier(usedBytes: number, maxBytes: number): number {
  if (maxBytes === 0) return 1; // unlimited
  const ratio = usedBytes / maxBytes;
  if (ratio < 0.5) return 1;
  if (ratio < 0.75) return 0.7;
  if (ratio < 0.90) return 0.35;
  if (ratio < 0.95) return 0.15;
  return 0; // critical — age everything immediately
}

const effectiveTTL = baseTTL * pressureMultiplier(dbSize, maxSize);
```

Protected memories (flashbulb, core tier with high emotion) are still exempt until critical pressure (>95%). At critical, even protected memories lose their original — only ABM-L + embeddings survive.

### Why this works

- Small device (Raspberry Pi, 1GB limit): aggressive aging, ABM-L-heavy. Memory works fine — just less deep-investigation capability.
- Desktop (4GB limit): relaxed aging, full fidelity for months.
- Server (unlimited): no aging pressure, everything preserved.
- The system self-regulates. No manual cleanup needed.

### Dreamy reports pressure

During sleep, Dreamy logs the current pressure level:
```
[SLEEP] Memory pressure: 62% (2.5GB / 4.0GB) — low pressure, aging at 0.7x
[SLEEP] Aged: 142 originals NULLed, 38 English NULLed, freed ~45MB
```

At high pressure, Dreamy warns the user:
```
[SLEEP] ⚠️ Memory pressure: 91% (3.6GB / 4.0GB) — aggressive aging active
```

### Recall behavior with aged memories

```
agentbridge-recall "auth decision"
  │
  ├── Memory has ABM-L + English → return ABM-L (default) or English (--full)
  ├── Memory has ABM-L only (English aged) → return ABM-L, --full returns ABM-L too
  └── Search: embedding search always works (vectors persist), FTS5 only for non-aged
```

The agent never notices aging — ABM-L is always there. Deep investigation (`--full`) gracefully degrades: returns English if available, ABM-L if not.

### The human brain parallel

| Human memory | ABM tier | Fades after |
|---|---|---|
| Sensory memory (exact words, tone, setting) | Original language | ~2 weeks |
| Episodic memory (what happened, full narrative) | English description | ~2 months |
| Semantic memory (the fact, the lesson, the decision) | ABM-L | Never |

You remember THAT you decided to use Clerk and WHY (ABM-L). You forget the exact conversation where you discussed it (English). You forget what language you were speaking (Original). Just like real memory.

### Store-time compression (not sleep-time)

**Critical design decision:** Compression happens at STORE time, not during sleep. Every `agentbridge-store` call produces both formats immediately.

```
agentbridge-store --translated "We decided to use Clerk..." --topic coding
  │
  ├── content_en = "We decided to use Clerk instead of Auth0 because pricing is better"
  ├── emotion_tags = detectEmotions(content_en) → "conviction"
  ├── importance_flags = detectFlags(content_en) → "decision"
  └── content_compressed = compress(content_en, tags, flags, topic) → "[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)"
```

Cost: ~1-5ms extra per store (pure string manipulation, no LLM). We store ~10-50 times/day. We recall hundreds of times. The trade-off is massively in favor of store-time compression.

### Recall returns ABM-L by default

```
agentbridge-recall --translated "auth decision" --chat-id 123
  → returns content_compressed (ABM-L) — injected into LLM context

agentbridge-recall --translated "auth decision" --chat-id 123 --full
  → returns content_en (English) — for deep investigation
```

10 recalled memories in ABM-L ≈ 150 tokens. In English ≈ 500 tokens. Same information, 70% fewer tokens.

### Wake-up loads everything

Because ABM-L is compact, we can load MORE at session start:

```
buildWakeUp():
  1. ALL core-tier memories in ABM-L (~300 tokens for 50 memories)
  2. Recent session memories in ABM-L (~200 tokens for 20 messages)
  3. Topic arcs (~50 tokens for emotional trajectories)
  ─────────────────────────────────
  Total: ~550 tokens (vs ~3000 in English)
```

The agent starts every session knowing everything important. No reactive recall needed for core facts.

### Session context compression

Daily summaries and recent message context also compressed to ABM-L during compaction:

```
English session summary (~300 tokens):
"Today we worked on decoupling the memory system from the bridge. We created the IMemorySystem
interface, moved SleepStateGatherer, added maintenance methods. All 812 tests pass."

ABM-L session summary (~80 tokens):
[M|coding|pride|4|2026-04-07] ABM Phase 0 complete — IMemorySystem interface, 27 files decoupled, 812 tests pass
[T|coding|—|5|2026-04-07] maintenance methods: WAL+FTS+dedup+embed+cleanup+defaults on interface
[D|coding|conviction|4|2026-04-07] sleep decoupled from memory — optional addon
```

### Compression pipeline

```
                    STORE TIME                          SLEEP TIME
                    ──────────                          ──────────
User message → instant-store                     Dreamy reviews
                │                                      │
                ├── content_en (English)                ├── core promotion (general → core)
                ├── emotion_tags (detected)             ├── re-compress if enriched
                ├── importance_flags (detected)         ├── build emotional arcs
                └── content_compressed (ABM-L)          └── build cross-topic links
```

### What the LLM sees

Every LLM interaction uses ABM-L for memory context:

```
[SOUL — personality, rules, tools]

[CORE MEMORY — 47 entries]
[F|personal|—|5] @user: aksika, CET, HU/EN, WSL2, direct+sarcastic
[P|personal|—|4] @user prefers dark-mode+vim+minimal-code
[DT|coding|convict|5] @clerk >over @auth0 (pricing+DX)
[FT|coding|trust|5] @agentbridge: TS+Node, SQLite+FTS5+ollama
[LT|coding|frust|4] FTS5 breaks on HU agglutination — EN for search
...

[RECENT — last session, 2026-04-07]
[M|coding|pride|4] ABM Phase 0 done — 27 files decoupled
[D|coding|convict|4] sleep decoupled — optional addon

[RECALLED — query: "auth migration"]
[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
[M|coding|fear→relief|4|2026-02] auth migration complete — stressful→good
[L|coding|frust|3|2026-02] OAuth token refresh was the root cause

[SESSION START — 2026-04-07T15:00:00]
```

Total memory context: ~700 tokens. In English: ~3000 tokens. Same information.

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
