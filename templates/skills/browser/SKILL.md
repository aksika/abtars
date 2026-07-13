---
name: browser
description: Full browser capability — managed Browsie session or emergency Main direct mode
user-invocable: false
tags: [browse, browser, web, research, interaction, cloak]
---

# Browser Skill

**CloakBrowser** — stealth Chromium with 58 C++ source-level patches. Passes Cloudflare Turnstile, bot detection, 0.9 reCAPTCHA score. No Docker, no patchright, no Chrome installation needed.

## Role routing

Read your current session type before choosing a path:

- **If you are Browsie (session type B / W):** continue to CloakBrowser actions below.
- **If the user explicitly requests direct Main browser operation in the current turn:** follow Emergency Direct Mode.
- **Otherwise (Main / any other session):** create a B-type kanban card with a detailed goal using `kanban_manage` (Direct API) or `abtars kanban create` (ACP), report the card ID, and stop. Do NOT run browser commands inline.

---

## Browsie — CloakBrowser actions

```bash
cloakbrowser --action <ACTION> [--url <URL>] [--selector <SEL>] [--value <VAL>] [--session-id <ID>] [--full-page]
```

### Actions
- `navigate` — go to URL (requires `--url`). Returns title, final URL, status.
- `click` — click element (requires `--selector`)
- `fill` — fill form field (requires `--selector`, `--value`)
- `extract_text` — get visible text (optional `--selector` to scope, optional `--url` to navigate first). Truncates at 4000 chars.
- `screenshot` — capture page (optional `--full-page`, optional `--url` to navigate first)
- `get_page_info` — list interactive elements with selectors (max 50, optional `--url` to navigate first)
- `close_session` — close browser session
- `set_cookie` — set a cookie (requires `--name`, `--value`, optional `--domain`)

### Sessions
Same `--session-id` = same browser tab across calls. Auto-close after 5 min idle. Max 3 concurrent.

---

## Emergency Direct Mode (Main only)

Use ONLY when the user explicitly states in the current turn that Main should operate the browser directly. The following are NOT sufficient: a slow/queued card, suspected session trouble, previous approval, a generic request to browse, or your own preference.

```bash
cloakbrowser --action <ACTION> [--url <URL>] [--...] --session-id main-emergency-$(date +%s)
```

### Rules
1. Acknowledge that managed tracking/attachment is being bypassed.
2. Use a unique session ID: `main-emergency-<unix-timestamp>`.
3. Perform only the requested bounded operation.
4. Close the session on success, failure, cancellation, and timeout (`close_session`).
5. Do NOT use legacy `abtars-browse` or `abtars-browser` — always use `cloakbrowser`.

---

## Architecture
- **No Docker.** CloakBrowser runs directly on the host.
- **No patchright.** Uses `cloakbrowser` package with stealth Chromium binary (auto-downloaded on first run, ~200MB, cached at `~/.cloakbrowser/`).
- **Auto-updating.** Binary updates in background.
- **humanize=True** — human-like mouse curves, keyboard timing, scroll patterns.

## When NOT to use
- Simple URL fetch → use web-fetch skill Level 1–3 first
- Public APIs → direct HTTP
- Static pages → ingestion pipeline
