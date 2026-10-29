---
name: browser
description: Full browser capability — managed Browsie session or emergency Main direct mode
user-invocable: false
tags: [browse, browser, web, research, interaction, cloak]
---

# Browser Skill

**Cloak** — the action-capable CLI backed by CloakBrowser's stealth Chromium
runtime. It supports persistent sessions, navigation, snapshots, interaction,
text extraction, screenshots, cookies, and multi-step workflows.

## Role routing

Read your current session type before choosing a path:

- **If you are Browsie (session type B / W):** continue to Cloak actions below.
- **If the user explicitly requests direct Main browser operation in the current turn:** follow Emergency Direct Mode.
- **Otherwise (Main / any other session):** create a B-type kanban card with a detailed goal using `kanban_manage` (Direct API) or `abtars kanban create` (ACP), report the card ID, and stop. Do NOT run browser commands inline.

---

## Browsie — Cloak actions

The first command starts Cloak's local daemon automatically. Create one named
session per workflow and reuse it across calls:

```bash
cloak session new --name=browse --humanize
```

### Actions
- `goto` — navigate: `cloak goto @browse "https://example.com"`
- `snapshot` — inspect the current page and interactive element UIDs: `cloak snapshot @browse`
- `click` — click a snapshot UID or selector: `cloak click @browse "u7"`
- `fill` — fill a field: `cloak fill @browse "#email" "$EMAIL"`
- `text` — extract visible text, optionally scoped: `cloak text @browse --selector="main"`
- `screenshot` — capture a page: `cloak screenshot @browse --full-page --path="/tmp/page.png"`
- `cookies set` — load cookies: `cloak cookies set @browse --file "/path/to/cookies.json"`
- `session close` — close the browser session: `cloak session close @browse`

Use the snapshot UIDs returned by `snapshot` for reliable interaction. Do not
reuse a UID after navigation; take a fresh snapshot first.

---

## Emergency Direct Mode (Main only)

Use ONLY when the user explicitly states in the current turn that Main should operate the browser directly.

```bash
session="main-emergency-$(date +%s)"
cloak session new --name="$session" --humanize
cloak goto "@$session" "https://example.com"
cloak snapshot "@$session"
```

### Rules
1. Acknowledge that managed tracking/attachment is being bypassed.
2. Use a unique session name: `main-emergency-<unix-timestamp>`.
3. Perform only the requested bounded operation.
4. Close the session on success, failure, cancellation, and timeout (`cloak session close`).
5. Always use `cloak` directly — abtars does not ship a browser binary or wrapper.

---

## Architecture
- **External action CLI.** `cloak` is separately installed and found on PATH.
- **CloakBrowser runtime.** Cloak uses the separately installed `cloakbrowser` package and its stealth Chromium binary.
- **No abtars wrapper.** Abtars does not own browser processes, sessions, or IPC.

## When NOT to use
- Simple URL fetch → use web-fetch skill Level 1–3 first
- Public APIs → direct HTTP
- Static pages → ingestion pipeline
