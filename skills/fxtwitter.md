---
name: fxtwitter
description: Fetch tweet data via the free FXTwitter API combined with web search for discovery
user-invocable: false
---

# FXTwitter Skill

Fetch Twitter/X content without API keys or browser scraping using the free FXTwitter API.

## Architecture

FXTwitter has no timeline endpoint — it only fetches individual tweets by ID and user profiles. To find recent tweets, combine web search for discovery with FXTwitter for structured data extraction.

**Pipeline: web search → extract tweet IDs → FXTwitter API → structured JSON**

## Endpoints

### Tweet fetch
```
GET https://api.fxtwitter.com/{screen_name}/status/{tweet_id}
```
Returns: text, author, likes, retweets, replies, views, media, polls, translations.

### Tweet fetch with translation
```
GET https://api.fxtwitter.com/{screen_name}/status/{tweet_id}/{lang_code}
```

### User profile
```
GET https://api.fxtwitter.com/{screen_name}
```
Returns: name, bio, followers, following, tweet count, avatar, banner, verification.

## How to use

### Step 1: Discover tweets via web search

Search for recent tweets from target accounts or topics:
```
web_search("site:x.com from:OpenAI 2026")
web_search("site:x.com AI news today")
web_search("site:x.com {username} {topic}")
```

### Step 2: Extract tweet IDs from URLs

Tweet URLs follow the pattern: `https://x.com/{user}/status/{id}`
Extract the numeric ID from each URL found in search results.

### Step 3: Fetch tweet data via FXTwitter

```bash
curl -s "https://api.fxtwitter.com/{user}/status/{id}" | python3 -m json.tool
```

Or use `web_fetch` on `https://api.fxtwitter.com/{user}/status/{id}`.

### Step 4: Compile results

Extract from each tweet response:
- `tweet.text` — content
- `tweet.author.name` / `tweet.author.screen_name` — who posted
- `tweet.likes`, `tweet.retweets`, `tweet.views` — engagement
- `tweet.media` — attached photos/videos
- `tweet.created_at` — timestamp

## When to use

- Daily AI news compilation (replaces unreliable browser scraping of X)
- Fetching specific tweet content when you have a URL or ID
- Getting user profile data (follower counts, bio, etc.)
- Any task that previously required Brownie to scrape X/Twitter

## When NOT to use

- Searching Twitter directly (no search endpoint — use web search instead)
- Getting a user's full timeline (no timeline endpoint)
- Anything requiring authentication or posting

## Rate limits

No strict rate limits, but don't abuse it. For bulk usage, self-host FixTweet on Cloudflare Workers (free, 100K req/day).

## Error codes

| Code | Message | Meaning |
|------|---------|---------|
| 200 | OK | Success |
| 401 | PRIVATE_TWEET | Tweet is from a private account |
| 404 | NOT_FOUND | Tweet deleted or doesn't exist |
| 500 | API_FAIL | FXTwitter backend error |

## Example: Daily AI news flow

```
1. web_search("site:x.com AI news {today's date}")
2. web_search("site:x.com from:OpenAI OR from:AnthropicAI OR from:GoogleAI {today's date}")
3. Extract tweet IDs from results
4. curl each: https://api.fxtwitter.com/{user}/status/{id}
5. Compile into daily brief
```
