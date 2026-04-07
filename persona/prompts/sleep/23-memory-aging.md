# §8l Memory Aging

Progressive aging: Original → English → ABM-L. Older tiers fade, essence persists.

## Process

Check current database size and compute pressure:
```bash
ls -la ~/.agentbridge/memory/memory.db | awk '{print $5}'
```

**Pressure levels** (based on MEMORY_MAX_DB_SIZE_MB in memory.env, default 4096):
- 0-50%: normal aging (base TTLs)
- 50-75%: gentle (0.7× TTLs)
- 75-90%: medium (0.35× TTLs)
- 90-95%: aggressive (0.15× TTLs)
- 95%+: critical (immediate aging)

## Aging rules

**Original language** (content_original) — base TTL: 14 days
- NULL content_original on memories older than TTL
- Protected: |emotion_score| ≥ 4, recall_count ≥ 3, tier = 'core'

**English** (content_en) — base TTL: 60 days
- NULL content_en on memories older than TTL
- Protected: |emotion_score| ≥ 4 AND importance_flags contains 'pivot' (flashbulb)
- After NULLing: remove FTS5 entry for that memory

**Never aged:**
- content_compressed (ABM-L) — permanent record
- embedding — vector search still works
- signature — Hamming search still works
- All metadata columns

## After aging

Report what was aged:
```
Aged: 42 originals NULLed, 12 English NULLed
Pressure: 62% (2.5GB / 4.0GB) — low
```
