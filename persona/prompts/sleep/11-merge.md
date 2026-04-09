# §8 Memory Merge (Timeline-Based)

Review memories grouped by topic + entity for near-duplicates. Timelines make duplicates obvious — two entries in the same timeline saying the same thing.

## Step 1: Find timeline groups

```sql
SELECT id, content_en, topic, recall_count, relevance_score, created_at
FROM extracted_memories
WHERE valid_to IS NULL AND content_en IS NOT NULL
ORDER BY topic, created_at;
```

## Step 2: Within each topic group, identify duplicates

Look for memories that:
- Same topic AND same entity referenced
- Express the same fact in different words
- One supersedes the other (later date = more current)

## Step 3: Merge

```bash
agentbridge-store --merge --merge-ids <older_id>,<newer_id>
```

Rules:
- Max 5 merges per sleep cycle
- Only merge within the same topic group
- If one contradicts the other → invalidate the older one (`agentbridge-edit --memory-id <older> --valid-to <date>`) instead of merging
- When in doubt, skip — false merges lose information

Respond with merges performed (or "no duplicates found").
