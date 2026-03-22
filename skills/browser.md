---
name: browser
description: Control a headless Chromium browser for navigation, form filling, text extraction, screenshots, and multi-step web workflows
user-invocable: false
---

# Browser Tool

Headless Chromium via shell. Use for auth flows, JS-rendered pages, form submissions, screenshots.

```bash
agentbridge-browser --action <ACTION> [--url <URL>] [--selector <SEL>] [--value <VAL>] [--session-id <ID>] [--full-page]
```

## Actions
- `navigate` — go to URL (requires `--url`). Returns title, final URL, status.
- `click` — click element (requires `--selector`)
- `fill` — fill form field (requires `--selector`, `--value`)
- `extract_text` — get visible text (optional `--selector` to scope). Truncates at 4000 chars.
- `screenshot` — capture page (optional `--full-page`)
- `get_page_info` — list interactive elements with selectors (max 50)
- `close_session` — close browser session

## Sessions
Same `--session-id` = same browser tab across calls. Auto-close after 5 min idle. Max 3 concurrent.

## Container
```bash
docker ps --filter name=agentbridge-browser --format "{{.Status}}"  # check
~/.agentbridge/browser-docker.sh                                     # start if needed
```

## When NOT to use
- Simple URL fetch → use `/ingest <url>`
- Public APIs → direct HTTP
- Static pages → ingestion pipeline
