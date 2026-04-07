# ABM — AgentBridge Memory System

Standalone, pluggable memory system. Extracted from the bridge, versioned independently, usable by any consumer (bridge, OpenClaw, MCP clients).

## Architecture

```
Phase 0: Decouple → @agentbridge/memory (standalone package, IMemorySystem interface)
                          │
Phase 1: Features   → ABM v1 (topic, tier, temporal, core files)
                          │
Phase 2: Features   → ABM v2 (AAAK emotion, contradiction, dynamic wake-up, tunnels)
                          │
Phase 3: Access     → MCP server, unified CLI, OpenClaw plugin
                          │
                    ┌─────┴─────┐
                    │           │
              Bridge uses    OpenClaw uses
              v1 or v2       v1 or v2
```

The `IMemorySystem` interface (Phase 0) is the contract. v1 and v2 both implement it. Consumers don't care which version is behind the interface.

---

## Phase 0: Decouple (refactor existing code)

Extract the memory system from the bridge into `@agentbridge/memory`. No new features — pure structural cleanup.

**Source:** `docs/specs/memory-decoupling.plan.md`

### 0.1 Interface extraction

Define `IMemorySystem` — the contract between any consumer and the memory system:
- Lifecycle: `initialize()`, `close()`
- Messages: `recordMessage()`, `loadRecentMessages()`
- Memories: `store()`, `edit()`, `recall()`, `merge()`, `cascadeDelete()`
- Sessions: `persistSession()`, `restoreSessions()`
- Read-only: `getStats()`, `readCoreKnowledge()`, `getConfig()`

### 0.2 Eliminate DB leaks

Remove `getDatabase()` and `getMemoryIndex()` from public API. All access through interface methods.

### 0.3 Directory reorganization

Memory files already in `src/memory/`. Ensure all imports go through `src/memory/index.ts`. No bridge internals leak in.

### 0.4 Standalone package boundary

27 files, zero external imports, `index.ts` entry point, `mem-types.ts` self-contained.

**Status: ✅ Done (2026-04-07)**

### 0.5 Decouple sleep from memory

Sleep is an optional enhancement — memory core works without it.

| Tier | Package | LLM needed |
|---|---|---|
| Core | `@agentbridge/memory` | No |
| Core + sleep | + `@agentbridge/memory-sleep` | Yes |
| Core + sleep + AAAK | + ABM v2 features | Yes |

Add maintenance methods to `IMemorySystem` (`runWalCheckpoint`, `rebuildFtsIndexes`, `cleanupOldMessages`, `backfillEmbeddings`, `deduplicateMessages`). Sleep calls interface, not raw DB.

**After Phase 0:** Memory is standalone. Sleep is optional. Ready for Phase 1.

---

## Phase 1: ABM v1 — Tiered Memory

First feature release. Adds structure to the existing DB.

### 1.1 Topic clustering
- `topic` column on `extracted_memories`
- Dreamy assigns during extraction, agent can pass `--topic` on instant-store
- Recall filters by topic first → 34% retrieval boost (MemPalace benchmark)

### 1.2 Tier column (core vs general)
- `tier` column: `core` (Dreamy-promoted, verified) vs `general` (everything else)
- Recall searches core first, extends to general if needed

### 1.3 Temporal validity
- `valid_from`/`valid_to` columns
- Dreamy invalidates stale facts instead of deleting
- Historical queries with `--include-expired`

### 1.4 Core files restructure
- `agent_notes.md` → `core_facts.md` (static rules) + `agent_notes.md` (dynamic lessons)
- `user_profile.md` stays, migrates to core-tier in v2

### 1.5 Lower storage threshold
- Store more aggressively to general tier
- Dreamy curates later during sleep

### Schema migration
```sql
ALTER TABLE extracted_memories ADD COLUMN topic TEXT DEFAULT 'general';
ALTER TABLE extracted_memories ADD COLUMN tier TEXT DEFAULT 'general';
ALTER TABLE extracted_memories ADD COLUMN valid_from TEXT;
ALTER TABLE extracted_memories ADD COLUMN valid_to TEXT;

CREATE INDEX idx_em_topic ON extracted_memories(topic);
CREATE INDEX idx_em_tier ON extracted_memories(tier);
CREATE INDEX idx_em_valid ON extracted_memories(valid_to);
```

### New sleep steps
- Topic assignment — assign topics to untagged entries
- Core promotion — promote best general entries to core
- Temporal review — invalidate stale core facts

### Recall flow
```
Query → core tier + topic filter
  ├── enough? → return
  └── extend to general tier → merge + dedup → return
```

**After Phase 1:** ABM v1 is released. The bridge (and any future consumer) can pin to v1. Existing behavior preserved, new features opt-in via new columns/flags.

---

## Phase 2: ABM v2 — MemPalace Enhancements

Inspired by the MemPalace project (`~/workspace/mempalace`). Study: `docs/specs/mempalace-study.md`.

### 2.1 AAAK emotion scoring + compression
- Port MemPalace's 40+ emotion codes + keyword detection to TypeScript
- `emotion_codes TEXT` column (e.g. `"hope+trust+determ"`)
- `content_compressed TEXT` column (AAAK form for core-tier entries)
- Entity registry auto-built from core-tier entities
- Dreamy compresses during core promotion
- Wake-up loads compressed form; deep recall returns English

### 2.2 Contradiction detection
- Before core promotion, recall similar core entries
- Flag contradictions, invalidate old fact, store new one
- Only on core promotion, not every instant-store

### 2.3 Dynamic wake-up from core tier
- `SELECT content_compressed FROM extracted_memories WHERE tier = 'core' AND valid_to IS NULL`
- Injected at session start, replaces static core-knowledge files
- `user_profile.md` migrates here — Dreamy keeps user facts current automatically

### 2.4 Cross-topic linking (tunnels)
- `related_topics` field or `topic_links` table
- Recall follows links: "auth" → also check "security"
- Dreamy builds links during sleep

**After Phase 2:** ABM v2 is released. Consumers can upgrade from v1 → v2. Interface unchanged — new features are additive.

---

## Phase 3: Universal Access

Makes ABM usable by any AI tool, not just the bridge.

### 3.1 Unified CLI
```bash
agentbridge-memory init
agentbridge-memory store --content "..." --topic coding
agentbridge-memory recall "auth decision" --pool core
agentbridge-memory search "why GraphQL"
agentbridge-memory status
agentbridge-memory wake-up
```
Works standalone. No bridge needed.

### 3.2 MCP server
Expose as MCP tools for any MCP-compatible AI tool:
- `memory_recall`, `memory_store`, `memory_edit`
- `memory_status`, `memory_wake_up`, `memory_search`

### 3.3 OpenClaw plugin
Implement `@openclaw/memory-host-sdk` contract. Any OpenClaw agent gets persistent memory.

---

## Implementation order

```
Phase 0: 0.1 → 0.2 → 0.3 → 0.4 → 0.5 (decouple, standalone, sleep optional)
Phase 1: 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → sleep steps → recall (ABM v1)
Phase 2: 2.1 → 2.2 → 2.3 → 2.4 (ABM v2)
Phase 3: 3.1 → 3.2 → 3.3 (universal access)
```

Phase 0 is prerequisite for everything. Phases 1-3 are sequential (each builds on previous). Within each phase, items are ordered by dependency.

## References

- Memory decoupling plan: `docs/specs/memory-decoupling.plan.md`
- MemPalace deep study: `docs/specs/mempalace-study.md`
- Memory v2 detailed spec: `docs/specs/memory-v2-tiered.plan.md`
- OpenClaw memory SDK: `~/workspace/openclaw/packages/memory-host-sdk/`
- lossless-claw reference: `~/workspace/lossless-claw` (standalone plugin pattern)
