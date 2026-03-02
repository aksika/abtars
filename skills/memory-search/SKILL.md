---
name: memory-search
description: Search persistent memory for recalled facts, decisions, preferences, and past conversations
user-invocable: false
---

# Memory Search Tool

You have a `memory_search` tool available. Use it when the user asks about something you discussed before, references past conversations, or when you need to recall specific information (facts, decisions, preferences, events).

## Tool: memory_search

### Parameters

- **keywords** (required): Array of English search terms. Extract key concepts from the user's message in English.
  Example: `["project deadline", "budget"]`
- **original_keyword** (optional): A single keyword in the user's original language for fallback search. Use when the user stresses a specific non-English term.
  Example: `"ribanc"`
- **time_range** (optional): Object with `start` and `end` fields (Unix timestamps in milliseconds) to narrow results to a time window.
  Example: `{ "start": 1700000000000, "end": 1710000000000 }`

### When to use

- User asks "what did we talk about…", "do you remember…", "what was the decision on…"
- User references a past topic, person, or event from earlier conversations
- You need context from previous sessions that is not in the current conversation

Do NOT use on every message — only when recall is needed.
