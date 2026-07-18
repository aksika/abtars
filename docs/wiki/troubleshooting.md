# Troubleshooting

Having trouble installing or running abTARS? Start with `abtars doctor --fix` — it automatically diagnoses and repairs the most common issues.

## Quick checks

```bash
abtars doctor --fix   # auto-repair common issues
abtars status         # bridge running?
abtars logs           # last log lines
```

---

## Node.js problems

### Wrong Node version

abTARS requires Node.js **22 or later** (24 recommended).

```bash
node --version   # must be v22.x.x or higher
```

**macOS — upgrade via Homebrew:**
```bash
brew install node@24
brew link node@24 --force
node --version
```

**Linux / WSL — upgrade via NodeSource:**
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

**Using nvm:**
```bash
nvm install 24
nvm use 24
nvm alias default 24   # make it the default for new shells
node --version
```

After upgrading Node, reinstall the CLI tools:
```bash
npm install -g abtars@alpha abmind@alpha
```

### `npm install -g` fails with EACCES (permission denied)

npm is trying to write to a system directory. Fix by pointing npm globals to your home directory:

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
npm install -g abtars@alpha abmind@alpha
```

On macOS with zsh, use `~/.zshrc` instead of `~/.bashrc`.

### `abtars: command not found` after install

The npm global bin directory is not on PATH. Most common causes:

**Standard npm globals (`~/.local/bin`):**
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**Custom npm prefix (`~/.npm-global`):**
```bash
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**nvm — bin not in PATH for new shells:**
```bash
# Find where nvm puts the active node's bin
echo "$(nvm which current | xargs dirname)"
# Add it to ~/.bashrc or ~/.zshrc:
echo 'export PATH="$HOME/.nvm/versions/node/$(node -v | tr -d v)/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

Verify after fix:
```bash
which abtars
abtars --version
```

### `abtars` resolves to a stale version after update

After `abtars update`, the CLI wrapper is refreshed at `~/.local/bin/abtars`. But a previous `npm install -g abtars` may still be on your PATH and shadow the updated wrapper.

Check where the shell resolves abtars:
```bash
which abtars
```

If it shows `~/.npm-global/bin/abtars` or any path outside `~/.local/bin/` and `~/.abtars/`, remove the stale global install:
```bash
npm uninstall -g abtars && hash -r && which abtars
```

Should now resolve to `~/.local/bin/abtars` — the wrapper script that always points at the current release.

### `abtars: Permission denied`

The npm symlink lost its execute bit:
```bash
chmod +x $(readlink -f $(which abtars))
```

If that doesn't help, the symlink itself may be broken. Reinstall:
```bash
npm uninstall -g abtars && npm install -g abtars@alpha
```

---

## Manual install (if `npm install -g` keeps failing)

If the npm global install is broken beyond repair, install manually from source:

```bash
# 1. Clone the source
git clone https://github.com/aksika/abtars.git ~/.abtars-releases/src/abtars
git clone https://github.com/aksika/abmind.git ~/.abmind/src/abmind

# 2. Build abmind first (abtars links it)
cd ~/.abmind/src/abmind
npm install && npm run build

# 3. Build abtars
cd ~/.abtars-releases/src/abtars
npm install && node esbuild.config.js

# 4. Run the install directly via node
node ~/.abtars-releases/src/abtars/bundle/abtars-cli.js install
```

For subsequent updates from source:
```bash
cd ~/.abtars-releases/src/abtars && git pull && node esbuild.config.js
node ~/.abtars-releases/src/abtars/bundle/abtars-cli.js update --from-local
```

---

## Install fails mid-way

### `abtars install` errors out partway through

Re-run with `--force` to overwrite partial state:
```bash
abtars install --force
```

### `abtars update` fails with "no release staged"

The deploy symlink is broken. Run the emergency script — it rebuilds and restages without needing a working binary:
```bash
bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh
```

If the source checkout is stale, update it first:
```bash
cd ~/.abtars-releases/src/abtars && git pull origin dev
bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh
```

The watchdog health probe runs for ~120s after the script. If the bridge is still not healthy, check `~/.abtars/logs/bridge.log`.

### `abtars update` hangs or stalls

The npm global bin may be pointing at a stale symlink after a Node upgrade:
```bash
npm uninstall -g abtars && npm install -g abtars@alpha
```

---

## Bridge won't start

### EADDRINUSE — port already in use

A previous process is still holding the port:
```bash
abtars stop --force
abtars start
```

### Memory not working

abmind is not installed:
```bash
npm install -g abmind@alpha && abmind install && abtars restart
```

---

## macOS launchd (daemon mode)

The watchdog runs as `~/Library/LaunchAgents/com.abtars.watchdog.plist`.

```bash
# Check if loaded
launchctl list | grep abtars

# Check status
launchctl print gui/$(id -u)/com.abtars.watchdog

# View logs
tail -f ~/.abtars/logs/launchd.log
```

**Manually load (if install didn't):**
```bash
cp ~/.abtars-releases/src/abtars/scripts/com.abtars.watchdog.plist ~/Library/LaunchAgents/
sed -i '' "s|{{HOME}}|$HOME|g" ~/Library/LaunchAgents/com.abtars.watchdog.plist
launchctl load ~/Library/LaunchAgents/com.abtars.watchdog.plist
```

**Force restart:**
```bash
launchctl unload ~/Library/LaunchAgents/com.abtars.watchdog.plist
launchctl load ~/Library/LaunchAgents/com.abtars.watchdog.plist
```

**Common issues:**
- "service not found" — plist not in `~/Library/LaunchAgents/` or not loaded
- Bridge starts then dies — check `~/.abtars/logs/launchd.log`
- "Operation not permitted" — macOS Full Disk Access blocking node. Allow in System Settings → Privacy & Security → Full Disk Access

---

## Linux / WSL systemd (daemon mode)

The watchdog runs as a user systemd service (`abtars-watchdog.service`).

```bash
# Check status
systemctl --user status abtars-watchdog

# View logs
journalctl --user -u abtars-watchdog -f
```

**Manually enable (if install didn't):**
```bash
cp ~/.abtars-releases/src/abtars/scripts/abtars-watchdog.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now abtars-watchdog
```

**Reload after update (if service file changed):**
```bash
cp ~/.abtars-releases/src/abtars/scripts/abtars-watchdog.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart abtars-watchdog
```

**Common issues:**
- Exit code 203/EXEC — service file points to a missing script. Reload it (see above).
- "Failed to connect to bus" — systemd not running in WSL. Add to `/etc/wsl.conf`:
  ```ini
  [boot]
  systemd=true
  ```
  Then restart WSL from PowerShell: `wsl --shutdown`
- Service starts but bridge crashes — check `abtars logs` or `journalctl --user -u abtars-watchdog`
