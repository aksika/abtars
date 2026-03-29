# §9 Consolidation

Summarize today's messages into a daily file:
- Output: `~/.agentbridge/memory/daily/daily_${WAKEUP_DATE}.md` (format: `daily_YYYYMMDD.md`)
- If the daily file already exists and covers the full window, skip. If partial, overwrite.
- The date in the filename is the **wake-up date** (date portion of the previous sleep audit)

Content rules:
- Include: key topics discussed, decisions made, facts learned, action items, emotional highlights
- Exclude: routine greetings, tool execution noise, formatting artifacts
- **Classification**: Replace CONFIDENTIAL (2) and SECRET (3) content with `<REDACTED — classification N>`. The fact that a topic was discussed can be mentioned, but not the content itself.
- Write in English, concise prose, organized chronologically

Source data:
```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT role, content FROM messages WHERE timestamp > ${LAST_SLEEP_TS} AND timestamp <= ${CURRENT_TS} ORDER BY timestamp;"
```

After the daily file is written, check if rollups are needed:
- If 7+ daily files exist for a completed ISO week → create `~/.agentbridge/memory/weekly/weekly_YYYY-WXX.md`
- If 4+ weekly files exist for a completed quarter → create `~/.agentbridge/memory/quarterly/quarterly_YYYY-QN.md`
- Read source files, summarize, write target file
- Do NOT delete source files

Respond with: daily written (yes/no), rollups created.
