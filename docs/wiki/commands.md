# Commands

All commands work on Telegram, Discord, and IRC unless noted otherwise.

## Session

| Command | Description |
|---------|-------------|
| `/reset` | Reload transport config + fresh session |
| `/reset default` | Restore factory transport.json + fresh session |
| `/compact` | Compact context window (summarize + fresh session) |
| `/stop`, `/ctrlc` | Stop current response (hard interrupt) |
| `/wait [msg]`, `/steer [msg]` | Inject message mid-run without interrupting |
| `/change` | Switch model/provider (shortcut for `/models change`) |
| `/restart` | Restart bridge process |

## Model & Provider

| Command | Description |
|---------|-------------|
| `/models` | Show current model, transport, agent status |
| `/models change` | Interactive 3-step picker (Telegram only) |
| `/models quick <model>` | Instant switch on same provider |
| `/models list [provider]` | List providers or models on a provider |
| `/models restore` | Undo last model/provider switch |
| `/models default` | Factory reset (transport.default.json) |
| `/models health reset` | Reset model health buckets |
| `/models emergency` | 🚨 Activate paid hailMary model |
| `/emergency` | Shortcut for `/models emergency` |

## Status & Diagnostics

| Command | Description |
|---------|-------------|
| `/status` | Bridge status, transport, uptime |
| `/doctor` | Deep probe all subsystems |
| `/doctor fix` | Run safe auto-repairs |
| `/doctor fix-full` | Full repair (+ FTS rebuild, WAL checkpoint) |
| `/heartbeat` | Heartbeat diagnostics (tasks, last tick) |
| `/mcp` | MCP server status |
| `/hooks` | List configured hooks |

## Memory

| Command | Description |
|---------|-------------|
| `/memory` | Memory storage statistics |
| `/facts` | Core knowledge (user profile + agent notes) |
| `/nlm` | Knowledge base (list/create/sources/query) |

## Tasks

| Command | Description |
|---------|-------------|
| `/tasks` | List scheduled tasks |
| `/tasks run <id>` | Manually fire a task |
| `/tasks log <id>` | Last 5 runs for a task |
| `/tasks pause <id>` | Pause a scheduled task |
| `/tasks resume <id>` | Resume a paused task |

## Skills & Mode

| Command | Description |
|---------|-------------|
| `/skills` | List loaded skills |
| `/skill` | Reload skills catalog |

## Sessions

| Command | Description |
|---------|-------------|
| `/session` | List all sessions |
| `/session new` | Create new Main session, switch to it |
| `/session new browse` | Create Browse session |
| `/session new code` | Create Code session (replaces `/coding`) |
| `/session new task` | Create Task session |
| `/session <#>` | Switch to session by number |
| `/session end [#]` | End session gracefully (messages kept in memory) |
| `/session kill <#>` | Kill session and wipe its messages |

Session ID format: `{timestamp}_{type}_{index}` (e.g. `1747563282_A_01`).
Types: **A**=Main, **B**=Browse, **C**=Code, **T**=Task.

- At least one Main session must be active per platform at all times
- All sessions cleared on bridge restart
- Master-only (non-master users cannot manage sessions)
- Max concurrent sessions: `MAX_SESSIONS` env (default: 10)

## Sleep

| Command | Description |
|---------|-------------|
| `/sleep` | Sleep status |
| `/sleep resume` | Retry failed sleep steps |
| `/sleep now` | Full fresh sleep cycle |
| `/wakeup` | Wake from hardware sleep |

## Telegram-only

| Command | Description |
|---------|-------------|
| `/full` | Raw output, TTS disabled |
| `/short` | Clean responses (default) |
| `/healing` | Toggle self-healer on/off |

## Platform-specific

| Command | Platform | Description |
|---------|----------|-------------|
| `/users` | All | List users, approve/revoke access |
| `/users approve <id>` | All | Approve a new user by platform ID |
| `/users revoke <id>` | All | Revoke user access |
| `/whoami` | All | Show your user identity and role |
| `/usage` | All | Token usage and estimated cost this session |
| `/openrouter` | All | OpenRouter account info |
| `/help` | All | Show all available commands |
