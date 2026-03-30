---
name: fxtwitter
description: Fetch tweet data via the free FXTwitter API combined with web search for discovery
user-invocable: false
---

# FXTwitter

Fetch Twitter/X content without API keys using the free FXTwitter API. No timeline/search endpoint — use web search for discovery, FXTwitter for structured data.

## Pipeline
1. `web_search("site:x.com from:OpenAI 2026")` → find tweet URLs
2. Extract tweet ID from URL pattern `https://x.com/{user}/status/{id}`
3. Fetch: `curl -s "https://api.fxtwitter.com/{user}/status/{id}"` → JSON with text, author, likes, retweets, views, media, createdAt
4. Compile results

## Endpoints
- **Tweet:** `GET https://api.fxtwitter.com/{screen_name}/status/{tweet_id}`
- **Tweet + translation:** `GET https://api.fxtwitter.com/{screen_name}/status/{tweet_id}/{lang_code}`
- **User profile:** `GET https://api.fxtwitter.com/{screen_name}` → name, bio, followers, verification

## Error codes
200=OK, 401=private tweet, 404=deleted/not found, 500=backend error

## When NOT to use
- Searching Twitter directly (no search endpoint)
- Getting full timelines (no timeline endpoint)
- Anything requiring auth or posting
