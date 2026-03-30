# §7c Translation Quality Check

Scan bilingual memories where `content_en` might contain untranslated foreign words:

```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT id, substr(content_en,1,100), substr(content_original,1,100) FROM extracted_memories WHERE content_en != content_original AND content_original IS NOT NULL ORDER BY id DESC LIMIT 10;"
```

For each result: if `content_en` contains non-English words that should have been translated, fix:
```bash
agentbridge-edit --memory-id <N> --translated "<corrected English>" --integrity 1 --caller dreamy
```

The edit tool nulls the embedding automatically — re-embedding happens on next batch.

Respond with count of translations fixed (or "all translations clean").
