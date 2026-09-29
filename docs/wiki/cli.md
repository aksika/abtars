# CLI Reference

The `abtars` command manages installation, updates, and lifecycle of the bridge.

## Usage

```
abtars install    [--force] [--mode=simple|daemon] [--restore <backup.zip>]
abtars uninstall  [--yes]
abtars update     [--dev [DIR] | --alpha | --stable]
abtars rollback   [--to <slot>]
abtars backup
abtars start
abtars stop
abtars restart    [--cold]
abtars status
abtars logs
abtars config
abtars doctor     [<args passed to doctor.sh>...]
abtars onboard    [--non-interactive --accept-risk --telegram-token ... --telegram-chat-id ...]
abtars daemon     install|uninstall|start|stop|restart
abtars deps       install|list|update|remove
```

## Commands

### install

First-time setup. Creates `~/.abtars/`, installs the bridge, sets up the watchdog.

- `--force` — overwrite existing installation
- `--mode` — `simple` or `daemon`
- `--restore <backup.zip>` — restore config/state from a backup archive

### uninstall

Removes the bridge installation. Stops running processes first.

- `--yes` — skip confirmation prompt

### update

Builds and deploys a new version from the selected channel.

- `--dev [DIR]` — deploy the dev channel, optionally from a local checkout
- `--alpha` — deploy the alpha channel
- `--stable` — deploy the stable channel

### rollback

Revert to a previous version.

- `--to <slot>` — choose a previous release slot (defaults to the latest previous release)

### backup

Creates a zip archive of config and state (`~/.abtars/config/`, secrets, task DB).

### start

Starts the bridge in simple mode or starts its watchdog service in daemon mode.

### stop

Stops the bridge and watchdog.

### restart

Restarts the bridge. Use `--cold` to start a fresh bridge process.

### status

Shows whether the bridge is running, current version, uptime, and watchdog state.

### doctor

Diagnoses common issues (stale locks, missing config, port conflicts, dependency health).

- `--fix` — attempt automatic repair of detected issues

### onboard

Interactive first-run wizard. Configures the install mode, security settings, and messaging platform credentials.

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
| `daemon install` | Install and start the system-scope service (requires sudo) |
| `daemon uninstall` | Remove the service |
| `daemon start` | Start the service |
| `daemon stop` | Stop the service |
| `daemon restart` | Restart the service |

Use `abtars status` to inspect bridge and service state.

### deps

Manage optional CLI npm package groups (native, twitter, pdf, youtube, image, pi), auto-managed browser runtimes (`lightpanda`, `cloak`), and manual system binaries (`ollama`, `bwrap`). Skill-script dependencies are lifecycle-managed separately; see [Dependencies](./dependencies.md#skill-script-dependencies).

| Subcommand | Description |
|------------|-------------|
| `deps list` | List every group + system binary + install status |
| `deps install [name\|all]` | Install a group (default: all) |
| `deps update [name\|all]` | Refresh an installed group |
| `deps remove <name>` | Uninstall a group |

### tui

Attach a terminal UI to a running bridge over a unix-domain socket.
The bridge must have been started with `TUI_ENABLED=true` (or `--tui`).

```bash
abtars deps install pi                 # install Pi, including its TUI library
abtars tui                              # attach to the active tui session (auto-creates Main if none)
abtars tui --session 2                  # switch to existing tui session #2
abtars tui --new C                      # create a new Code session and attach
abtars tui --orc                        # attach to the Orc session (query-only, busy-guard)
```

Detach with `Ctrl-C` or `Ctrl-D` — the bridge keeps running. A second
`abtars tui` evicts the first (the evicted client sees a clean detach,
not an error). The terminal client owns the PTY in raw mode; the
bridge is unchanged.
