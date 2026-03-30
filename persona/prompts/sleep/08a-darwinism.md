# §7a Darwinism Review

Review extracted memories that need attention. Only candidates requiring action are shown — healthy memories are excluded.

## Prune candidates (zero recall, older than 60 days)

```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT id, substr(content_en,1,80), recall_count, confidence, created_at FROM extracted_memories WHERE recall_count = 0 AND created_at < (strftime('%s','now','-60 days') * 1000) AND classification < 3 ORDER BY confidence ASC LIMIT 20;"
```

Rules:
- **Low confidence (1-2) + zero recall** → delete
- **Medium confidence (3) + zero recall + >90 days** → delete
- **High confidence (4-5) + zero recall** → keep (important but not yet needed)

## Reword candidates (negative relevance)

```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT id, substr(content_en,1,80), relevance_score FROM extracted_memories WHERE relevance_score < 0 AND classification < 3 LIMIT 10;"
```

If the content is still valid but poorly worded → reword via `agentbridge-edit --memory-id <N> --translated "..." --caller dreamy`.
If the content is wrong or outdated → delete.

Respond with: memories pruned, reworded.
