# Stop & Uninstall

## Stop

### Using abtars command (recommended)

```bash
abtars stop --force
```

Kills watchdog first (prevents respawn), then bridge. Works on all install modes (simple, supervised, supervised-daemon).

### Manually

```bash
# 1. Disable daemon (prevents auto-restart)
# macOS:
launchctl bootout gui/$(id -u)/com.abtars.watchdog

# Linux:
systemctl --user stop abtars-watchdog
systemctl --user disable abtars-watchdog

# 2. Kill watchdog + bridge
pkill -f watchdog.sh
pkill -f "node.*abtars"
```

### Verify stopped

```bash
ps aux | grep -E "watchdog|node.*abtars" | grep -v grep
# Should return nothing
```

## Uninstall

### 1. Stop first

```bash
abtars stop --force
```

### 2. Remove runtime data

```bash
rm -rf ~/.abtars/
```

Config, logs, kanban, skills, state — all gone.

### 3. Remove releases + source

```bash
rm -rf ~/.abtars-releases/
```

Code, build artifacts, rollback slots, source repos — all gone.

### 4. Remove abmind (if installed)

```bash
rm -rf ~/.abmind/
```

Memory database, encryption key, core files — all gone. **Back up `~/.abmind/secret/abmind.key` first if you want to restore memories later.**

### 5. Remove global CLI

```bash
pnpm uninstall -g abtars abmind
```

### 6. Remove daemon config (if supervised-daemon mode)

```bash
# macOS:
rm ~/Library/LaunchAgents/com.abtars.watchdog.plist

# Linux:
rm ~/.config/systemd/user/abtars-watchdog.service
systemctl --user daemon-reload
```

### 7. Remove backups (optional)

```bash
rm -rf ~/.backup-abtars/
```

### After uninstall

Nothing remains. No system files touched. No root-owned artifacts. Clean machine.

To reinstall later:
```bash
pnpm install -g abtars abmind
abtars update
```
