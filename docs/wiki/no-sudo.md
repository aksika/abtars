# Do I Need sudo? No.

abtars and abmind install, update, and run entirely in user space. No root access required at any point.

## Install

```bash
# Install pnpm (package manager) — no sudo
curl -fsSL https://get.pnpm.io/install.sh | sh -

# Install abtars + abmind — no sudo
pnpm install -g abtars abmind
```

pnpm installs global packages to your home directory:
- Linux: `~/.local/share/pnpm/`
- macOS: `~/Library/pnpm/`

## Update

```bash
abtars update    # pulls, builds, deploys — no sudo
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
| pnpm + packages | `~/.local/share/pnpm/` | user |
| abtars releases | `~/.abtars-releases/` | user |
| abtars runtime | `~/.abtars/` | user |
| abmind data | `~/.abmind/` | user |
| Watchdog service | `~/Library/LaunchAgents/` or `~/.config/systemd/user/` | user |
| Source (optional) | `~/.abtars-releases/src/` | user |

Everything lives under `~/`. No system paths touched. No `/usr/local/`. No `/etc/`. No root.

## What about npm?

If you installed with npm and npm's prefix is `/usr/local/` (macOS default), you may have needed sudo for `npm install -g`. Switching to pnpm eliminates this — pnpm never uses system paths.

If you're stuck with npm: `npm config set prefix ~/.npm-global` moves the global dir to user space. Then no sudo needed for npm either.
