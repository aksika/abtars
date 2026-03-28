---
alwaysApply: true
---
# Tools

## Memory Recall

Search past conversations, facts, decisions, preferences.

```bash
agentbridge-recall --translated "kw1,kw2" --chat-id 7773842843 [--original "szó"] [--time-start <ms>] [--time-end <ms>]
```

- `--keywords`: English content words (NOT meta-words like "recent", "last session"). For vague queries use broad terms: `"summary,discussion,update,decision"`
- `--original "szó"`: optional fallback in user's language
- `--time-start`/`--time-end`: epoch ms. Use for recency queries (24-48h ago)
- `--max-classification`: 0 in group chats, 2 in DMs (default)

Returns JSON: `content`, `date`, `source`, `score`. Some results include `source_ids`.

### Expand source messages

```bash
agentbridge-expand --ids 451,452,453
```

Use when recall results have `source_ids` and you need original context.
