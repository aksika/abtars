# Do I Need sudo? No.

abtars and abmind install, update, and run entirely in user space. No root access required at any point.

## Prerequisites

- **Node.js 22+** — install via [Homebrew](https://brew.sh) on macOS, [NodeSource](https://github.com/nodesource/distributions) on Linux/WSL, or [nvm](https://github.com/nvm-sh/nvm) (recommended)
- **npm** — comes with Node.js

## Install (3 steps)

```bash
npm install -g abtars abmind    # 1. CLI on PATH
abmind install                  # 2. memory system
abtars install                  # 3. bridge setup → starts running
```

`npm install -g` installs global packages to your user directory when using a user-owned prefix (nvm, or `npm config set prefix ~/.npm-global`).

## Update

```bash
abtars update --alpha    # pulls, builds, deploys — no sudo
```

## Run as a service (survives reboot)

### macOS — launchd

User-level plist. No sudo.

```bash
abtars install --daemon    # creates ~/Library/LaunchAgents/com.abtars.watchdog.plist
```

### Linux — systemd user service

```bash
abtars install --daemon    # creates ~/.config/systemd/user/abtars-watchdog.service
loginctl enable-linger $USER   # service survives reboot without sudo
```

`enable-linger` may require sudo on some distros. If it does, it's a one-time system admin action — not an abtars requirement. Ask your sysadmin or run:

```bash
sudo loginctl enable-linger $USER
```

After that: never sudo again.

## Why no sudo?

| Component | Location | Owner |
|-----------|----------|-------|
| Node + npm packages | `~/.nvm/versions/node/...` (nvm) or `~/.npm-global/` | user |
| abtars releases | `~/.abtars-releases/` | user |
| abtars runtime | `~/.abtars/` | user |
| abmind data | `~/.abmind/` | user |
| Watchdog service | `~/Library/LaunchAgents/` or `~/.config/systemd/user/` | user |
| Native deps (better-sqlite3, etc.) | `~/.local/lib/node_modules/` | user |
| Source (optional) | `~/.abtars-releases/src/` | user |

Everything lives under `~/`. No system paths touched. No `/usr/local/`. No `/etc/`. No root.

## If npm defaults to `/usr/local/`

On macOS, npm's default prefix is `/usr/local/`, which requires sudo for `npm install -g`. Fix:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
```

Add the export to your shell profile (`~/.zshrc` / `~/.bashrc`) for persistence.

**Recommended:** use [nvm](https://github.com/nvm-sh/nvm) instead. It installs Node + npm to `~/.nvm/` — no sudo needed, and you can have multiple Node versions side by side.
