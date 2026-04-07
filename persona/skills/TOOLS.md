---
alwaysApply: true
---
# Tools

All `agentbridge-*` tools are in `~/.agentbridge/bin/`.
✗ `/Users/akos/.local/bin/agentbridge-tweet`
✓ `agentbridge-tweet`

Run any tool with `--help` for full usage. See linked skill for behavioral rules.

## Essential (90% of usage)

```
agentbridge-recall --translated "kw1,kw2" --chat-id 7773842843 [--original "szó"]
agentbridge-store --translated "English" --original "eredeti" --memory-type <type> --emotion-score 0 --chat-id 7773842843 [--tags "term1,term2"] [--topic <topic>]
agentbridge-edit --memory-id <N> [--credibility N] [--classification N] [--translated "..."] [--relevance-score +N] [--caller kp]
agentbridge-expand --ids 451,452,453
agentbridge-skill --action create|edit|patch|delete|list --name "skill-name" --content "# Skill content..."
```

### memory-type values
| Type | When to use |
|------|-------------|
| `fact` | Objective info: names, configs, technical details |
| `decision` | Rules, choices, behavioral policies |
| `preference` | User likes/dislikes, settings |
| `event` | Things that happened, milestones |
| `lesson` | Mistakes learned, corrections received |
| `feedback` | User reactions to agent behavior (+/-) |
| `story` | Jokes, riddles, anecdotes, creative content |

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
| `agentbridge-skill` | Manage auto-created skills | — |
