# Pi Executor — Coding Delegation

abTARS can dispatch coding tasks to a supervised Pi RPC subprocess. Orc enqueues a goal, abTARS launches `pi --mode rpc` with the workspace and model you specify, and tracks the run through completion, failure, or input requests.

## Requirements

- Pi installed on the same machine (`pi` on PATH)
- `pi-executor.json` configured at `~/.abtars/config/pi-executor.json`
- `enabled: true` in that config

## Installation

`abtars deps install pi` installs Pi but does not enable coding delegation.
To authorize workspace execution you must configure the executor:

1. `pi-executor.json` is seeded automatically at
   `~/.abtars/config/pi-executor.json` with safe defaults (disabled).
2. Add one or more absolute workspace aliases.
3. Set `enabled` to `true`.
4. Restart abTARS.

## Configuration

The seeded file (`~/.abtars/config/pi-executor.json`) is created during normal
install/update if it does not already exist. Existing user files are never
overwritten.

```json
{
  "enabled": false,
  "command": "pi",
  "fixedArgs": [],
  "allowedEnv": [],
  "maxConcurrent": 1,
  "maxWallClockMs": 1800000,
  "abortGraceMs": 10000,
  "projectTrust": "never",
  "workspaceAliases": {},
  "sessionStorageRoot": "",
  "abmindPlugin": ""
}
```

### Minimal enablement

Change `"enabled"` to `true` and add at least one absolute workspace path:

```json
{
  "enabled": true,
  "command": "pi",
  "workspaceAliases": {
    "work": { "path": "/home/me/projects/work" },
    "scripts": { "path": "/home/me/scripts" }
  }
}
```

Model selection is automatic: Pi inherits the effective `coding` provider and
model from your existing `transport.json` configuration. You do not need to
duplicate model settings in `pi-executor.json`. An explicit per-run model
override via the `/pi run` command takes precedence.

### Options

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | false | Master enable |
| `command` | `"pi"` | Pi executable (bare name resolves from PATH, absolute paths used directly) |
| `maxConcurrent` | 1 | Max simultaneous Pi processes |
| `maxWallClockMs` | 1800000 (30min) | Hard wall-clock limit |
| `projectTrust` | `"never"` | `"always"` or `"never"` — maps to Pi's `--approve`/`--no-approve` |
| `workspaceAliases` | — | Named workspace paths; only allowlisted aliases are usable |
| `sessionStorageRoot` | `""` | Absolute path for durable Pi session files |

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

Creates and enqueues a new Pi coding run. The goal must be a concrete, bounded
task. Pi runs in a sandboxed process with the specified workspace. The model
is resolved automatically from your `transport.json` coding assignment unless
you supply an explicit `--model` / `--provider` override.

### /pi status

Shows the current state of a run: `queued → starting → running ↔ awaiting_input → completed/failed/cancelled`.

### /pi reply

When Pi needs user input (confirmation, file selection, editor content), the
run enters `awaiting_input` state. Use `/pi reply` to provide the value.

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
