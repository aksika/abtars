---
name: web-fetch
description: Fetch web page content as markdown using lightpanda (Level 1 browsing)
user-invocable: false
---

# Web Fetch (Level 1)

Fast, lightweight page fetching. Returns clean markdown. No browser session, no login.

```bash
agentbridge-fetch "<url>"
```

Returns markdown to stdout. Truncated at 50K chars.

## When to use
- Reading documentation, articles, news
- Checking public data (stock prices, weather, APIs)
- Any page that works without JavaScript or login

## When NOT to use — escalate to Level 2
- Output is empty or says "enable JavaScript"
- Page requires login or authentication
- Multi-page navigation needed (click through, fill forms)
- Anti-bot protection (Cloudflare, captcha)
- Screenshots needed

For Level 2: use `agentbridge-browse --task "description" --chat-id <CHAT_ID>`
