# §4c Extract Verification + Emotion Harvest

## Verify Extractions

Scan messages not yet processed (after the extraction watermark):

```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT id, role, substr(content,1,120) FROM messages WHERE chat_id = 7773842843 AND timestamp > (SELECT COALESCE(last_processed_timestamp, 0) FROM extraction_watermarks WHERE chat_id = 7773842843) ORDER BY timestamp LIMIT 20;"
```

For each exchange with lasting value:
1. Check if facts are already in extracted_memories
2. If not, extract via `agentbridge-store --translated "..." --original "..." --memory-type <TYPE> --emotion-score <SCORE> --chat-id 7773842843 --trust 2 --integrity 2 --credibility 2`
3. After confirming stored, garbage-mark the verbose originals

**Extract:** facts, decisions, preferences, events, lessons, tool configs.
**Skip:** greetings, debugging noise, purely instructional exchanges.

## Emotion Harvest (verbal only)

Scan remaining messages for verbal emotional reactions (emoji reactions handled at runtime):
- Positive: "fasza!", "király!", "awesome!", "excellent!", "nice!"
- Negative: "a faszomat!", "baszd meg!", "goddamn it!", "fuck!"

For each:
1. Find the nearest relevant extracted_memory
2. `agentbridge-edit --memory-id <N> --emotion-score <score> --caller dreamy` (+1 to +3 or -1 to -3)
3. Add message + paired response to `garbage.json`

Respond with: messages extracted, emotions harvested.
