# Memory System v2 — Tiered Memory + MemPalace Enhancements

Two-phase evolution of the memory system. Phase 1 adds structure to the existing DB. Phase 2 adds MemPalace-inspired features on top.

## Phase 1: Foundation (columns + logic)

### 1.1 Topic clustering

Add `topic TEXT DEFAULT 'general'` to `extracted_memories`.

- Dreamy assigns topic during sleep extraction
- Instant-store: agent can pass `--topic` flag, defaults to `general`
- Recall filters by topic first, then semantic search within topic
- Starting topics: `general`, `coding`, `personal`, `finance`, `health`, `work`, `projects`, `tools`, `people`, `decisions`
- Topics grow organically — Dreamy creates new ones as needed

**Recall improvement:** Instead of searching all N memories, narrow to topic first. MemPalace showed 34% retrieval boost from this kind of structural filtering.

### 1.2 Tier column (core vs general)

Add `tier TEXT DEFAULT 'general'` to `extracted_memories`.

- `core` — verified facts, confirmed preferences, decisions, lessons. Only Dreamy promotes to core during sleep.
- `general` — everything else. Lower bar for storage.
- Recall searches `tier = 'core'` first, extends to `general` if not enough results.
- Dreamy promotion criteria: high confidence, recalled at least once OR high emotion, verified against existing core entries.

### 1.3 Temporal validity

Add `valid_from TEXT` and `valid_to TEXT` to `extracted_memories`.

- `valid_from` — when the fact became true (set on creation)
- `valid_to` — when the fact stopped being true (NULL = still valid)
- Dreamy invalidates stale facts during sleep instead of deleting: `UPDATE SET valid_to = date('now')`
- Recall defaults to `valid_to IS NULL` (current facts only)
- Historical queries: `--include-expired` flag on recall

### 1.4 Lower storage threshold

- Instant-store during conversation: store more aggressively. Observations, context, half-formed thoughts.
- Current bar: agent decides what's "worth remembering"
- New bar: if it's a fact, preference, decision, event, or lesson — store it. Dreamy curates later.
- Sleep dedup handles the noise.

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

### New/modified sleep steps

- **Topic assignment** — Dreamy assigns topics to today's GP entries that have `topic = 'general'`
- **Core promotion** — Dreamy reviews GP entries, promotes best to `tier = 'core'`
- **Temporal review** — Dreamy checks core entries for staleness, sets `valid_to` on outdated facts

### CLI changes

- `agentbridge-store --topic coding --tier general` (tier always general on instant-store)
- `agentbridge-recall --topic coding` (filter by topic)
- `agentbridge-recall --pool core` (core-tier only)
- `agentbridge-recall --include-expired` (include invalidated facts)
- `agentbridge-edit --memory-id N --valid-to 2026-04-07` (manually expire)

### Recall flow

```
Query → core tier + topic filter (if topic detected)
  │
  ├── enough results? → return
  │
  └── extend to general tier (same topic, then all topics)
         │
         └── merge + deduplicate → return
```

---

## Phase 2: MemPalace-inspired enhancements

Builds on Phase 1 foundation. Inspired by the MemPalace project (~/workspace/mempalace).

### 2.1 Contradiction detection on store

Before Dreamy writes to core tier, check for conflicts:
- Recall similar core entries (semantic + keyword)
- If a new fact contradicts an existing one: flag, don't silently overwrite
- Resolution: invalidate old fact (`valid_to = now`), store new one, log the change
- Lightweight: only on core promotion, not on every instant-store

### 2.2 AAAK-style compression for wake-up context

Compress the core-tier wake-up layer into structured shorthand:
- Not full AAAK (their dialect is complex), but a simplified version
- Entity codes: `KP` for the agent, user's name abbreviated, project codes
- Structured format: `PREF: dark_mode+vim+minimal | PROJ: agentbridge(ts,telegram) | ...`
- Goal: load all core facts in ~200 tokens instead of ~2000
- The agent learns the format from session-start prompt

### 2.3 Wake-up context from core tier

On session start, load all valid core-tier entries as compressed context:
- `SELECT * FROM extracted_memories WHERE tier = 'core' AND valid_to IS NULL ORDER BY topic`
- Inject into session-start prompt (compressed)
- Replaces current static core-knowledge approach
- Dynamic: as Dreamy promotes/invalidates, wake-up context evolves automatically

### 2.4 Cross-topic linking (tunnels)

When the same entity/concept appears in multiple topics, create a link:
- Lightweight: just a `related_topics TEXT` field or a separate `topic_links` table
- Recall can follow links: "auth" topic → also check "security" topic
- Dreamy builds links during sleep by scanning for shared keywords across topics

---

## Implementation order

Phase 1: 1.1 (topic) → 1.2 (tier) → 1.3 (temporal) → 1.4 (lower threshold) → sleep steps → recall changes
Phase 2: 2.1 (contradiction) → 2.3 (wake-up from core) → 2.2 (compression) → 2.4 (tunnels)

Phase 1 is the foundation — all column additions, migration, CLI updates, sleep step changes.
Phase 2 is enhancement — each item is independent and can be done in any order after Phase 1.

## References

- MemPalace project: ~/workspace/mempalace
- Key insight borrowed: spatial/structural organization improves retrieval 34% (their benchmark)
- Key insight borrowed: temporal validity on facts (their knowledge_graph.py)
- Key insight borrowed: AAAK compression for wake-up context (their dialect.py)
- Key insight: two-database split rejected in favor of tier column (same benefit, less complexity)
