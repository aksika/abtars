# §8n Emotion Context Backfill

Some memories have emotion_tags but no emotion_context (the short cause phrase explaining WHY the emotion occurred).

Review these memories and add context using `agentbridge-edit`:

```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT id, content_en, emotion_tags FROM extracted_memories WHERE emotion_tags IS NOT NULL AND emotion_tags != '' AND emotion_context IS NULL ORDER BY ABS(emotion_score) DESC LIMIT 15;"
```

For each memory, infer the cause from the content + tags. The context should be 3-5 words explaining the trigger:
- "FTS5 breaks on Hungarian" + frustration → context: "Hungarian FTS5 limitation"
- "Launched OpenClaw successfully" + pride → context: "successful product launch"
- "Deploy failed 3 times" + frustration → context: "repeated deploy failures"

Use `agentbridge-edit --memory-id <N> --emotion-context "cause phrase"` for each.

Skip memories where the cause is unclear — don't guess. Only fill obvious ones.

Respond with a count of how many you filled.
