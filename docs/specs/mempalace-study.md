# MemPalace Deep Study

Source: `~/workspace/mempalace` (v3.0.0, Python, MIT license)

## What it is

A local-first AI memory system. Stores conversation history and project files in a structured "palace" (ChromaDB vector store), makes them searchable via semantic search, and compresses context using a custom dialect (AAAK). Exposes 19 MCP tools for Claude Code / ChatGPT integration. No cloud, no API keys required for core functionality.

## Core thesis

"Store everything, make it findable." — Don't let AI decide what's worth remembering. Store verbatim text, organize it structurally, and let search find what's needed. Their benchmark proves this: raw ChromaDB with no extraction scores 96.6% on LongMemEval (highest zero-API score published).

---

## Architecture deep dive

### Storage: ChromaDB (single collection)

All data lives in one ChromaDB collection (`mempalace_drawers`). Each entry (a "drawer") has:
- `documents`: verbatim text content
- `metadatas`: `wing`, `room`, `hall`, `source_file`, `chunk_index`, `filed_at`, `ingest_mode`
- ChromaDB auto-generates embeddings using `sentence-transformers/all-MiniLM-L6-v2`

No SQLite for memories (only for the knowledge graph). No FTS5. Pure vector search.

**Comparison with ours:** We use SQLite + FTS5 + ollama embeddings. Hybrid keyword + semantic search. More flexible but more complex. Their single-store approach is simpler but can't do keyword-exact matching.

### Palace structure

Hierarchical metadata on flat vector entries:

```
Wing (person/project) → Room (topic) → Hall (memory type) → Drawer (verbatim content)
```

- **Wings** — top-level grouping. `wing_kai`, `wing_driftwood`, `wing_hardware`. Created per person or project.
- **Rooms** — topics within a wing. `auth-migration`, `gpu-pricing`, `chromadb-setup`. Auto-detected from folder structure (70+ patterns in `room_detector_local.py`) or content keywords.
- **Halls** — memory type corridors. Fixed set: `hall_facts`, `hall_events`, `hall_discoveries`, `hall_preferences`, `hall_advice`. Same in every wing.
- **Tunnels** — cross-wing connections. When room `auth-migration` exists in both `wing_kai` and `wing_driftwood`, a tunnel links them. Built dynamically from metadata, not stored explicitly.
- **Closets** — compressed summaries pointing to drawers. Currently just truncated snippets (200 chars). AAAK compression planned for closets.

**The retrieval boost from structure:**
```
Search all closets:          60.9%  R@10
Search within wing:          73.1%  (+12%)
Search wing + hall:          84.8%  (+24%)
Search wing + room:          94.8%  (+34%)
```

This is the key finding: narrowing search scope via metadata filters before vector similarity gives a 34% improvement. Not cosmetic — structural.

**Comparison with ours:** We have `memory_type` (similar to halls) and `keywords`, but no wing/room equivalent. Our planned `topic` column (Phase 1.1) is the room equivalent. We don't have wings because we're single-user, but topic clustering gives the same retrieval benefit.

### 4-layer memory stack

| Layer | What | Size | When loaded |
|---|---|---|---|
| L0 | Identity (`~/.mempalace/identity.txt`) | ~100 tokens | Always — static file |
| L1 | Essential story — top 15 drawers by importance, grouped by room | ~500-800 tokens | Always — auto-generated from DB |
| L2 | On-demand — wing/room filtered retrieval | ~200-500 per query | When topic comes up |
| L3 | Deep search — full semantic query across all drawers | Unlimited | When explicitly asked |

**L1 generation algorithm** (`layers.py`):
1. Fetch all drawers (optionally filtered by wing)
2. Score each by `importance` / `emotional_weight` / `weight` metadata
3. Sort descending, take top 15
4. Group by room for readability
5. Truncate each to 200 chars
6. Hard cap at 3200 chars (~800 tokens)

**Key insight:** L1 is a *computed view*, not a file. It changes as memories change. Every `wake_up()` call regenerates it from the current state of the palace.

**Comparison with ours:**
- Our L0 = SOUL.md (static, personality) — theirs is identity.txt (static, who am I)
- Our equivalent of L1 = agent_notes.md (dynamic but agent-written) + user_profile.md (static). We don't auto-generate from DB.
- Our L2 = recall during conversation (similar)
- Our L3 = embedding search (similar)
- **Gap:** We don't have an auto-generated L1. Phase 2.3 addresses this.

### AAAK dialect (`dialect.py`)

A rule-based text compression system. No LLM involved. Components:

**Entity codes:**
- Manual mapping: `{"Alice": "ALC", "Bob": "BOB", "Priya": "PRI"}`
- Auto-fallback: first 3 chars uppercase (`Jordan` → `JOR`)
- Stored in `~/.mempalace/entity_registry.json`

**Emotion codes (40+):**
```python
EMOTION_CODES = {
    "vulnerability": "vul", "joy": "joy", "fear": "fear", "trust": "trust",
    "grief": "grief", "wonder": "wonder", "rage": "rage", "love": "love",
    "hope": "hope", "despair": "despair", "peace": "peace", "humor": "humor",
    "tenderness": "tender", "raw_honesty": "raw", "self_doubt": "doubt",
    "relief": "relief", "anxiety": "anx", "exhaustion": "exhaust",
    "conviction": "convict", "quiet_passion": "passion", ...
}
```

Detection is keyword-based:
```python
_EMOTION_SIGNALS = {
    "decided": "determ", "prefer": "convict", "worried": "anx",
    "excited": "excite", "frustrated": "frust", "confused": "confuse",
    "love": "love", "hate": "rage", "hope": "hope", ...
}
```

**Flags (importance markers):**
```python
_FLAG_SIGNALS = {
    "decided": "DECISION", "chose": "DECISION", "switched": "DECISION",
    "founded": "ORIGIN", "created": "ORIGIN", "born": "ORIGIN",
    "core": "CORE", "fundamental": "CORE", "essential": "CORE",
    "turning point": "PIVOT", "changed everything": "PIVOT",
    "api": "TECHNICAL", "database": "TECHNICAL", "architecture": "TECHNICAL", ...
}
```

**Compression output format:**
```
Header:  wing|room|date|source_filename
Content: ZID:ENTITIES|topic_keywords|"key_quote"|EMOTIONS|FLAGS
```

Example:
```
wing_driftwood|auth-migration|2026-01|session_42
0:KAI+PRI|auth_clerk_migration|"recommended Clerk over Auth0"|convict+determ|DECISION
```

**Key sentence extraction:** Scores sentences by decision-word density, prefers short punchy sentences, truncates to 55 chars.

**Topic extraction:** Frequency-based keyword extraction with stop word filtering. Boosts proper nouns and CamelCase/hyphenated terms.

**Compression stats:** Claims 30x on verbose conversation transcripts. Realistic for already-concise extracted memories: 3-8x.

**Comparison with ours:** We have nothing like this. Our memories are stored in full English. The emotion scoring is a single integer -5 to +5 assigned by the LLM. AAAK gives granular emotion types, consistent pattern-based detection, and importance flags — all without LLM involvement.

### Knowledge graph (`knowledge_graph.py`)

Temporal entity-relationship triples in SQLite. Separate from the palace (ChromaDB).

**Schema:**
```sql
entities(id, name, type, properties, created_at)
triples(id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file, extracted_at)
```

**Key operations:**
- `add_triple("Kai", "works_on", "Orion", valid_from="2025-06-01")` — add a fact with temporal validity
- `invalidate("Kai", "works_on", "Orion", ended="2026-03-01")` — mark fact as no longer true (sets `valid_to`)
- `query_entity("Kai", as_of="2026-01-15")` — get facts valid at a specific date
- `timeline("Orion")` — chronological story of an entity
- Dedup: won't add identical triple if one already exists with `valid_to IS NULL`

**Comparison with ours:** We don't have a knowledge graph. We store facts as flat extracted memories. Their temporal validity (`valid_from`/`valid_to`) is what we're borrowing in Phase 1.3. Their entity-relationship structure (subject→predicate→object) is more expressive than our flat `content_en` + `memory_type`, but also more complex to maintain.

### Entity detection (`entity_detector.py`)

Two-pass auto-detection of people and projects from text:

1. **Candidate extraction:** Find all capitalized words appearing 3+ times (frequency filter)
2. **Signal scoring:** For each candidate, check:
   - Person signals: dialogue markers (`Kai: ...`), person verbs (`Kai said`), pronoun proximity, direct address (`hey Kai`)
   - Project signals: project verbs (`building Orion`), versioned references (`Orion v2`), code file references (`orion.py`)
3. **Classification:** Person ratio > 0.7 + two signal categories + score ≥ 5 → person. Ratio < 0.3 → project. Otherwise uncertain.
4. **Disambiguation:** For ambiguous words (e.g. "Grace" = name or concept), checks context patterns

**Entity registry** (`entity_registry.py`):
- Three sources: onboarding (user-confirmed), learned (auto-detected with high confidence), researched (Wikipedia lookup)
- Wikipedia fallback: if unknown word, checks Wikipedia REST API. "Not found in Wikipedia" = likely a proper noun (0.70 confidence)
- Ambiguous word handling: `COMMON_ENGLISH_WORDS` set (200+ words like "grace", "will", "mark", "may") triggers context disambiguation

**Comparison with ours:** We don't do entity detection. Our memories reference people/projects by name in free text. Their approach is more structured but requires maintenance (entity registry). For our use case (single user, known context), entity detection is less critical.

### General extractor (`general_extractor.py`)

Classifies text into 5 memory types using regex pattern matching (no LLM):

| Type | Markers (examples) |
|---|---|
| Decision | "let's use", "we decided", "instead of", "trade-off" |
| Preference | "I prefer", "always use", "never use", "my rule is" |
| Milestone | "it works", "breakthrough", "figured out", "shipped" |
| Problem | "bug", "error", "crash", "root cause", "the fix was" |
| Emotional | "love", "scared", "proud", "I feel", "never told anyone" |

**Disambiguation:** Resolved problems → milestones. Problem + positive sentiment → milestone or emotional.

**Code filtering:** Strips code lines before scoring (regex patterns for imports, function defs, shell commands, etc.). Only scores prose.

**Comparison with ours:** Our Dreamy extraction is LLM-based — more accurate but slower and model-dependent. Their regex approach is fast, consistent, and free. Could be useful as a pre-filter or fallback when LLM is unavailable.

### Conversation normalizer (`normalize.py`)

Converts 5 chat export formats to a standard transcript:
- Claude Code JSONL
- Claude.ai JSON
- ChatGPT conversations.json (with mapping tree traversal)
- Slack JSON
- Plain text (passthrough)

Output format: `> user message` followed by assistant response. Includes spellcheck on user text.

**Comparison with ours:** Not relevant — we capture conversations in real-time via Telegram/Discord, not from exports.

### Conversation miner (`convo_miner.py`)

Chunks conversations by exchange pair (Q+A = one unit). Falls back to paragraph chunking if no speaker markers found.

**Room detection for conversations:** Keyword scoring against 5 topic categories (technical, architecture, planning, decisions, problems).

**Comparison with ours:** Our conversation buffer stores raw messages. Dreamy extracts during sleep. Their approach is batch-oriented (mine a directory), ours is real-time.

### Palace graph (`palace_graph.py`)

BFS traversal across rooms and wings:
- Nodes = rooms (with wing/hall/count metadata)
- Edges = rooms that span multiple wings (tunnels)
- `traverse(start_room, max_hops=2)` — walk from a room, find connected rooms through shared wings
- `find_tunnels(wing_a, wing_b)` — find rooms bridging two wings

**Comparison with ours:** We don't have graph navigation. Phase 2.4 (cross-topic linking) borrows this concept in simplified form.

### MCP server (`mcp_server.py`)

19 tools exposed via MCP protocol. Key design decisions:
- `mempalace_status` returns the full AAAK spec + Palace Protocol in one call — the AI learns the system on first tool call
- Palace Protocol: 5 rules injected into every session (verify before responding, save after each session, invalidate changed facts)
- Agent diary: per-agent journal stored as drawers in a `diary` room within the agent's wing

### Auto-save hooks

Bash scripts for Claude Code's hook system:
- **Save hook** (Stop event): counts human messages in JSONL transcript. Every 15 messages, blocks the AI with `{"decision": "block", "reason": "save..."}`. AI saves to palace, then proceeds.
- **PreCompact hook**: always blocks before context compaction. Emergency save.
- Uses a `stop_hook_active` flag to prevent infinite loops.

**Comparison with ours:** We have instant-store (real-time) + sleep cycle (nightly batch). More continuous than their checkpoint-based approach.

---

## Benchmark methodology

Tested on 3 academic benchmarks:

| Benchmark | What it tests | Their score |
|---|---|---|
| LongMemEval (500 questions, 6 types) | Retrieval from long conversation history | 96.6% raw, 100% with Haiku rerank |
| LoCoMo | Session-level conversation retrieval | 60.3% raw |
| Personal palace heuristic | Custom bench on real data | 85% raw |

**Key finding:** Raw ChromaDB (no LLM, no extraction) beats Mem0 (~85%), Zep (~85%), and Mastra (94.87%) on LongMemEval. Only Supermemory ASMR (~99%, research-only) comes close.

**Why it works:** Verbatim storage preserves context that extraction loses. When you extract "user prefers Postgres" you lose the *why*. The embedding model finds the full context when queried.

**Caveat:** LongMemEval tests retrieval, not curation or evolution. Our system's strength (Dreamy curation, confidence scoring, recall-count boosting) isn't measured by this benchmark.

---

## What we're borrowing (summary)

| Concept | Their implementation | Our adaptation |
|---|---|---|
| Room structure (+34% retrieval) | ChromaDB metadata `room` field | `topic` column on extracted_memories |
| Temporal validity | Knowledge graph `valid_from`/`valid_to` | Same columns on extracted_memories |
| AAAK emotion codes | 40+ codes, keyword detection, arcs | Port to TypeScript, store alongside emotion_score |
| AAAK compression | Entity codes + flags + key sentence | Core-tier wake-up context compression |
| Contradiction detection | Knowledge graph fact-checking | Check core-tier before promotion |
| Cross-topic tunnels | Palace graph BFS traversal | `related_topics` field or link table |
| Dynamic L1 wake-up | Auto-generated from top drawers | Core-tier SELECT injected at session start |

## What we're NOT borrowing

| Concept | Why not |
|---|---|
| ChromaDB | SQLite + FTS5 + ollama is more integrated |
| Entity registry / detection | Single-user, known context — not needed |
| Conversation normalizer | We capture real-time, not from exports |
| Verbatim-only storage | We extract + curate — better for long-term memory evolution |
| Palace naming convention | Metadata, not architecture — our topic column achieves the same |

## What we SHOULD borrow (revised)

Previously excluded MCP server and onboarding as "we have our own tools." But the strategic goal is to **decouple the memory system from the bridge** and make it installable standalone — potentially as an OpenClaw plugin. MemPalace achieved exactly this universal access pattern.

### MemPalace's universal access model

```
pip install mempalace          ← standalone package, no host app needed
mempalace init ~/project       ← CLI works standalone
mempalace mine ~/chats/        ← CLI works standalone
mempalace search "query"       ← CLI works standalone
python -m mempalace.mcp_server ← any MCP-compatible tool can use it
```

Their memory system has ZERO coupling to any specific AI tool. Claude Code, ChatGPT, Cursor, local Llama — all access the same palace through either CLI or MCP. The hooks are optional adapters, not requirements.

### Our current coupling

```
agentbridge-recall     ← imports from ../memory/, lives in bridge repo
agentbridge-store      ← imports from ../memory/, lives in bridge repo
agentbridge-edit       ← imports from ../memory/, lives in bridge repo
MemoryManager          ← instantiated by Bridge.initMemory()
IPC server             ← started by Bridge.wireMemory()
Sleep cycle            ← orchestrated by bridge's heartbeat system
```

Everything lives in the bridge repo. The CLIs import bridge internals. The memory system can't run without the bridge.

### What universal access looks like for us

```
npm install @agentbridge/memory    ← standalone package
agentbridge-memory init            ← CLI works standalone
agentbridge-memory store ...       ← CLI works standalone
agentbridge-memory recall ...      ← CLI works standalone
agentbridge-memory search ...      ← CLI works standalone
node -e "require('@agentbridge/memory').mcp()"  ← MCP server for any tool
```

Plus: OpenClaw imports `@agentbridge/memory` as a plugin via `@openclaw/memory-host-sdk`.

### What needs to happen (extends existing decoupling plan)

The existing `docs/specs/memory-decoupling.plan.md` covers Phases 1-4 (interface extraction → directory reorg → standalone package). What's missing:

**Phase 5: Universal CLI** — rename/restructure CLIs from `agentbridge-recall` to a unified `agentbridge-memory` command with subcommands (`store`, `recall`, `edit`, `search`, `status`, `embed`). Works standalone without the bridge running.

**Phase 6: MCP server** — expose memory operations as MCP tools. Any MCP-compatible AI tool (Claude Code, Cursor, Kiro CLI, OpenClaw) can use the memory system. Modeled on MemPalace's 19-tool MCP server but adapted to our architecture:
- `memory_recall` — semantic + keyword search
- `memory_store` — instant store with topic/tier/emotion
- `memory_edit` — edit, boost, demote, merge, delete
- `memory_status` — stats, layer health
- `memory_wake_up` — core-tier context for session start
- `memory_kg_query` — knowledge graph queries (if we add one)

**Phase 7: OpenClaw plugin** — implement `@openclaw/memory-host-sdk` contract. Any OpenClaw agent gets persistent memory by adding the plugin.

### MemPalace patterns to adopt for universal access

| Pattern | Their implementation | Our adaptation |
|---|---|---|
| Single entry point | `mempalace` CLI with subcommands | `agentbridge-memory` CLI with subcommands |
| MCP server | `python -m mempalace.mcp_server` (19 tools) | `node -m @agentbridge/memory/mcp` |
| Zero-config start | `mempalace init` creates palace | `agentbridge-memory init` creates DB + config |
| Status/wake-up | `mempalace status`, `mempalace wake-up` | `agentbridge-memory status`, `agentbridge-memory wake-up` |
| Package install | `pip install mempalace` | `npm install @agentbridge/memory` |
| No host dependency | Works without Claude Code | Works without the bridge |

---

## Strengths we should acknowledge

1. **Simplicity** — one ChromaDB collection, one schema, one search path. We have 4 tables, FTS5, embeddings, IPC, multiple CLI tools. Their simplicity is a feature.
2. **Zero-LLM baseline** — proving that raw storage + good embeddings beats LLM-extracted summaries is a genuine insight. We should be cautious about over-extracting.
3. **Structure matters** — the 34% retrieval boost from wing/room filtering is real and reproducible. Topic clustering is not optional.
4. **Emotion detection without LLM** — consistent, fast, free. Our LLM-assigned emotion scores are subjective and model-dependent.

## Weaknesses we should avoid

1. **No curation** — they store everything and never clean up. Over time, noise accumulates. Our Dreamy sleep cycle is a major advantage.
2. **No memory mutation** — they can add and delete, but not edit, boost, demote, merge, or reclassify. Memories are static once filed.
3. **Batch-oriented** — mine a directory, search later. No real-time memory during conversation.
4. **Entity registry maintenance** — manual name→code mapping is fragile. New people require config updates.
5. **Single embedding model** — ChromaDB's default `all-MiniLM-L6-v2` is decent but not configurable. We can swap ollama models.
