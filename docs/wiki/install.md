# Installation

See [Prerequisites](./prerequisites.md) before starting. New to abTARS? Start with
[Quick Start](./quickstart.md) for what you need and what to decide.

## Quick install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/aksika/abtars/main/scripts/install.sh | sh
```

No download step — the script runs straight from the pipe and installs the latest
dev commit by default. Variants: `| sh -s -- --stable`, `| sh -s -- --alpha`, or
`| sh -s -- --dev [DIR]` (build a local checkout as-is).

Omit `--non-interactive` and the wizard prompts for each value. When piped,
interactive setup reattaches to your terminal; without one, pass unattended flags:

```bash
curl -fsSL https://raw.githubusercontent.com/aksika/abtars/main/scripts/install.sh | \
  ABTARS_INSTALL_ARGS='--non-interactive --accept-risk --user-name "yourname" ...' sh
```

abmind stays separate — install it with its own one-liner when memory is needed.

### Manual alternative

```bash
npm install -g abtars@alpha
abtars deps install all
abtars install
```

`abtars install` creates config, clones source, builds, deploys the release, and
starts the bridge. The install ships a pi-stack default model (Muse Spark 1.3
Free via Zen) on all agents — no provider questions, no API key needed. Install
pi with `abtars deps install pi` and switch models anytime via `/model`.

## Install modes

| Mode | How it works | Who |
|------|-------------|-----|
| **daemon** (default) | launchd/systemd manages watchdog → auto-restart on crash | Production |
| **simple** | No daemon, user runs `abtars start/stop` manually | Testing, development |

Daemon mode starts automatically after `abtars install`. Simple mode requires
`abtars start`.

**Simple mode note:** if you use optional deps (`abtars deps install`), add to your
shell profile:

```bash
export NODE_PATH="$HOME/.local/lib/node_modules:$NODE_PATH"
```

Daemon mode sets this automatically. See [Dependencies](./dependencies.md) for the
full `abtars deps` reference.

## Verify

```bash
abtars doctor    # all green = healthy
abtars status    # shows PID, uptime, model
```

Send a message to your bot on Telegram — it should respond.

## Adding API keys later

Secrets live in `~/.abtars/secret/`, one file per key (encrypted at rest after first
boot). The filename becomes the environment variable name:

```bash
echo -n "sk-or-v1-abc123..." > ~/.abtars/secret/OPENROUTER_API_KEY
abtars stop && abtars start
```

See [Secrets Vault](./secrets.md) for the full details.

## Next steps

- [Health Check](./healthcheck.md) — verify everything is running correctly
- [Upgrading](./upgrade.md) — keep your bridge up to date
- [Backup & Restore](./backup.md) — protect your data
- [Deploy Pipeline](./deploy.md) — update/rollback reference and release layout
