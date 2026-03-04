---
name: memory-search
description: Search persistent memory for recalled facts, decisions, preferences, and past conversations
user-invocable: false
---

# Memory Search Skill

You have access to a persistent memory system via a shell command. Use it to recall past conversations, facts, decisions, and preferences.

## How to invoke

Run this command using your shell tool:

```bash
agentbridge-recall --keywords "keyword1,keyword2" --chat-id <CHAT_ID>
```

### Parameters

- `--keywords` (required): Comma-separated English search terms. Extract key concepts from the user's message.
  Example: `--keywords "project deadline,budget"`
- `--original` (optional): A single keyword in the user's original language for fallback search. Use when the user stresses a specific non-English term.
  Example: `--original "kiskutya"`
- `--time-start` (optional): Unix timestamp in milliseconds — start of time range.
- `--time-end` (optional): Unix timestamp in milliseconds — end of time range.
- `--chat-id` (required): The Telegram chat ID. Use `7773842843` for the main chat.

### Output

JSON array of results, each with: `content`, `source_timestamp`, `date`, `tier`, `score`.

## When to use

- The user's message doesn't make sense in the current conversation context (e.g., a single word or phrase you don't recognize)
- The user explicitly asks to recall something: "do you remember", "emlékszel", "what did we talk about", "mondtam"
- The user references a past topic, person, or event not in the current conversation
- You need context from previous sessions

## When NOT to use

- **Never** on short confirmations: "yes", "ok", "do it", "approved", "go ahead" — these are continuations of the current conversation
- **Never** when the current conversation context already explains the message
- **Never** proactively on every message — only when recall is genuinely needed
- **Never** when the user is giving you a new instruction that's clear from context
