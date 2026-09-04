---
name: read-messages
description: Read back raw conversation messages from the abmind messages table (session list + message dump)
user-invocable: false
---

# Read Messages

Full documentation for `abmind messages`. Read-only command — safe against a live gateway (WAL concurrent read), never writes.

## List sessions (find the right session_id first)

```bash
abmind messages
```

Output: `session_id  msgs  last` per session, newest activity first. Telegram sessions look like `telegram:<chatId>`.

## Dump recent messages of a session

```bash
abmind messages --session telegram:111 [--tail 50] [--json] [--raw]
```

- Default: last 30 messages, newest first, content truncated to 500 chars and secret-redacted
- `--tail N`: how many messages (e.g. 100)
- `--json`: machine-readable JSON (id, role, content, timestamp, time)
- `--raw`: skip secret redaction — only when the user explicitly needs verbatim content

## When to use
- User asks "do you remember what I said 5 minutes ago?" and recent context seems missing
- Suspected hydration/context failure — verify the messages actually reached the DB
- Recovery after a faulty session: read back what was said and continue manually
- Debugging: check whether a turn was recorded at all (message ids, timestamps)

## When NOT to use
- Memory search (facts/decisions) → use the `memory-search` skill (`abmind recall`)
- Reading memory contents → that is `abmind recall`, not the messages table