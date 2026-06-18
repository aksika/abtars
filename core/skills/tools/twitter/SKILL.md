---
name: twitter
description: Fetch Twitter/X content — single tweets (no auth) or feeds (cookies)
requires:
  files: [~/.abtars/workspace/twitterX]
---

# Twitter / X

## Quick mode (no auth — FXTwitter API)

Fetch individual tweets and user profiles without API keys.

### Endpoints

- **Tweet:** `GET https://api.fxtwitter.com/{screen_name}/status/{tweet_id}`
- **Tweet + translation:** `GET https://api.fxtwitter.com/{screen_name}/status/{tweet_id}/{lang_code}`
- **User profile:** `GET https://api.fxtwitter.com/{screen_name}` → name, bio, followers, verification

### Pipeline

1. Extract tweet ID from URL: `https://x.com/{user}/status/{id}`
2. Fetch: `curl -s "https://api.fxtwitter.com/{user}/status/{id}"` → JSON with text, author, likes, retweets, views, media, createdAt

### Error codes

200=OK, 401=private tweet, 404=deleted/not found, 500=backend error

## Full mode (requires cookies — rettiwt-api)

Authenticated access for feeds, timelines, search, replies.

### Commands

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

- **Follows:** `~/.abtars/workspace/twitterX/base.follows.json` + `agent.follows.json`
- **Cookies:** `~/.abtars/secret/x-cookies.json` (encrypted at rest, required for full mode)
- **Output:** `~/.abtars/workspace/twitterX/output/` (daily JSON reports)

### Accessing cookies (encrypted)

Before running full mode commands, decrypt cookies via get_secret tool:
```bash
TWITTER_COOKIES=$(get_secret x-cookies.json) node {baseDir}/scripts/abtars-tweet.js --feed
```

If cookies are missing or expired (exit code 2), tell the user — this requires manual browser export.

## Use cases

- User shares a tweet URL → quick mode (FXTwitter)
- "What's new in AI?" → full mode (--feed) or quick mode (web search + FXTwitter)
- "What did @karpathy say?" → full mode (--timeline) or quick mode (search + fetch)
- Daily AI newsletter → cron: `node ~/.abtars/skills/tools/twitter/scripts/abtars-tweet.js --feed`
