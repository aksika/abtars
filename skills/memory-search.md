---
name: memory-search
description: Search persistent memory for recalled facts, decisions, preferences, and past conversations
user-invocable: false
---

# Memory Search

Full documentation for `agentbridge-recall`. See TOOLS.md for quick reference.

```bash
agentbridge-recall --keywords "kw1,kw2" --chat-id 7773842843 [--original "szó"] [--time-start <ms>] [--time-end <ms>] [--max-classification 0-2]
```

## Keyword rules
- Use English content words, NOT meta-words ("recent", "last session")
- For vague queries ("what did we talk about?"): use `"summary,discussion,update,decision"` + `--time-start` 24-48h ago
- DB uses FTS5 — only actual content matches

## Classification in context
- `--max-classification 0`: group chats, A2A (UNCLASSIFIED only)
- `--max-classification 2`: direct messages (default, up to CONFIDENTIAL)
- SECRET (3) always excluded

## Expand source messages
```bash
agentbridge-expand --ids 451,452,453
```
Use when results have `source_ids` and you need original context or "when did I say that?"

## When to use
- User's message doesn't make sense in current context
- User asks to recall: "do you remember", "emlékszel", "what did we talk about"
- User references past topic/person/event not in current conversation

## When NOT to use
- Short confirmations ("yes", "ok", "do it")
- Current context already explains the message
- User giving clear new instructions
