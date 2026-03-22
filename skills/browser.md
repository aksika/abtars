---
name: browser
description: Control a headless Chromium browser for navigation, form filling, text extraction, screenshots, and multi-step web workflows
user-invocable: false
---

# Browser Tool Skill

You have access to a headless Chromium browser via a shell command. Use it for multi-step web interactions that require a real browser — authentication flows, form submissions, JavaScript-rendered pages, and reading authenticated content.

## How to invoke

Run this command using your shell tool:

```bash
agentbridge-browser --action <ACTION> [--url <URL>] [--selector <SELECTOR>] [--value <VALUE>] [--session-id <ID>] [--full-page]
```

### Actions

| Action | Required Params | Description |
|--------|----------------|-------------|
| `navigate` | `--url` | Navigate to a URL. Returns title, final URL, HTTP status. |
| `click` | `--selector` | Click an element. Detects if click triggers navigation. |
| `fill` | `--selector`, `--value` | Fill a form field. Password values are masked in logs. |
| `extract_text` | — | Extract visible text from the page. Optional `--selector` to scope. Truncates at 4000 chars. |
| `screenshot` | — | Take a screenshot. Optional `--full-page` for full page capture. |
| `get_page_info` | — | List interactive elements (links, buttons, inputs) with selectors. Max 50 elements. |
| `close_session` | — | Close the browser session and free resources. |

### Parameters

- `--action` (required): One of the 7 actions above.
- `--url` (required for navigate): The URL to navigate to.
- `--selector` (required for click/fill, optional for extract_text): CSS selector or `text=...` selector.
- `--value` (required for fill): The value to type into the field.
- `--session-id` (optional, default: "default"): Named session for persistence across calls. Same session ID = same browser tab.
- `--full-page` (optional flag): For screenshot, capture the entire scrollable page.

### Output

JSON object with `success` boolean. On failure, includes `error` string.

## When to use

- Complex authentication flows: navigate → fill credentials → click submit → extract authenticated content
- Multi-step form interactions requiring a persistent browser session
- Reading JavaScript-rendered pages where simple fetch returns empty content
- Taking screenshots of web pages for visual verification
- Discovering page structure with `get_page_info` before interacting

## When NOT to use

- Simple URL content retrieval — prefer `/ingest <url>` which uses a lightweight fetch-first strategy
- Public API calls — use direct HTTP requests instead
- Static pages with no JavaScript — the ingestion pipeline handles these efficiently
- When you only need search results — use web_search instead

## Example: Login and extract content

```bash
# 1. Navigate to login page
agentbridge-browser --action navigate --url "https://app.example.com/login" --session-id auth

# 2. Fill username
agentbridge-browser --action fill --selector "#email" --value "user@example.com" --session-id auth

# 3. Fill password
agentbridge-browser --action fill --selector "#password" --value "secret123" --session-id auth

# 4. Click sign in
agentbridge-browser --action click --selector "text=Sign In" --session-id auth

# 5. Extract the authenticated page content
agentbridge-browser --action extract_text --session-id auth

# 6. Clean up
agentbridge-browser --action close_session --session-id auth
```

## Domain restrictions

Navigation is restricted by the `BROWSER_ALLOWED_DOMAINS` environment variable. If configured, only URLs matching the allowed patterns can be visited. An empty allowlist means all domains are permitted.

## Session management

Sessions persist across calls with the same `--session-id`. The browser runs inside a Docker container for sandboxing.

### Ensuring the browser container is running

Before using the browser, check if the container is up. If not, start it:

```bash
# Check status
docker ps --filter name=agentbridge-browser --format "{{.Status}}"

# Start if not running (builds image on first run)
~/.agentbridge/browser-docker.sh
```

The container stays running across kiro restarts (`--restart unless-stopped`). You only need to start it once.

### How sessions work

When the container is running, sessions are shared via a Unix socket at `~/.agentbridge/browser.sock` — a browser tab opened in one call is still available in the next. If the container is not running and the main AgentBridge process is not running either, the CLI falls back to an ephemeral browser (sessions last only for that single call).

Sessions are automatically closed after 5 minutes of inactivity. Maximum 3 concurrent sessions (configurable via `BROWSER_MAX_SESSIONS`).
