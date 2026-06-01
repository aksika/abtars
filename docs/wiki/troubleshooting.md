# Install Troubleshooting Tips

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
