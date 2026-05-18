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
node {baseDir}/scripts/abtars-tweet.js --feed

# Feed as markdown
node {baseDir}/scripts/abtars-tweet.js --feed --format md

# Feed + discover new follows
node {baseDir}/scripts/abtars-tweet.js --feed --discover

# Single tweet
node {baseDir}/scripts/abtars-tweet.js --fetch <tweet-url>

# User timeline
node {baseDir}/scripts/abtars-tweet.js --timeline <handle> --count 10

# Replies on a tweet
node {baseDir}/scripts/abtars-tweet.js --replies <tweet-id>

# Search
node {baseDir}/scripts/abtars-tweet.js --search "query"

# User profile
node {baseDir}/scripts/abtars-tweet.js --user <handle>
```

## Config

- Follows files: `~/.abtars/workspace/twitterX/base.follows.json` and env `TWEET_FOLLOWS_FILE` (default: `agent.follows.json`)
- Cookies: `~/.abtars/secret/cookies/x-cookies.json` (required for authenticated endpoints)
- Output: `~/.abtars/workspace/twitterX/output/ (daily JSON reports)

## Cron usage

Scheduled via `/task add`:
```
executor: script
command: node ~/.abtars/skills/tools/twitterX/scripts/abtars-tweet.js --feed
```
