# NotebookLM RAG Integration for OpenClaw (Molty)

Layer 6 of the memory architecture — cloud-backed RAG via Google NotebookLM, accessed through the `nlm` CLI wrapped in an OpenClaw extension.

## Architecture

```
Telegram → Molty (OpenClaw) → notebooklm extension → nlm CLI → NotebookLM API
                                    ↓ (on auth failure)
                              nlm login --provider openclaw → OpenClaw browser CDP :18800
```

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `nlm` CLI | `/Users/akos/.local/bin/nlm` | Installed via `pipx install notebooklm-mcp-cli` |
| Extension | `~/.openclaw/extensions/notebooklm/` | OpenClaw plugin wrapping nlm CLI |
| Refresh script | `~/.openclaw/scripts/nlm-refresh.sh` | Periodic cookie refresh (cron) |
| Cookie injector | `~/.openclaw/scripts/inject-nlm-cookies.py` | Reboot recovery — injects saved cookies into browser |
| Saved cookies | `~/.notebooklm-mcp-cli/profiles/default/cookies.json` | Last known good cookies |
| Chrome profile | `~/.notebooklm-mcp-cli/chrome-profiles/default/` | nlm's browser profile |

## Tools Provided

| Tool | Description |
|------|-------------|
| `nlm_query` | Query a notebook (RAG). Auto-retries with reauth on failure. |
| `nlm_notebooks` | List all notebooks |
| `nlm_sources` | List sources in a notebook |
| `nlm_source_add` | Add URL, text, or file source to a notebook |
| `nlm_notebook_create` | Create a new notebook |
| `nlm_reauth` | Manually refresh auth via OpenClaw browser CDP |

## Existing Notebooks

| Alias | ID | Sources |
|-------|-----|---------|
| `ai-memory` | `95b0935b-2a94-4c7a-9c2e-2e9c33965a94` | 11 (AI Memory System) |

## Config Changes

```json
{
  "browser": {
    "enabled": true,
    "extraArgs": ["--remote-allow-origins=*"]
  },
  "plugins": {
    "allow": ["ha", "telegram", "whatsapp", "memory-consolidate", "discord", "notebooklm"],
    "entries": {
      "notebooklm": { "enabled": true }
    }
  },
  "tools": {
    "allow": ["group:fs", "group:sessions", "group:memory", "group:web", "group:ui", "group:automation", "group:messaging", "group:nodes", "ha", "memory-consolidate", "notebooklm"]
  }
}
```

System cron (macOS `crontab`):
```
0 */6 * * * /Users/akos/.openclaw/scripts/nlm-refresh.sh
```

---

## Setup Procedure

### 1. Install nlm CLI

```bash
pipx install notebooklm-mcp-cli
# Installs to ~/.local/bin/nlm
```

### 2. Create the OpenClaw extension

Create `~/.openclaw/extensions/notebooklm/` with three files:

**`openclaw.plugin.json`**
```json
{
  "id": "notebooklm",
  "name": "NotebookLM",
  "version": "1.0.0",
  "description": "Query and manage Google NotebookLM notebooks — Layer 6 RAG knowledge base.",
  "main": "index.js",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "nlmPath": { "type": "string" },
      "profile": { "type": "string" }
    }
  }
}
```

**`package.json`**
```json
{
  "name": "@openclaw/notebooklm",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module",
  "openclaw": { "extensions": ["./index.js"] }
}
```

**`index.js`** — ES module that registers 6 tools. Key features:
- Wraps `nlm` CLI via `child_process.execSync` (bypasses `tools.deny: ["group:runtime"]` since it runs inside the plugin runtime, not as an agent tool)
- Auto-retries with `nlm login --provider openclaw --cdp-url http://127.0.0.1:18800` on auth failure
- `nlm_reauth` tool for manual refresh

### 3. Register the extension

```bash
openclaw config set plugins.allow '["ha", "telegram", "whatsapp", "memory-consolidate", "discord", "notebooklm"]'
openclaw config set plugins.entries.notebooklm.enabled true
openclaw config set tools.allow '["group:fs", "group:sessions", "group:memory", "group:web", "group:ui", "group:automation", "group:messaging", "group:nodes", "ha", "memory-consolidate", "notebooklm"]'
```

### 4. Enable browser with CDP access

```bash
openclaw config set browser.enabled true
openclaw config set browser.extraArgs '["--remote-allow-origins=*"]'
openclaw gateway restart
```

`--remote-allow-origins=*` allows external processes (nlm, scripts) to connect to Chrome's CDP WebSocket on port 18800.

### 5. Initial authentication (see next section)

### 6. Set up periodic refresh

```bash
(crontab -l 2>/dev/null | grep -v nlm-refresh; echo "0 */6 * * * /Users/akos/.openclaw/scripts/nlm-refresh.sh") | crontab -
```

### 7. Set notebook aliases

```bash
nlm alias set ai-memory 95b0935b-2a94-4c7a-9c2e-2e9c33965a94
```

---

## Authentication

### The Problem

NotebookLM has no official API. The `nlm` CLI uses Google session cookies extracted from a browser. These cookies expire periodically, and the OpenClaw browser starts with an empty Chrome profile (no Google login). On reboot, the browser profile resets.

### Current Approach: Cookie Injection (NotebookLM only)

The cookie injection pipeline works for NotebookLM but **does NOT cover Gmail, Drive, Calendar, or other Google services**. Those services require additional service-specific cookies that are only set during a real Google sign-in flow.

#### Scope of Cookie Auth

| Service | Cookie Auth Works? | Notes |
|---------|-------------------|-------|
| NotebookLM | ✅ Yes | Core Google cookies (SID, HSID, etc.) are sufficient |
| Gmail | ❌ No | Requires GMAIL_AT and other Gmail-specific cookies |
| Google Drive | ❌ Untested | Likely needs service-specific cookies |
| YouTube | ❌ Untested | Likely needs service-specific cookies |

#### Why: `nlm login --provider openclaw` extracts cookies from the NotebookLM page only. These include the core Google session cookies (SID, HSID, SSID, APISID, SAPISID, `__Secure-*PSID`) which authenticate the Google account, but each Google service sets additional cookies on first visit that are required for access.

### Planned: Automated Google Login (all services)

To get full Google access (Gmail, Drive, etc.), Molty needs to complete a real Google sign-in flow in the OpenClaw browser via CDP automation:

1. Navigate to `accounts.google.com`
2. Fill email → Next
3. Fill password → Next
4. Handle 2FA (TOTP) if enabled
5. Full session established — all Google services work

Credentials stored in macOS Keychain (`security add-generic-password`). This is **TODO** — not yet implemented.

### Cookie Injection Pipeline (current, NotebookLM)

#### Layer 1: Initial Cookie Seeding (one-time, manual)

1. User opens `https://notebooklm.google.com` in their local browser (already logged in)
2. Opens DevTools → Application tab → Cookies → `.google.com`
3. Exports ALL cookies (including HttpOnly: `SID`, `HSID`, `SSID`, `__Secure-1PSID`, etc.)
4. Saves to Molty via `nlm login --manual --file ~/cookies.txt`

**Critical**: `document.cookie` does NOT work — HttpOnly cookies are only visible in the Application tab.

Cookie string format: `NAME=VALUE; NAME=VALUE; ...` (semicolon-separated, one line).

#### Layer 2: Browser Cookie Injection (reboot recovery)

`inject-nlm-cookies.py` injects saved cookies into the OpenClaw browser via CDP:

1. Reads cookies from `~/.notebooklm-mcp-cli/profiles/default/cookies.json`
2. Connects to browser-level CDP (`/json/version` → `webSocketDebuggerUrl`)
3. Uses `Storage.setCookies` with `sameSite=None`, `secure=True` on all cookies
4. Finds a page tab and navigates to `https://notebooklm.google.com`

**Note**: The cookies.json is a list of CDP-format cookie objects (not a `{name: value}` dict). The script handles both formats.

#### Layer 3: CDP Provider Refresh (automated, periodic)

```bash
nlm login --provider openclaw --cdp-url http://127.0.0.1:18800
```

Extracts fresh cookies from the browser's NotebookLM page → saves to `cookies.json`.

### Refresh Pipeline

```
Every 6 hours (cron):
  nlm-refresh.sh
    ├── Check if CDP is reachable (browser running?)
    ├── Check if NotebookLM page exists in browser
    │   └── If not: inject-nlm-cookies.py (re-inject saved cookies)
    └── nlm login --provider openclaw --cdp-url http://127.0.0.1:18800
        └── Extracts fresh cookies → saves to cookies.json

On auth failure (runtime):
  Extension index.js catches auth error
    └── Runs nlm login --provider openclaw automatically
        └── Retries the original command

Manual:
  nlm_reauth tool via Telegram
```

### When Manual Re-seeding Is Needed

The automated pipeline breaks if:
- Google invalidates ALL session cookies (password change, security event)
- The saved `cookies.json` becomes too stale (all cookies expired)
- Both the browser session AND saved cookies are invalid simultaneously

Fix: export cookies from your local browser again and run `nlm login --manual --file`.

### Key Files

| File | Purpose |
|------|---------|
| `~/.notebooklm-mcp-cli/profiles/default/cookies.json` | Last known good cookies (29 CDP-format objects) |
| `~/.openclaw/scripts/nlm-refresh.sh` | Cron script: checks browser, injects if needed, refreshes |
| `~/.openclaw/scripts/inject-nlm-cookies.py` | CDP cookie injection (uses `Storage.setCookies` via browser endpoint) |
| `~/.openclaw/extensions/notebooklm/index.js` | Extension with auto-retry on auth failure |

### Port Map

| Port | Service |
|------|---------|
| 18789 | OpenClaw gateway |
| 18791 | Browser control server |
| 18800 | Chrome CDP (DevTools Protocol) |
