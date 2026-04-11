---
alwaysApply: true
---
# Tools

All `agentbridge-*` tools are in `~/.agentbridge/bin/`.

Run any tool with `--help` for full usage. See linked skill for behavioral rules.

## Essential (90% of usage)

```
agentbridge-recall --translated "kw1,kw2" --chat-id 7773842843 [--original "szó"] [--emotion "frustration"]
```

**CRITICAL:** `--translated` means "translated to English." ALWAYS translate the user's query to English keywords before calling recall. Never pass Hungarian or other non-English words as `--translated`. Use `--original` for the original-language keyword as a secondary search signal.

**Emotion filter:** `--emotion "frustration"` filters by tag. Groups: `--emotion "positive"` (joy,pride,excitement...), `--emotion "negative"` (frustration,anger,fear...), `--emotion "high-energy"` (excitement,anger,determination...).

```
agentbridge-store --translated "English" --original "eredeti" --memory-type <type> --emotion-score 0 --chat-id 7773842843 [--tags "term1,term2"] [--emotion-tags "pride,determination"] [--emotion-context "successful launch"]
```

**Emotion tags:** Override regex-detected tags with `--emotion-tags` when you sense nuance the regex misses. `--emotion-context` is a 3-5 word cause phrase ("deploy failures", "successful launch").

**CRITICAL for store:** `--translated` = English version of the memory. `--original` = the user's ACTUAL words in WHATEVER language they used. If the user spoke English, `--original` is English too. NEVER fabricate a translation — `--original` is verbatim what was said.

```
agentbridge-edit --memory-id <N> [--credibility N] [--classification N] [--translated "..."] [--relevance-score +N] [--caller kp]
agentbridge-expand --ids 451,452,453
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
| `agentbridge-autofix` | Manage self-healer auto-fix rules | `healthcheck` |
| `agentbridge-rss` | RSS/Atom feed fetcher | — |
