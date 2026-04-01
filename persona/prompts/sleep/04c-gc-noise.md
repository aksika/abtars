# §4b Noise Marking

Scan short messages that are likely noise. These have been pre-filtered to messages under 20 characters.

```sql
sqlite3 ~/.agentbridge/memory/memory.db "SELECT id, content FROM messages WHERE role='user' AND length(content) < 20 ORDER BY id;"
```

Mark as garbage (add to `~/.agentbridge/memory/garbage.json`) messages with zero informational content:
- Single-word greetings: "hi", "hallo", "hello", "hey"
- Pings: "prof", "professor", "vagy prof?", "are you there?"
- Filler: "ja", "igen", "aha", "I see", "jaja"
- Single characters: "a", "?"
- Filler phrases: "Na nézzük"

Do NOT mark:
- Action confirmations: "Approved", "Done", "Yeah, do it"
- Instructions: "Check tmux ls"
- Questions with real content
- Topic starters

Always mark both the user message AND its paired assistant response:
```sql
SELECT id FROM messages WHERE id > <user_msg_id> AND role='assistant' ORDER BY id LIMIT 1;
```

Respond with count of messages marked as garbage.
