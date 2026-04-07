# ABM — Competitive Analysis & Advanced Patterns

Study of Hippocampus, AME, Letta, and Mem0 memory systems. What we can borrow, what we already have, what's genuinely new.

## Comparison

| System | Architecture | What they do well | What we already have | What we should borrow |
|---|---|---|---|---|
| **Hippocampus** | Dynamic Wavelet Matrix | Multi-resolution storage, exact recall, bypasses vector DB | Three-tier aging (Original→English→ABM-L) | Embedding-free search mode, multi-resolution recall |
| **AME** | On-device matrix pipeline | Hardware-aware, smartphone SoC optimized | Pressure-based aging | Hardware profiles |
| **Letta** | OS-style memory hierarchy | Core (RAM) + archival (disk), page faults, LRU eviction | Core tier + general tier, core-first recall | Dynamic core management (real-time eviction) |
| **Mem0** | Self-improving extraction | Corrections feed back into extraction rules | Correction flag + reconsolidation | Self-improving compression rules |

---

## 1. Hardware Profiles

**Inspired by:** AME (smartphone SoC co-design)

**Problem:** ABM assumes desktop with ollama. Won't work on a Pi, phone, or constrained edge device.

**Solution:** Hardware profiles that configure the entire pipeline:

```env
# In memory.env
MEMORY_PROFILE=desktop    # desktop | mobile | edge | server
```

| Profile | Embeddings | FTS5 | ABM-L | Aging | Max DB | Wake-up |
|---|---|---|---|---|---|---|
| `server` | ✅ ollama | ✅ | ✅ | Off (unlimited) | Unlimited | Full (core + recent + recall) |
| `desktop` | ✅ ollama | ✅ | ✅ | Normal (pressure-based) | 4GB | Full |
| `mobile` | ❌ skip | ✅ | ✅ | Aggressive (2x pressure) | 512MB | ABM-L only |
| `edge` | ❌ skip | ❌ skip | ✅ | Maximum (4x pressure) | 128MB | ABM-L only, top 20 |

**What changes per profile:**
- `server`: no aging, no size limit, full pipeline
- `desktop`: default — everything enabled, 4GB limit, normal aging
- `mobile`: no embeddings (no ollama), aggressive aging, smaller DB. Search = FTS5 + ABM-L prefix parsing
- `edge`: no embeddings, no FTS5. Search = ABM-L prefix parsing + keyword match on content_compressed. Minimal footprint.

**The key insight from AME:** don't just disable features — redesign the search path for the hardware. On edge, ABM-L's structured prefix IS the index:

```
[D|coding|convict|5|2026-01] @clerk >over @auth0 (pricing+DX)
 ^  ^      ^      ^  ^
 │  │      │      │  └── date filter
 │  │      │      └── confidence filter
 │  │      └── emotion filter
 │  └── topic filter
 └── flag filter
```

Parse the prefix, filter, then keyword-match the content. No vector DB, no FTS5. Works on any device that can read SQLite.

---

## 2. Multi-Resolution Recall

**Inspired by:** Hippocampus (Dynamic Wavelet Matrix — multi-resolution decomposition)

**Problem:** Recall always returns the same detail level. Sometimes you need a quick fact, sometimes the full story.

**Solution:** Four recall resolutions, like wavelet frequency bands:

```typescript
type RecallResolution = "signal" | "compact" | "standard" | "full";
```

| Resolution | What's returned | Tokens/memory | Use case |
|---|---|---|---|
| `signal` | ABM-L prefix only: `[D\|coding\|convict\|5]` | ~3 tokens | Existence check, filtering |
| `compact` | Full ABM-L: `[D\|coding\|convict\|5\|2026-01] @clerk >over @auth0` | ~10 tokens | Wake-up, quick recall |
| `standard` | ABM-L + key English sentence | ~25 tokens | Normal conversation recall |
| `full` | Complete English + metadata | ~50+ tokens | Deep investigation |

```bash
agentbridge-recall --translated "auth" --resolution compact    # default for wake-up
agentbridge-recall --translated "auth" --resolution full       # deep dive
agentbridge-recall --translated "auth" --resolution signal     # just check if it exists
```

**Context window budget:** The agent (or bridge) picks resolution based on available context:
```typescript
function pickResolution(availableTokens: number, resultCount: number): RecallResolution {
  const tokensPerResult = availableTokens / resultCount;
  if (tokensPerResult > 50) return "full";
  if (tokensPerResult > 25) return "standard";
  if (tokensPerResult > 10) return "compact";
  return "signal";
}
```

Small context window → more memories at lower resolution.
Large context window → fewer memories at higher resolution.
Auto-adaptive. No manual tuning.

---

## 3. Dynamic Core Management

**Inspired by:** Letta (OS-style memory hierarchy with page faults and LRU eviction)

**Problem:** Core tier is only managed by Dreamy during sleep. Between sleeps, core is static. A memory recalled 50 times today is still "general" until tonight.

**Solution:** Real-time core management, like an OS page cache:

### Promotion on recall (page fault)
When a general-tier memory is recalled and used in conversation:
```
recall hit (general tier) → bump recall_count
  if recall_count >= 3 AND confidence >= 3:
    promote to core tier immediately (not waiting for sleep)
```

### Eviction on pressure (LRU)
When core tier exceeds a budget (e.g., 100 entries):
```
core tier > budget → evict least-recently-recalled entries back to general
  protected: flashbulb memories never evicted
  eviction order: lowest recall_count, then oldest last_recalled_at
```

### The OS parallel

| OS concept | ABM equivalent |
|---|---|
| RAM | Core tier (always loaded at wake-up) |
| Disk | General tier (searched on demand) |
| Page fault | Recall miss in core → search general |
| Page-in | Promote from general → core on recall |
| Eviction (LRU) | Demote from core → general when over budget |
| Dirty page writeback | Dreamy enriches/compresses during sleep |

**Core budget:** configurable per hardware profile:
- `server`: 500 core entries
- `desktop`: 100 core entries
- `mobile`: 30 core entries
- `edge`: 10 core entries

---

## 4. Embedding-Free Search Mode

**Inspired by:** Hippocampus (bypasses dense vector databases for ultra-fast local search)

**Problem:** Embedding search requires ollama running. On mobile/edge, no ollama available.

**Solution:** ABM-L prefix is a structured index. Parse it for filtering, keyword-match the content:

```typescript
function searchABML(query: string, memories: CompressedMemory[], filters?: ABMLFilters): CompressedMemory[] {
  let results = memories;
  
  // Stage 1: prefix filtering (instant, O(n) scan)
  if (filters?.flag) results = results.filter(m => m.flags.includes(filters.flag));
  if (filters?.topic) results = results.filter(m => m.topic === filters.topic);
  if (filters?.minConfidence) results = results.filter(m => m.confidence >= filters.minConfidence);
  if (filters?.dateRange) results = results.filter(m => m.date >= filters.dateRange.start);
  
  // Stage 2: keyword match on content (fast, no embeddings)
  const keywords = query.toLowerCase().split(/\s+/);
  results = results.filter(m => 
    keywords.some(kw => m.compressed.toLowerCase().includes(kw))
  );
  
  // Stage 3: rank by relevance (keyword count + confidence + emotion)
  return results.sort((a, b) => score(b, keywords) - score(a, keywords));
}
```

**Performance:** For 10,000 memories, this is ~1-5ms. No vector DB, no embeddings, no external process. Works on any device.

**When embeddings ARE available:** Use them for semantic search (better quality). ABM-L prefix filtering as pre-filter to narrow candidates before embedding comparison → faster even on desktop.

**Hybrid search pipeline:**
```
Query → ABM-L prefix filter (topic, flags, date) → candidates
  │
  ├── embeddings available → semantic rerank → top N
  └── no embeddings → keyword match + score → top N
```

---

## 5. Self-Improving Compression

**Inspired by:** Mem0 (self-improving extraction layer)

**Problem:** ABM-L compression rules are static regex patterns. They don't learn from corrections.

**Solution:** When the agent or user corrects a recall result, feed the correction back:

```
Agent recalls: "[D|coding|convict|5] @clerk >over @auth0 (pricing+DX)"
User says: "No, we switched BACK to Auth0 last month"
  │
  ├── Store correction: "[C|coding|—|5|2026-04] @auth0 >replaces @clerk (reversed decision)"
  ├── Invalidate old: valid_to = now on the Clerk decision
  └── Learn: entity relationship @clerk→@auth0 is volatile (changed twice)
```

Dreamy tracks entity relationship stability:
- `@clerk >over @auth0` then `@auth0 >replaces @clerk` → volatile relationship
- Volatile relationships get lower confidence in future compression
- Stable relationships (never contradicted) get higher confidence

This is lightweight — just a counter on entity pairs, not ML. But it means the compression gets better over time as the system learns which facts are stable and which are fluid.

---

## Summary: what ABM v2 gains from this study

| Enhancement | Source | Effort | Impact |
|---|---|---|---|
| Hardware profiles (4 tiers) | AME | Medium | Enables mobile/edge/Pi deployment |
| Multi-resolution recall (4 levels) | Hippocampus | Low | Auto-adaptive context window usage |
| Dynamic core management (LRU) | Letta | Medium | Real-time core promotion, no sleep dependency |
| Embedding-free search | Hippocampus | Low | Works without ollama, faster pre-filtering |
| Self-improving compression | Mem0 | Low | Compression quality improves over time |

All five are additive to the existing v2 plan. No conflicts with current architecture.
