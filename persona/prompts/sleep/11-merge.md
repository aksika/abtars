# §8 Memory Merge

Review the top most-recalled extracted memories for near-duplicates:

```sql
SELECT id, content_en, recall_count, relevance_score
FROM extracted_memories WHERE recall_count > 0 ORDER BY recall_count DESC LIMIT 30;
```

For each pair that expresses the same fact in different words:
```bash
agentbridge-store --merge --merge-ids <id_A>,<id_B>
```

Rules:
- Max 5 merges per sleep cycle
- Only merge when confident both express the same fact
- When in doubt, skip — false merges lose information

Respond with merges performed (or "no duplicates found").
