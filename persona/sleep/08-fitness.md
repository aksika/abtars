# §7 Fitness Review

Review extracted memories using Darwinism signals.

```sql
SELECT id, substr(content_en,1,80), recall_count, relevance_score, confidence, classification, last_recalled_at, created_at
FROM extracted_memories WHERE classification < 3 ORDER BY recall_count DESC LIMIT 50;
```

Rules:
- **High recall + high relevance** → no action
- **High recall + negative relevance** → candidate for rewording via `agentbridge-edit`
- **Zero recall after 60+ days** → candidate for deletion
- **Low confidence (1-2) + zero recall** → first to prune

## Core Knowledge Maintenance

Review `~/.agentbridge/memory/core/user_profile.md` and `~/.agentbridge/memory/core/agent_notes.md`:
- Remove stale or redundant lines
- Keep each file ≤10 lines of high-signal facts only
- These files are injected into every context window — brevity is critical

## Translation Quality Check

```sql
SELECT id, substr(content_en,1,100), substr(content_original,1,100)
FROM extracted_memories
WHERE content_en != content_original AND content_original IS NOT NULL
ORDER BY id DESC LIMIT 20;
```

If `content_en` contains untranslated foreign words, fix:
```bash
agentbridge-edit --memory-id <N> --translated "<corrected English>" --integrity 1 --caller dreamy
```

Respond with: memories pruned, reworded, translations fixed.
