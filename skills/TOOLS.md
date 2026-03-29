---
alwaysApply: true
---
# Tools

Run any tool with `--help` for full usage. See linked skill for behavioral rules.

## Essential (90% of usage)

```
agentbridge-recall --translated "kw1,kw2" --chat-id 7773842843 [--original "szó"]
agentbridge-store --translated "English" --original "eredeti" --memory-type fact --emotion-score 0 --chat-id 7773842843 [--keyword "term"]
agentbridge-edit --memory-id <N> [--credibility N] [--classification N] [--translated "..."] [--relevance-score +N] [--caller kp]
agentbridge-expand --ids 451,452,453
```

## All tools

| Tool | Purpose | Skill |
|------|---------|-------|
| `agentbridge-recall` | Search memories | `memory-search` |
| `agentbridge-edit` | Modify existing memories | `instant-store` |
| `agentbridge-store` | Create new memories | `instant-store` |
| `agentbridge-expand` | Expand source message IDs | — |
| `agentbridge-todo` | Manage todo list | `todo` |
| `agentbridge-cron` | Schedule reminders/tasks | `cron` |
| `agentbridge-browse` | Delegate browser tasks | `browse-delegate` |
| `agentbridge-tweet` | X/Twitter feeds | `fxtwitter` |
| `agentbridge-rss` | RSS/Atom feed fetcher | — |
