---
name: twitter
description: Fetch tweets and monitor AI influencers via FXTwitter API + web search. No API keys needed for single tweets.
user-invocable: false
---

# Twitter / X

Fetch Twitter/X content without API keys using the free FXTwitter API. No timeline/search endpoint — use web search for discovery, FXTwitter for structured data.

## Follow list

AI influencers and researchers we track:
- **Base list:** `~/.abtars/twitterX/base.follows.json` — curated, manually maintained
- **Molty list:** `~/.abtars/twitterX/molty.follows.json` — from Molty's X following list

Read the follow list before searching to target the right accounts.

## Pipeline

1. Read follow list: `cat ~/.abtars/twitterX/base.follows.json`
2. Search for recent tweets: `web_search("site:x.com from:handle 2026")`
3. Extract tweet ID from URL: `https://x.com/{user}/status/{id}`
4. Fetch structured data: `curl -s "https://api.fxtwitter.com/{user}/status/{id}"` → JSON with text, author, likes, retweets, views, media, createdAt
5. Compile results

## Endpoints

- **Tweet:** `GET https://api.fxtwitter.com/{screen_name}/status/{tweet_id}`
- **Tweet + translation:** `GET https://api.fxtwitter.com/{screen_name}/status/{tweet_id}/{lang_code}`
- **User profile:** `GET https://api.fxtwitter.com/{screen_name}` → name, bio, followers, verification

## Error codes

200=OK, 401=private tweet, 404=deleted/not found, 500=backend error

## Use cases

- "What's new in AI today?" → read follow list, search recent tweets from top handles
- "What did @karpathy say about X?" → search + fetch specific tweets
- "Find interesting AI threads" → search follow list handles, rank by engagement
- User shares a tweet URL → fetch via FXTwitter for structured data

## Limitations

- No search endpoint (use web search instead)
- No timeline endpoint (search per handle)
- No auth required, no posting
- Rate limits are generous but undocumented

## Full integration plan

See `docs/specs/twitter-integration.plan.md` for the `abtars-tweet` CLI roadmap (rettiwt-api, daily newsletter, discovery).
