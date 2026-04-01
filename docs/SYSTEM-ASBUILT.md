# AgentBridge — System As-Built

> Last updated: 2026-04-01

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Telegram    │────▶│              │────▶│  kiro-cli   │
│  Poller      │     │   Bridge     │     │  (ACP)      │
├─────────────┤     │  (Node.js)   │     │  Claude/     │
│  Discord     │────▶│              │     │  minimax-m2.5│
│  Poller      │     │              │     └─────────────┘
└─────────────┘     │              │
                    │  Heartbeat   │     ┌─────────────┐
                    │  (5min)      │────▶│  Ollama      │
                    │              │     │  (embeddings)│
                    └──────────────┘     └─────────────┘
```

## Runtime Paths (Mac Mini — akos@molty)

| Path | Purpose |
|------|---------|
| `~/.agentbridge/` | Self-contained runtime (dist, node_modules, config, memory) |
| `~/.agentbridge/.env` | All configuration |
| `~/.agentbridge/core/` | SOUL.md, user_profile.md, agent_notes.md |
| `~/.agentbridge/skills/` | Skill files (hot-reloaded via heartbeat) |
| `~/.agentbridge/memory/memory.db` | SQLite memory database |
| `~/.agentbridge/logs/` | bridge-YYYY-MM-DD.log, launchd.log, restart.log |
| `~/.agentbridge/scripts/` | doctor.sh, daily-backup.sh, upgrade-deps.sh |
| `~/agentbridge/` | Git source (aksika/agentbridge) |

## LaunchAgent

- Plist: `~/Library/LaunchAgents/com.agentbridge.molty.plist`
- Command: `~/.agentbridge/agentbridge.sh --all --web --agent`
- KeepAlive: true (auto-restart on crash)
- ThrottleInterval: 15s (boot race condition mitigation)
- OpenClaw: disabled (plist renamed to .disabled)

## Power Schedule

- Sleep: 2:00 AM daily (`pmset`)
- Wake: 8:00 AM daily (`pmset`)

## Models

| Role | Model |
|------|-------|
| Main agent | minimax-m2.5 (via kiro-cli free tier) |
| Browse agent | minimax-m2.5 |
| Sleep/Dreamy | deepseek-3.2 |
| Coding agent | qwen3-coder-next |
| STT | groq/whisper-large-v3 |
| TTS | Edge TTS (hu-HU-TamasNeural / en-US-AndrewMultilingualNeural) |
| Embeddings | nomic-embed-text (Ollama, localhost) |

## Heartbeat Tasks (5min interval)

| Task | Purpose |
|------|---------|
| cron | Fire due cron entries |
| sleep-trigger | Check sleep schedule |
| browse-checker | Monitor browse tasks |
| skill-reloader | Hot-reload new/changed skill files |
| reminder-injector | Inject pending reminders |
| db-integrity | Hourly PRAGMA integrity_check |
| watchdog | Detect stuck prompts (L0→L1→L2) |
| restart-check | Check .restart-requested flag file |
| self-healer | Scan logs for errors, report to agent |

## Cron Entries

| Schedule | Task | Executor |
|----------|------|----------|
| 1:45 AM daily | daily-backup.sh | script |
| 1:50 AM Sunday | upgrade-deps.sh | script |
| 7:00 PM daily | doctor.sh --fix | script |
| 9:30 AM daily | agentbridge-tweet --feed --dis | script |
| 10:00 AM daily | Daily AI report | agent |
| 12:15 PM Sunday | Weekly AI report | agent |
| 1:00 PM Mon-Fri | Finance AI daily | agent |

## Resilience Layers

```
Layer 0: doctor.sh --fix (stale locks, orphan processes, permissions)
Layer 1: ACP session reset (cancel + respawn kiro-cli session)
Layer 2: Bridge restart (process.exit → launchd restarts)
Cooldown: 1hr between L1+L2 sequences
```

### Watchdog triggers (only when prompt in-flight):
- Stuck 1 HB cycle → doctor --fix
- Stuck N cycles (WATCHDOG_CYCLES, default 2) → Level 1 reset
- Still stuck next tick → Level 2 restart

### Other recovery:
- ACP auto-reinit on unexpected kiro-cli exit (5s delay)
- Auto-reset on ctx overflow (`ValidationException`/`-32603` after retries) — immediate, no watchdog wait
- Service registry retry on boot (3x, 5s delay)
- Telegram poller exponential backoff on errors
- Auto-compact at 85% context window
- Self-healer blacklist filter (skip transient errors, own logs, network noise)

## Error Handling

| Error | Handler |
|-------|---------|
| `-32603 + ValidationException` | Pipeline auto-resets session immediately |
| `-32603` transient | `promptWithRetry` 2x with 2s delay |
| `fetch failed` (boot) | Service registry retries 3x, 5s delay |
| Poller network error | Exponential backoff with jitter |
| `REACTION_INVALID` | Fallback: send emoji as message |
| Stuck prompt (>10min) | Watchdog L0→L1→L2 |
| kiro-cli crash | Auto-reinitialize in 5s |

## Restart Reason Tracking

Written to `.last-restart-reason` by:
- `compaction: ctx at X%`
- `watchdog-reset: prompt stuck Ns`
- `watchdog-restart: prompt stuck after reset`
- `user-reset`
- `user-restart`

Injected as `[SESSION START REASON]` on next session start.

## Streaming

ACP `agent_message_chunk` → buffer → Telegram `editMessageText` every 3s.
Shows `▍` cursor while generating. `STREAM_FLUSH_SEC` env configurable.

## TTS Language Switching

Agent prefixes voice replies with `[lang:hu]` or `[lang:en]`.
Bridge picks matching Edge TTS voice. Tag stripped from display.

## Backup

- Daily 1:45 AM: zip + encrypted DB (AES-256-CBC) → git push to aksikatwo/molty-agentbridge
- Encryption key: `~/.agentbridge/titok/db.key`
- Retention: 7 days local zips

## Key Commands

| Command | Effect |
|---------|--------|
| `/stop`, `/ctrlc` | Immediate cancel (bypasses pipeline) |
| `/restart` | Kill bridge, launchd restarts |
| `/reset` | New ACP session |
| `/new` | New session (keeps mode) |
| `/coding` | Switch to coding agent |
| `/default` | Switch back to main agent |
| `WAIT ...` | Cancel current prompt, process this message immediately |
| `agentbridge-restart "reason"` | Agent self-restart via flag file |

## Message Queue

When a message arrives while a prompt is in-flight:
- **Normal message**: queued (FIFO), processed after current completes. User sees: `⏳ Queued (N)`
- **Message starting with "WAIT"** (case-insensitive): cancels current prompt, processes immediately
- **`/stop`, `/ctrlc`, `/restart`**: bypass pipeline entirely, execute immediately
