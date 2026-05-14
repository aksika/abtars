---
name: twitterX
description: Fetch Twitter/X feeds, timelines, replies, and search. Use when user asks about tweets, X feed, social media monitoring, or follow discovery.
requires:
  files: [~/.abtars/workspace/twitterX]
---

# Twitter/X Feed Tool

Fetch and analyze Twitter/X content via rettiwt-api + FxTwitter.

## Commands

```bash
# Feed (all follows, ranked)
tsx {baseDir}/scripts/abtars-tweet.ts --feed

# Feed as markdown
tsx {baseDir}/scripts/abtars-tweet.ts --feed --format md

# Feed + discover new follows
tsx {baseDir}/scripts/abtars-tweet.ts --feed --discover

# Single tweet
tsx {baseDir}/scripts/abtars-tweet.ts --fetch <tweet-url>

# User timeline
tsx {baseDir}/scripts/abtars-tweet.ts --timeline <handle> --count 10

# Replies on a tweet
tsx {baseDir}/scripts/abtars-tweet.ts --replies <tweet-id>

# Search
tsx {baseDir}/scripts/abtars-tweet.ts --search "query"

# User profile
tsx {baseDir}/scripts/abtars-tweet.ts --user <handle>
```

## Config

- Follows files: `~/.abtars/workspace/twitterX/base.follows.json` and env `TWEET_FOLLOWS_FILE` (default: `agent.follows.json`)
- Cookies: `~/.abtars/secret/cookies/x-cookies.json` (required for authenticated endpoints)
- Output: `~/.abtars/reports/x/` (daily JSON reports)

## Cron usage

Scheduled via `/task add`:
```
executor: script
command: tsx ~/.abtars/skills/tools/twitterX/scripts/abtars-tweet.ts --feed
```
