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

## Level 4 — CloakBrowser (full browser, interaction)

Escalate to a managed Browsie session. Create a B-type kanban card with a detailed goal and report the card ID. Do NOT invoke a browser CLI from Main.

### Goal checklist

Include in the goal:
- Objective and expected outcome
- Starting URL(s) and any prior fetch results
- Required interactions (login, forms, clicks, navigation)
- Expected artifacts (screenshots, extracted text, page info)
- Success criteria and stopping condition

### Direct API

```
kanban_manage action=create type=B title="<short title>" goal="<detailed goal>"
```

### ACP

```bash
abtars kanban create --type B --title "short title" --goal "$(cat <<'GOAL'
detailed goal text
GOAL
)"
```

Or pass a goal file:

```bash
abtars kanban create --type B --title "short title" --goal-file /tmp/goal.txt
```

### Acknowledgement

When the card is queued, say: `"Browsie task #<id> queued — result will appear here when complete."` Do NOT proceed with inline browser commands.

### Emergency direct operation

If the user explicitly requests that Main use the browser directly (and ONLY if they do), see the browser skill Emergency Direct Mode section. A slow/queued card or suspected session trouble does not authorize fallback.

## Decision summary

| Need | Level |
|------|-------|
| Single URL, open site | 1 (curl) |
| Single URL, CF-protected | 2 (Jina) |
| Single URL, JS-rendered | 3 (lightpanda) |
| Full browser (login, forms, interaction) | 4 (B kanban card) |
| Previous level failed | Try next level up |
