# Managing the Bridge

## Stop

| Install mode | Command |
|---|---|
| `supervised-daemon` (system systemd) | `sudo systemctl stop abtars` |
| `supervised` (user systemd) | `systemctl --user stop abtars-watchdog` |
| `simple` (direct, no service) | `abtars stop` |

For daemon modes, `systemctl stop` sends SIGTERM to the watchdog which kills the bridge and exits cleanly.

## Start

| Install mode | Command |
|---|---|
| `supervised-daemon` | `sudo systemctl start abtars` |
| `supervised` | `systemctl --user start abtars-watchdog` |
| `simple` | `abtars start` |

## Restart

| Install mode | Command |
|---|---|
| `supervised-daemon` | `sudo systemctl restart abtars` |
| `supervised` | `systemctl --user restart abtars-watchdog` |
| `simple` | `abtars restart --cold` |

For a warm restart (no process kill, in-process reload): send `/restart` in Telegram or run `abtars restart`.

## Status

```bash
abtars daemon status    # shows service state, PIDs, uptime
abtars status           # send /status to the bot (via Telegram)
```

## Uninstall

### 1. Stop the service

```bash
# supervised-daemon
sudo systemctl stop abtars
sudo systemctl disable abtars
sudo rm /etc/systemd/system/abtars.service
sudo systemctl daemon-reload

# supervised (user)
systemctl --user stop abtars-watchdog
systemctl --user disable abtars-watchdog
rm ~/.config/systemd/user/abtars-watchdog.service
systemctl --user daemon-reload
```

Or use the CLI:
```bash
sudo $(which abtars) daemon uninstall    # system scope
abtars daemon uninstall                  # user scope
```

### 2. Remove abtars

```bash
rm -rf ~/.abtars
rm -f ~/.local/bin/abtars ~/.local/bin/abtars-browser ~/.local/bin/abtars-restart
npm uninstall -g abtars
```

### 3. Remove abmind (optional)

```bash
rm -rf ~/.abmind
rm -f ~/.local/bin/abmind
npm uninstall -g abmind
```

### 4. Verify

```bash
which abtars    # should return nothing
which abmind    # should return nothing
ls ~/.abtars    # should not exist
ls ~/.abmind    # should not exist
```

## Logs

```bash
# Bridge log (today)
tail -f ~/.abtars/logs/bridge-$(date +%F).log

# Watchdog/systemd journal
journalctl -u abtars -f          # system scope
journalctl --user -u abtars-watchdog -f   # user scope
```
