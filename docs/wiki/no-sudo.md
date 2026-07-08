# Do I Need sudo? No.

abtars and abmind install, update, and run entirely in user space. No root access required.

## Everything lives under ~/

| Component | Location |
|-----------|----------|
| Node + npm packages | `~/.nvm/versions/node/...` (nvm) or `~/.npm-global/` |
| abtars releases | `~/.abtars-releases/` |
| abtars runtime | `~/.abtars/` |
| abmind data | `~/.abmind/` |
| Watchdog service | `~/Library/LaunchAgents/` (macOS) or `~/.config/systemd/user/` (Linux) |
| Native deps | `~/.local/lib/node_modules/` |

No system paths. No `/usr/local/`. No `/etc/`. No root.

## One exception: systemd linger (Linux only)

For the bridge to survive reboot as a user systemd service, you may need to enable linger once:

```bash
sudo loginctl enable-linger $USER
```

One-time system admin action. After that: never sudo again.

## Optional system binaries may need a system installer

The optional **system binaries** (`ollama`, `bwrap`, `lightpanda`) are the reason
`abtars deps` splits its dependencies in two. Npm packages auto-install under `~/`
with no sudo. System binaries are installed by their own upstream installers, some of
which touch system paths (`apt install bubblewrap` needs root). That is exactly why
abtars does **not** auto-install them: `abtars deps install ollama` prints the upstream
command for you to run (and decide about sudo) rather than running it silently. Nothing
abtars itself installs requires root.

## If npm defaults to /usr/local/ (macOS)

macOS ships with npm pointing at `/usr/local/`, which requires sudo for `npm install -g`. Fix with one of:

**Option A — redirect npm globals to your home dir:**
```bash
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

**Option B — use nvm (recommended):**
nvm installs Node + npm under `~/.nvm/` — no sudo, multiple Node versions, no config needed.
See [Prerequisites](./prerequisites.md) for install instructions.
