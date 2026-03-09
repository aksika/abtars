# Google Authentication for OpenClaw Browser

Procedure to establish a full Google session in the OpenClaw headless browser, covering all Google services (Gmail, NotebookLM, Drive, Calendar, etc.).

## Why It's Needed

The OpenClaw browser starts with an empty Chrome profile — no Google login. Google services require session cookies that are only set during login. Since there's no display for interactive login, we inject cookies extracted from a real browser session.

## Key Insight

Each Google service requires its own service-specific cookies in addition to the core Google session cookies. A single cookie export from one service won't cover all services.

| Cookie | Domain | Required For |
|--------|--------|-------------|
| SID, HSID, SSID, APISID, SAPISID | .google.com | All Google services (core session) |
| `__Secure-1PSID`, `__Secure-3PSID` | .google.com | All Google services |
| SIDCC, `__Secure-1PSIDCC` | .google.com | All Google services |
| OSID, `__Secure-OSID` | mail.google.com | Gmail only |
| OSID, `__Secure-OSID` | notebooklm.google.com | NotebookLM only |
| COMPASS | mail.google.com | Gmail only |
| `__Host-GMAIL_SCH*` | mail.google.com | Gmail only |
| NID, `__Secure-ENID` | .google.com | Google Search, general |

The injection script merges cookies from multiple sources to cover all services.

## Cookie Export Procedure

For each Google service you want Molty to access:

1. Open the service in Chrome (e.g. `mail.google.com`) — must be logged in
2. F12 → Network tab → reload page (F5)
3. Click the first request to the service domain (type "document")
4. Headers → Request Headers → copy the entire `cookie:` value

Or via Application tab:
1. F12 → Application → Cookies → select the service domain
2. Select all rows (Ctrl+A) → right-click → Copy all

**Important**: `document.cookie` in Console does NOT work — it misses HttpOnly cookies (SID, HSID, etc.) which are the critical auth cookies.

## Cookie Files on Molty

| File | Contents | Updated By |
|------|----------|-----------|
| `~/.notebooklm-mcp-cli/profiles/default/cookies.json` | NLM + core Google cookies (CDP format list) | `nlm login --provider openclaw` |
| `~/google-cookies-full.json` | All Google service cookies (CDP format list) | Browser export via `Storage.getCookies` |

## Injection Script

`~/.openclaw/scripts/inject-nlm-cookies.py` handles injection:

1. Loads NLM cookies from `~/.notebooklm-mcp-cli/profiles/default/cookies.json`
2. Merges with `~/google-cookies-full.json` if it exists (adds Gmail-specific cookies)
3. Sets `sameSite=None` and `secure=True` on all cookies
4. Connects to browser-level CDP endpoint (`/json/version` → `webSocketDebuggerUrl`)
5. Calls `Storage.clearCookies` then `Storage.setCookies`
6. Navigates a page tab to `https://notebooklm.google.com`

**Critical**: Must use `Storage.setCookies` via the browser-level CDP WebSocket (not page-level `Network.setCookies`). Page-level injection doesn't persist across tabs.

## Adding a New Google Service

To give Molty access to a new Google service (e.g. Google Drive):

1. Export cookies from that service in your local browser (see export procedure above)
2. Parse them into CDP format: `[{"name": "...", "value": "...", "domain": "...", "path": "/", "httpOnly": true, "secure": true}, ...]`
3. Add them to `~/google-cookies-full.json` on Molty
4. Run `python3 ~/.openclaw/scripts/inject-nlm-cookies.py`
5. The merge logic will combine them with existing cookies

## Refresh & Persistence

| Trigger | What Happens |
|---------|-------------|
| Every 6h (cron) | `nlm-refresh.sh` → checks browser, injects if needed, runs `nlm login --provider openclaw` |
| Auth failure (runtime) | Extension auto-retries with `nlm login --provider openclaw` |
| Manual | `nlm_reauth` tool via Telegram |
| Reboot | Browser starts fresh → cron job re-injects on next 6h cycle |

The `nlm login --provider openclaw` extracts cookies from the browser and saves them to the NLM profile. This keeps the NLM cookie file fresh. The `google-cookies-full.json` file is only updated when you manually export new service-specific cookies.

## When Cookies Expire

Core Google session cookies (SID, HSID) last ~1 year. Service-specific cookies (OSID, COMPASS) last days to weeks. The browser keeps the session alive by refreshing cookies on page load.

If everything breaks (all cookies expired, browser session gone):

1. Export fresh cookies from your local browser for each service
2. Save to `~/google-cookies-full.json` on Molty
3. Run `python3 ~/.openclaw/scripts/inject-nlm-cookies.py`
4. Run `nlm login --provider openclaw --cdp-url http://127.0.0.1:18800`

## CDP Reference

| Endpoint | Use |
|----------|-----|
| `http://127.0.0.1:18800/json/version` | Get browser-level WebSocket URL |
| `http://127.0.0.1:18800/json/list` | List open page targets |
| `Storage.setCookies` | Set cookies (browser-level) |
| `Storage.getCookies` | Read all cookies (browser-level) |
| `Storage.clearCookies` | Clear all cookies (browser-level) |
| `Network.setCookies` | Set cookies (page-level, doesn't persist across tabs) |
| `Page.navigate` | Navigate a tab |
