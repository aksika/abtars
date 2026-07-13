# Pi Executor — Coding Delegation

abTARS can dispatch coding tasks to a supervised Pi RPC subprocess. Orc enqueues a goal, abTARS launches `pi --mode rpc` with the workspace and model you specify, and tracks the run through completion, failure, or input requests.

## Requirements

- Pi installed on the same machine (`pi` on PATH)
- `pi-executor.json` configured at `~/.abtars/config/pi-executor.json`
- `enabled: true` in that config

## Configuration

```json
{
  "enabled": true,
  "command": "/usr/local/bin/pi",
  "maxConcurrent": 1,
  "maxWallClockMs": 1800000,
  "projectTrust": "always",
  "workspaceAliases": {
    "work": { "path": "/home/me/projects/work" },
    "scripts": { "path": "/home/me/scripts" }
  },
  "defaultModel": {
    "provider": "openrouter",
    "model": "claude-sonnet-4.6",
    "thinking": "medium"
  }
}
```

### Options

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | false | Master enable |
| `command` | — | Pi executable path |
| `maxConcurrent` | 1 | Max simultaneous Pi processes |
| `maxWallClockMs` | 1800000 (30min) | Hard wall-clock limit |
| `projectTrust` | "never" | `"always"` or `"never"` — maps to Pi's `--approve`/`--no-approve` |
| `workspaceAliases` | — | Named workspace paths; only allowlisted aliases are usable |
| `defaultModel` | — | Default provider/model/thinking for Pi sessions |

## Commands

All Pi commands go through the slash command system:

```
/pi run --work scripts "refactor the deploy script to use rsync instead of scp"
/pi status 1
/pi list
/pi reply 1 <requestId> "use the npm package"
/pi steer 1 "check for edge cases with empty directories"
/pi cancel 1
/pi resume 1
```

### /pi run

Creates and enqueues a new Pi coding run. The goal must be a concrete, bounded task. Pi runs in a sandboxed process with the specified workspace.

### /pi status

Shows the current state of a run: `queued → starting → running ↔ awaiting_input → completed/failed/cancelled`.

### /pi reply

When Pi needs user input (confirmation, file selection, editor content), the run enters `awaiting_input` state. Use `/pi reply` to provide the value.

### /pi steer

Send a follow-up instruction to a running Pi session without waiting for input.

### /pi cancel

Gracefully abort (grace period → SIGKILL if unresponsive).

### /pi resume

Resume an interrupted or failed run. Creates a new execution generation.

## What you get

When a Pi run completes, abTARS captures:
- The Pi session transcript (owned by Pi, not copied into abTARS)
- Git before/after snapshot of changed files (HEAD + porcelain — no file contents)
- Session statistics (token usage, tool calls, duration)
- Any artifacts produced by the run

## Durability

Pi runs survive abTARS restarts:
- State is stored in SQLite (`pi_runs` + `pi_run_progress` tables)
- Active runs become `interrupted` on restart
- Resume creates a new generation — never replays the original goal automatically
- Only approved resume creates a new execution
