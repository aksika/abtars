# Installation

## Requirements

- Node.js 22+
- Optional: ollama (for vector embeddings — FTS5 + trigram work without it)

## Path 1: npm (recommended)

```bash
npm install -g abtars
abtars install --mode=supervised-daemon
abtars onboard
abtars start
```

## Path 2: From source

```bash
git clone git@github.com:aksika/abtars.git
cd abtars
npm install && npm run build
node dist/cli/abtars.js install --mode=supervised-daemon
abtars update --from-local
abtars onboard
abtars start
```

## What each step does

| Step | What happens |
|------|-------------|
| `install` | Creates `~/.abtars/`, stages release, sets up watchdog |
| `onboard` | Interactive wizard: Telegram token, chat ID, model provider |
| `start` | Launches the bridge (watchdog supervises from here) |

## Install modes

| Mode | Watchdog | Auto-start on boot |
|------|----------|--------------------|
| `simple` | No | No |
| `supervised` | Yes | macOS: yes (launchd), Linux: no |
| `supervised-daemon` | Yes | Yes (systemd + launchd) |

## Add memory (optional)

```bash
npm install -g abmind
abmind install
abtars restart
```

Memory features (recall, store, sleep cycles, credential vault) activate on next restart. The bridge works without abmind — it just won't have persistent memory.

## Post-install verification

```bash
abtars status    # should show "running"
abtars doctor    # should show all green
abtars logs      # tail the live log
abtars config    # verify your .env (secrets redacted)
```

## What gets created

```
~/.abtars/
├── config/          # .env, transport.json, models.json
├── current/         # symlink → active release
├── releases/        # versioned bundles
├── logs/            # bridge-YYYY-MM-DD.log
├── scripts/         # watchdog.sh, doctor.sh
├── skills/          # core/ + self/
├── workspace/       # agent working directory
└── bridge.pid       # PID of running bridge
```

## Providers

| Provider | Transport | Setup |
|----------|-----------|-------|
| ollama | API | `ollama serve` locally, free |
| OpenRouter | API | API key in `secret/` |
| Kiro CLI | CLI (ACP) | `kiro-cli` installed |
| Gemini CLI | CLI (ACP) | `gemini` installed |

Configure in `~/.abtars/config/transport.json`. See [Model Management](models.md).

## Updating

**npm install:**
```bash
npm update -g abtars
abtars update
```

**From source:**
```bash
cd ~/abtars && git pull && npm install && npm run build
abtars update --from-local
```

Or from a running bridge: send `/restart` in chat.

## Platform-specific notes

### Linux (systemd)

The watchdog runs as a systemd user service. If it warns:
```bash
systemctl --user daemon-reload
systemctl --user restart abtars-watchdog
```

### macOS (launchd)

The watchdog runs via launchd. To stop/start:
```bash
abtars stop --force    # --force required (launchd would respawn otherwise)
abtars start
```

### WSL

Ensure systemd is enabled in `/etc/wsl.conf`:
```ini
[boot]
systemd=true
```

## Troubleshooting

### General

**`abtars: command not found`** — `~/.local/bin` not on PATH:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**EADDRINUSE on start** — stale process holding the port:
```bash
abtars stop --force
abtars start
```

**Memory not working** — install abmind:
```bash
npm install -g abmind && abmind install && abtars restart
```

Run `abtars doctor --fix` for automatic repair of common issues.

### macOS launchd

The watchdog runs as a LaunchAgent at `~/Library/LaunchAgents/com.abtars.watchdog.plist`.

**Check if loaded:**
```bash
launchctl list | grep abtars
```

**Check status:**
```bash
launchctl print gui/$(id -u)/com.abtars.watchdog
```

**View logs:**
```bash
tail -f ~/.abtars/logs/launchd.log
```

**Manually load (if install didn't):**
```bash
cp ~/.abtars/scripts/com.abtars.watchdog.plist ~/Library/LaunchAgents/
sed -i '' "s|{{HOME}}|$HOME|g" ~/Library/LaunchAgents/com.abtars.watchdog.plist
launchctl load ~/Library/LaunchAgents/com.abtars.watchdog.plist
```

**Unload (stop auto-start):**
```bash
launchctl unload ~/Library/LaunchAgents/com.abtars.watchdog.plist
```

**Force restart:**
```bash
launchctl unload ~/Library/LaunchAgents/com.abtars.watchdog.plist
launchctl load ~/Library/LaunchAgents/com.abtars.watchdog.plist
```

**Common issues:**
- "service not found" → plist not in `~/Library/LaunchAgents/` or not loaded
- Bridge starts but dies immediately → check `~/.abtars/logs/launchd.log` for errors
- "Operation not permitted" → macOS privacy settings blocking node. Allow in System Settings → Privacy & Security → Full Disk Access

### Linux systemd

The watchdog runs as a user service (`abtars-watchdog.service`).

**Check status:**
```bash
systemctl --user status abtars-watchdog
```

**View logs:**
```bash
journalctl --user -u abtars-watchdog -f
```

**Manually enable (if install didn't):**
```bash
cp ~/.abtars/scripts/abtars-watchdog.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now abtars-watchdog
```

**Common issues:**
- "Failed to connect to bus" → systemd not running in WSL. Add to `/etc/wsl.conf`:
  ```ini
  [boot]
  systemd=true
  ```
  Then restart WSL: `wsl --shutdown` from PowerShell.
- Service starts but bridge crashes → check `abtars logs` or `journalctl --user -u abtars-watchdog`
