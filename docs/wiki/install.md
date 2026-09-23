# Installation

See [Prerequisites](./prerequisites.md) before starting.

## Quick install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/aksika/abtars/main/scripts/install.sh | sh
```

Same bootstrap as abmind, but for the bridge: no download step — the script runs
straight from the pipe, and installs the latest dev commit by default.
Variants: `| sh -s -- --stable`, `| sh -s -- --alpha`, or `| sh -s -- --dev [DIR]`
(build a local checkout as-is). When piped, interactive setup reattaches to your
terminal; without one, pass unattended flags via
`ABTARS_INSTALL_ARGS='--non-interactive --accept-risk ...'`.

abmind stays separate — install it with its own one-liner when memory is needed.

### Manual install (4 steps)

```bash
# 1. Install CLI tools
npm install -g abtars@alpha abmind@alpha

# 2. Optional deps (recommended before first start)
abtars deps install all

# 3. Install + deploy + start bridge
abtars install --non-interactive --accept-risk \
  --instance-name "MyBot" \
  --telegram-token "YOUR_BOT_TOKEN" \
  --telegram-chat-id "YOUR_CHAT_ID" \
  --user-name "yourname" \
  --passphrase "your-encryption-passphrase" \
  --default-provider openrouter \
  --default-model "deepseek/deepseek-v4-flash" \
  --api-key "sk-or-v1-..."

# 4. Install memory system (picks up username + agent name from abtars config)
abmind install --non-interactive \
  --passphrase "your-passphrase"
```

Step 3 automatically clones source, builds, deploys, and starts the bridge (daemon mode). The bot is live after this completes. Step 4 discovers username and agent name from the abtars config created in step 3 — no need to pass them again.

`abtars install` uses the alpha channel by default (`--stable` or `--dev`
select other channels). `--api-key` is required for cloud providers
(OpenRouter/OpenAI/Anthropic); local providers (ollama, kiro, gemini) don't
need one.

### What each step does

| Step | What happens |
|------|-------------|
| `npm install -g abtars@alpha abmind@alpha` | Installs CLI tools globally |
| `abtars deps install all` | Installs optional package groups plus the Lightpanda and Cloak browser runtimes |
| `abtars install` | Creates config, clones source, builds, deploys release, starts bridge |
| `abmind install` | Creates `~/.abmind/`, initializes memory DB, sets encryption (discovers user from abtars) |

### System dependencies (optional)

`abtars deps` manages optional npm package groups (`native`, `twitter`, `pdf`, `youtube`, `image`, `pi`) and external runtimes (`lightpanda`, `cloak`). Manual system binaries (`ollama`, `bwrap`) remain user-installed. See [Dependencies](./dependencies.md) for the full command reference.

Dependencies declared by skill scripts are separate. Deploy, boot, and
`/skill reload` prepare them under `~/.abtars/node_modules/`; `abtars deps
install all` is not required for a skill's declared package.

```bash
abtars deps list          # shows every group + install status
abtars deps install all   # installs npm groups + Lightpanda + Cloak
abtars deps install ollama # prints ollama's manual install command (does not run it)
```

## Interactive install

Omit `--non-interactive` and the wizard will prompt for each value:

```bash
npm install -g abtars@alpha abmind@alpha
abtars deps install all
abtars install
abmind install
```

## Install modes

| Mode | How it works | Who |
|------|-------------|-----|
| **daemon** (default) | launchd/systemd manages watchdog → auto-restart on crash | Production |
| **simple** | No daemon, user runs `abtars start/stop` manually | Testing, development |

Set during install. Daemon mode starts automatically after `abtars install`. Simple mode requires `abtars start`.

**Simple mode note:** If you use optional deps (`abtars deps install`), add to your shell profile:
```bash
export NODE_PATH="$HOME/.local/lib/node_modules:$NODE_PATH"
```
Daemon mode sets this automatically.

## Install channels

| Channel | Command | Who |
|---|---|---|
| **Stable** | `npm install -g abtars abmind` | Production use |
| **Alpha** | `npm install -g abtars@alpha abmind@alpha` | Latest features, tested on live instances |
| **Dev** | `git clone` + `abtars update --dev <dir>` | Contributors |

## Commands reference

```bash
abtars start               # Start bridge (simple mode) or load daemon
abtars stop                # Stop bridge + watchdog
abtars restart             # Warm restart (in-process)
abtars restart --cold      # Kill + fresh start
abtars update --alpha      # Pull latest source, rebuild, deploy (--stable | --dev also work)
abtars rollback            # Back to previous release (--to 1-3 for older slots)
abtars doctor              # Health check
abtars status              # Bridge status
abtars deps list           # Show optional deps
abtars deps install X      # Install optional dep
```

See [Deploy Pipeline](./deploy.md) for the full update/rollback reference.

## Updating

```bash
abtars update --alpha    # pulls latest source, rebuilds, deploys, restarts (daemon mode)
```

`--stable` tracks stable releases, `--dev` tracks dev (add a directory,
`--dev <dir>`, to deploy from a local checkout). In simple mode, `update`
deploys but doesn't restart. Run `abtars start` after.

If `abtars` still behaves like the old version after updating, a stale `npm install -g abtars` may be shadowing the updated wrapper. See [troubleshooting](./troubleshooting.md#abtars-resolves-to-a-stale-version-after-update).

## What gets created

```
~/.local/bin/
├── abtars               # CLI wrapper (refreshed on every deploy)
├── abtars-task          # task subprocess wrapper
└── ...                  # other tool wrappers

~/.abtars/
├── app -> ../.abtars-releases/current  # compat link to the active release
├── config/              # .env, transport.json, users.json, peers.json
├── secret/              # API keys (encrypted at rest after first boot)
├── skills/              # core/ + self/ + custom/ + downloaded/
├── node_modules/        # exact packages declared by skill scripts
├── logs/                # bridge + watchdog logs
├── state/               # deploy + supervisor state
├── manifest.json        # version, commit, source, installMode
├── bridge.lock          # live PIDs + heartbeat
└── deploy.state         # last deploy status

~/.abtars-releases/
├── <commit>/            # deployed releases (bundle/, templates/)
├── current -> <commit>  # canonical activation point (atomic swap)
├── history.json         # release history (rollback slots)
└── src/                 # synced source checkouts (abtars/)

~/.local/lib/node_modules/   # unified native deps dir (better-sqlite3, optional deps)

~/.abmind/
└── memory/
    ├── memory.db        # SQLite + FTS5 + embeddings
    ├── core/            # SOUL.md, agent_notes.md, user_profile.md
    └── sleep/           # sleep cycle state + logs
```

## Providers

| Provider | What you need |
|----------|---------------|
| ollama | Running locally (`ollama serve`). Free, no API key. |
| OpenRouter | An API key from [openrouter.ai](https://openrouter.ai) |
| OpenAI | An API key from [platform.openai.com](https://platform.openai.com) |
| Anthropic | An API key from [console.anthropic.com](https://console.anthropic.com) |
| Kiro CLI | `kiro-cli` installed and on PATH |
| Gemini CLI | `gemini` installed and on PATH |

The install wizard asks for your provider and API key — it handles the rest.

Configure in `~/.abtars/config/transport.json`.

## Managing API keys

abTARS stores all secrets in `~/.abtars/secret/` — one file per key, encrypted at rest (AES-256-GCM). You never edit config files for keys.

### Adding a key after install

```bash
# Write the key (no trailing newline!)
echo -n "sk-or-v1-abc123..." > ~/.abtars/secret/OPENROUTER_API_KEY

# Restart to pick it up (encrypted automatically on boot)
abtars stop && abtars start
```

The filename becomes the environment variable name. That's the only rule.

### Provider keys

| Provider | Secret filename | Where to get it |
|----------|----------------|-----------------|
| OpenRouter | `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| OpenAI | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic | `ANTHROPIC_API_KEY` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |

### Service/skill keys (optional integrations)

| Service | Secret filename | Settings (in `.env.skills`) |
|---------|----------------|----------------------------|
| Home Assistant | `HA_TOKEN` | `HA_URL=http://<ha-host>:8123` |
| Groq (voice STT) | `GROQ_API_KEY` | `STT_MODEL=whisper-large-v3` |
| Google AI (images) | `GOOGLE_AI_API_KEY` | `GOOGLE_AI_MODEL=gemini-2.0-flash-preview-image-generation` |
| Discord | `DISCORD_BOT_TOKEN` | `DISCORD_APP_ID=your-app-id` |

Example — adding Home Assistant:

```bash
# 1. Drop the long-lived access token
echo -n "eyJ0eXAi..." > ~/.abtars/secret/HA_TOKEN

# 2. Add non-secret settings
echo "HA_URL=http://<ha-host>:8123" >> ~/.abtars/config/.env.skills

# 3. Restart
abtars stop && abtars start
```

Your agent can now control Home Assistant. See [Adding a Service](./add-service.md) for the full guide.

### Removing a key

```bash
rm ~/.abtars/secret/OPENAI_API_KEY
abtars stop && abtars start
```

### How it stays safe

- Files are AES-256-GCM encrypted at rest after the first boot
- Keys only exist as plaintext in memory while the bridge runs
- All secret files are `chmod 600` (owner-read only)
- `abtars doctor` checks vault integrity on every run
- Logs never contain secret values

See [Secrets Vault](./secrets.md) for the full technical details.

## Post-install verification

```bash
abtars doctor    # all green = healthy
abtars status    # shows PID, uptime, model
```

Send a message to your bot on Telegram — it should respond.

## Next steps

- [Health Check](./healthcheck.md) — verify everything is running correctly
- [Upgrading](./upgrade.md) — keep your bridge up to date
- [Backup & Restore](./backup.md) — protect your data
