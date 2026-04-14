# #143 Browse Rewrite — Two-Level Browsing

**Date:** 2026-04-14
**Status:** Planned
**Priority:** MEDIUM
**Depends on:** #140 (done)

## Goal

Replace the monolithic browse architecture (raw kiro-cli spawn + Unix socket IPC) with two clean levels.

## Architecture

### Level 1: Lightpanda (fast, native, no spawn)

Main agent runs via skill + wrapper script:
```bash
agentbridge-fetch "<url>"
```

The wrapper (`scripts/agentbridge-fetch.sh`) handles:
- Checks `which lightpanda` — clear error if missing ("use Level 2 browse")
- Runs `lightpanda fetch --dump markdown --strip-mode full --http-connect-timeout 10000 --http-timeout 15000 --block-private-networks "<url>"`
- Truncates output to 50K chars (prevents context window blowout)
- Strips stderr (lightpanda logs)
- Returns clean markdown to stdout

Skill teaches WHEN to use it + escalation: "if output is empty or says 'enable JavaScript', escalate to Level 2 browse."

- No subagent, no spawn — stays in Professor's context
- Built-in SSRF guard (`--block-private-networks`)
- Use cases: docs, APIs, news, public pages, stock data, any page without JS/login

### Level 2: Patchright + Chrome (stealthy, session-based)

Browsie agent via `runtime.spawn("browsie", task)`:
- Dockerized Chrome with real fingerprint (patchright)
- Session persistence (cookies, auth state)
- Use cases: login flows, anti-bot sites, multi-page navigation, form filling, screenshots
- Result delivered via `onComplete` callback → `deliverBrowseResult()` → `appendReminder()` → cron-checker → Telegram
- Same delivery path as current browse, just triggered by callback instead of ACP log parsing

## What Changes

| Component | Current | New |
|---|---|---|
| Simple fetch | `agentbridge-browse` → raw kiro-cli spawn | `lightpanda fetch` via skill (no spawn) |
| Complex browse | `agentbridge-browse` → raw kiro-cli spawn | `runtime.spawn("browsie")` |
| IPC | Unix socket + wrapper script | Gone (runtime handles it) |
| browse-delivery | Parse ACP log files | Callback from `runtime.spawn()` |
| Docker | Lightpanda + Chrome containers | Chrome/patchright container only |
| SSRF | Custom ssrf-guard.ts | L1: `--block-private-networks`. L2: keep ssrf-guard |

## What Stays
- browser-manager.ts, browser-tool.ts, browser-ipc-server.ts (Level 2)
- domain-allowlist.ts, ssrf-guard.ts (Level 2)
- browse-delivery.ts (simplified for callback)

## What Goes
- Wrapper script generation in agentbridge-browse.ts
- Unix socket IPC in index.ts (browseServer)
- ACP log parsing in browse-delivery.ts (extractAgentText)
- `browser-lightpanda.sh` script
- Lightpanda engine option in browser-manager.ts
- Docker lightpanda container

## Lightpanda Setup

Binary at `~/.local/bin/lightpanda`. Key flags:
- `--dump markdown` — native markdown output
- `--http-connect-timeout 10000` — needed for WSL
- `--http-timeout 15000` — max transfer time
- `--wait-ms 15000` — wait for JS-heavy pages
- `--block-private-networks` — SSRF protection
- `--strip-mode full` — remove JS/CSS/images for cleaner output

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Create `scripts/agentbridge-fetch.sh` — wrapper (flags, truncation, missing binary check) | 15 min |
| 2 | `web-fetch.md` skill — teaches when to use fetch + escalation rules | 15 min |
| 3 | Update `browse-delegate.md` — Level 2 only, reference web-fetch for simple | 10 min |
| 4 | Rewrite `agentbridge-browse.ts` — use `runtime.spawn("browsie")` | 30 min |
| 5 | Remove Unix socket IPC from `index.ts` | 20 min |
| 6 | Simplify `browse-delivery.ts` — callback-based | 20 min |
| 7 | Remove `browser-lightpanda.sh`, update deploy.sh | 10 min |
| 8 | Update browser-manager.ts — patchright only (remove lightpanda engine) | 15 min |
| 9 | Tests | 20 min |
| **Total** | | **~2.5 hr** |

## Verification

```bash
# No more Unix socket
grep -rn "browse.sock\|browseServer\|browseSocket" src/ --include="*.ts" | grep -v test
# Should return: nothing

# No more wrapper script generation
grep -rn "wrapperScript\|wrapperFile\|wrapper.cjs" src/ --include="*.ts" | grep -v test
# Should return: nothing

# No more lightpanda engine in browser-manager
grep -rn "lightpanda" src/ --include="*.ts" | grep -v test
# Should return: nothing
```
