# CLI Reference

The `abtars` command manages installation, updates, and lifecycle of the bridge.

## Usage

```
abtars install    [--force] [--mode=simple|supervised|supervised-daemon] [--restore <backup.zip>]
abtars uninstall  [--yes]
abtars update     [--source local|npm|github] [--from-local]
abtars rollback   [--to <version>]
abtars backup
abtars start
abtars stop       [--force]
abtars restart
abtars status
abtars logs
abtars config
abtars doctor     [<args passed to doctor.sh>...]
abtars onboard    [--non-interactive --accept-risk --telegram-token ... --telegram-chat-id ...]
abtars daemon     install|uninstall|start|stop|restart|status
abtars deps       install|list|check
```

## Commands

### install

First-time setup. Creates `~/.abtars/`, installs the bridge, sets up the watchdog.

- `--force` — overwrite existing installation
- `--mode` — `simple` (no watchdog), `supervised` (watchdog, manual start), `supervised-daemon` (watchdog + auto-start on boot)
- `--restore <backup.zip>` — restore config/state from a backup archive

### uninstall

Removes the bridge installation. Stops running processes first.

- `--yes` — skip confirmation prompt

### update

Builds and deploys a new version. Stages alongside the running instance, then performs a quick restart (< 2s downtime).

- `--from-local` — build from the local repo (default for dev workflow)
- `--source` — choose source: `local`, `npm`, or `github`

### rollback

Revert to a previous version.

- `--to <version>` — specific version to roll back to (defaults to previous)

### backup

Creates a zip archive of config and state (`~/.abtars/config/`, secrets, task DB).

### start

Starts the bridge (and watchdog if in supervised mode).

### start

Starts the bridge (and watchdog if in supervised mode). If already running, prints "already running" and exits.

### stop

Stops the bridge and watchdog.

- `--force` — required on supervised-daemon installs (kills watchdog first to prevent respawn)

### restart

Stop + start in sequence.

### status

Shows whether the bridge is running, current version, uptime, and watchdog state.

### doctor

Diagnoses common issues (stale locks, missing config, port conflicts, dependency health).

- `--fix` — attempt automatic repair of detected issues

### onboard

Interactive first-run wizard. Sets up Telegram bot token, chat ID, and initial config.

- `--non-interactive` — skip prompts, use flags instead
- `--telegram-token` — bot token
- `--telegram-chat-id` — owner chat ID
- `--accept-risk` — acknowledge security implications

### logs

Tails the current day's bridge log (`~/.abtars/logs/bridge-YYYY-MM-DD.log`). Ctrl+C to exit.

### config

Shows the current `.env` configuration. Secret values (tokens, keys) are redacted.

### daemon

Manage the systemd/launchd service.

| Subcommand | Description |
|------------|-------------|
| `daemon install` | Install and start the system service (requires sudo) |
| `daemon uninstall` | Remove the service |
| `daemon start` | Start the service |
| `daemon stop` | Stop the service |
| `daemon restart` | Restart the service |
| `daemon status` | Show service state |

### deps

Manage optional runtime dependencies (jimp, pdf-parse, youtube-transcript).

| Subcommand | Description |
|------------|-------------|
| `deps list` | List optional deps and install status |
| `deps install` | Install all optional deps |
| `deps check` | Check which are missing |

### tui

Attach a terminal UI to a running bridge over a unix-domain socket (#1315).
The bridge must have been started with `TUI_ENABLED=true` (or `--tui`).

```bash
abtars deps install tui                # one-time: install the pi-tui client dep
abtars tui                              # attach to the active tui session (auto-creates Main if none)
abtars tui --session 2                  # switch to existing tui session #2
abtars tui --new C                      # create a new Code session and attach
abtars tui --orc                        # attach to the Orc session (query-only, busy-guard)
```

Detach with `Ctrl-C` or `Ctrl-D` — the bridge keeps running. A second
`abtars tui` evicts the first (the evicted client sees a clean detach,
not an error). The terminal client owns the PTY in raw mode; the
bridge is unchanged.
