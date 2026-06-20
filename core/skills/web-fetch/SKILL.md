---
name: web-fetch
description: Fetch web content — 4-level escalation chain from curl to full browser
user-invocable: false
tags: [browse, fetch, web, research, jina]
---

# web-fetch

Four levels of web content retrieval. Use the lightest level that works. Escalate up only when the current level fails.

## Level 1 — curl (fastest, no rendering)

```bash
curl -sL "URL" --max-time 10 | head -200
```

Use when: open site, simple HTML, just need raw text.

## Level 2 — Jina Reader (CF bypass, clean markdown)

```bash
curl -sL "https://r.jina.ai/URL" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  --max-time 15
```

Use when:
- Direct curl returns CF challenge page or HTML soup
- Want clean markdown output instead of raw HTML
- Site has basic Cloudflare protection

Limitations: no JS execution, rate-limited (don't loop >5 URLs rapidly), some aggressive CF still blocks it.

## Level 3 — lightpanda (JS rendering, fast)

```bash
lightpanda fetch --dump markdown --strip-mode full --wait-ms 5000 "URL"
```

Use when:
- Levels 1-2 returned empty/broken content
- Page requires JavaScript to render (SPA, React, dynamic content)
- Still a single page, no interaction needed

10x faster than Chrome. Handles most JS-rendered pages. No login/interaction.

## Level 4 — Browsie (full Chrome session, interaction)

```bash
# Via tool call:
web_browse(task="description of what to do", chat_id="CHAT_ID")
```

Spawns a dedicated Chrome session (patchright). Use when ANY of:
- Levels 1-3 all failed or returned garbage
- Need to authenticate / log in
- Need to interact (click buttons, fill forms, scroll to load)
- Multi-page navigation (follow links, paginate)
- Research task requiring correlating multiple pages
- Need screenshots or visual verification

Handoff: describe the goal + starting URL(s) + what to extract.

## Decision summary

| Need | Level |
|------|-------|
| Single URL, open site | 1 (curl) |
| Single URL, CF-protected | 2 (Jina) |
| Single URL, JS-rendered | 3 (lightpanda) |
| Login, forms, multi-page, interaction | 4 (Browsie) |
| Previous level failed | Try next level up |
