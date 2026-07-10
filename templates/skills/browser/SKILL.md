---
name: browser
description: Full browser capability — Mode A interactive session (abtars-browser) or Mode B async research task (abtars-browse)
user-invocable: false
tags: [browse, browser, web, research, interaction, cloak]
---

# Browser Skill

**CloakBrowser** — stealth Chromium with 58 C++ source-level patches. Passes Cloudflare Turnstile, bot detection, 0.9 reCAPTCHA score. No Docker, no patchright, no Chrome installation needed.

Two execution modes. Pick the right one before starting.

| | Mode A — Interactive session | Mode B — Background research |
|---|---|---|
| **Command** | `abtars-browser` | `abtars-browse` |
| **Execution** | Synchronous, stepwise | Fire-and-forget, async |
| **Use when** | Login flows, form fills, step-by-step interaction, visual verification | Multi-page research, data gathering, tasks that take >30s |
| **Result** | Immediate per-action output | Report delivered to chat when done |

---

## Mode A — Interactive session (`abtars-browser`)

```bash
abtars-browser --action <ACTION> [--url <URL>] [--selector <SEL>] [--value <VAL>] [--session-id <ID>] [--full-page]
```

### Actions
- `navigate` — go to URL (requires `--url`). Returns title, final URL, status.
- `click` — click element (requires `--selector`)
- `fill` — fill form field (requires `--selector`, `--value`)
- `extract_text` — get visible text (optional `--selector` to scope, optional `--url` to navigate first). Truncates at 4000 chars.
- `screenshot` — capture page (optional `--full-page`, optional `--url` to navigate first)
- `get_page_info` — list interactive elements with selectors (max 50, optional `--url` to navigate first)
- `close_session` — close browser session

### Sessions
Same `--session-id` = same browser tab across calls. Auto-close after 5 min idle. Max 3 concurrent.

---

## Mode B — Background research task (`abtars-browse`)

```bash
abtars-browse --task "description" --chat-id <CHAT_ID> [--thread-id <THREAD_ID>] [--timeout 300]
```

Returns immediately. Browser agent runs in background. Results delivered to chat when done.

### When report arrives
1. Read report from `~/.abtars/workspace/browse/browse_<taskId>_<date>.md`
2. Summarize and send to user
3. Keep in `~/.abtars/workspace/browse/` (research) or delete (quick checks)

### Handoff
Tell the user the task has been dispatched, then continue handling other messages.

---

## Architecture
- **No Docker.** CloakBrowser runs directly on the host.
- **No patchright.** Uses `cloakbrowser` package with stealth Chromium binary (auto-downloaded on first run, ~200MB, cached at `~/.cloakbrowser/`).
- **Auto-updating.** Binary updates in background.
- **humanize=True** — human-like mouse curves, keyboard timing, scroll patterns.

## When NOT to use
- Simple URL fetch → use `/ingest <url>` or `abtars-fetch` (web-fetch skill Level 1–3) first
- Public APIs → direct HTTP
- Static pages → ingestion pipeline
