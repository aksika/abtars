---
name: browser
description: Headless CloakBrowser — navigate, fill forms, extract text, screenshot
user-invocable: false
---

# Browser Tool

**CloakBrowser** — stealth Chromium with 58 C++ source-level patches. Passes Cloudflare Turnstile, bot detection, 0.9 reCAPTCHA score. No Docker, no patchright, no Chrome installation needed.

```bash
abtars-browser --action <ACTION> [--url <URL>] [--selector <SEL>] [--value <VAL>] [--session-id <ID>] [--full-page]
```

## Actions
- `navigate` — go to URL (requires `--url`). Returns title, final URL, status.
- `click` — click element (requires `--selector`)
- `fill` — fill form field (requires `--selector`, `--value`)
- `extract_text` — get visible text (optional `--selector` to scope, optional `--url` to navigate first). Truncates at 4000 chars.
- `screenshot` — capture page (optional `--full-page`, optional `--url` to navigate first)
- `get_page_info` — list interactive elements with selectors (max 50, optional `--url` to navigate first)
- `close_session` — close browser session

## Sessions
Same `--session-id` = same browser tab across calls. Auto-close after 5 min idle. Max 3 concurrent.

## Architecture
- **No Docker.** CloakBrowser runs directly on the host.
- **No patchright.** Uses Playwright-compatible `cloakbrowser` package with stealth Chromium binary (auto-downloaded on first run, ~200MB, cached at `~/.cloakbrowser/`).
- **Auto-updating.** Binary updates in background.
- **humanize=True** — human-like mouse curves, keyboard timing, scroll patterns for bypassing behavioral detection.

## When NOT to use
- Simple URL fetch → use `/ingest <url>` or `abtars-fetch`
- Public APIs → direct HTTP
- Static pages → ingestion pipeline
