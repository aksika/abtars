# AgentBridge Installation Guide

**Version:** 0.1.0 (post-#158 lifecycle rewrite)

AgentBridge ships a full lifecycle CLI: `install`, `update`, `rollback`, `reset`, `onboard`, `doctor`, `migrate`, `status`.

Runtime lives at `~/.agentbridge/` (override via `$AGENT_BRIDGE_HOME`). Code is versioned under `releases/<version>/` with a `current` symlink for instant rollback.

The bridge depends on **abmind** as a memory backend — install that first (see `abmind/docs/install.md`).

---

## Quick start (combined bridge + abmind)

```bash
# 1. Clone both repos side by side
cd ~/workspace
git clone git@github.com:aksika/abmind.git
git clone git@github.com:aksika/agentbridge.git

# 2. Build + install abmind first (bridge depends on it)
cd abmind
npm install && npm run build
node dist/cli/abmind.js install
abmind update

# 3. Build + install agentbridge
cd ../agentbridge
npm install && npm run build                  # npm install picks up the file:../abmind dep
node dist/cli/agentbridge.js install
agentbridge update

# 4. Configure (interactive wizard) — Telegram token, chat ID, transport, etc.
agentbridge onboard

# 5. Start the watchdog → bridge auto-starts
~/.agentbridge/watchdog.sh --all --web --agent &
```

Verify:
```bash
agentbridge status      # manifest + lock state
abmind status           # same for abmind
agentbridge doctor      # filesystem + process health check
```

If `~/.local/bin` isn't on `$PATH`, `install` prints the shell config line.

---

## Lifecycle commands

| Command | Purpose |
|---|---|
| `agentbridge install [--upgrade] [--force]` | First-time setup. Creates dirs, seeds `config/.env` + `config/.env.skills` from examples, writes CLI wrappers, creates PATH symlinks. `--upgrade` runs the one-time flat→releases migration on pre-#158 hosts. `--force` re-seeds missing config. |
| `agentbridge update [--source local\|npm\|github] [--from-local]` | Build current checkout → stage → flip `current` → prune old. Reads `~/.abmind/manifest.json` for version compat (errors with actionable hint if abmind is outdated, unless `--allow-abmind-mismatch`). Runs 001/002 env-path migrations at end. Warns and exits if local branch behind `origin/<branch>` (use `--from-local` to override). |
| `agentbridge rollback [--to <version>]` | Flip `current` back. Validates target exists in `releases/`. Refuses if `package-lock.json` hash differs (requires full rebuild instead). |
| `agentbridge reset --scope <config\|config+data\|full> [--yes] [--dry-run] [--non-interactive] [--no-backup] [--force]` | Scoped destructive reset. `config` wipes `config/` only. `config+data` adds `memory/`, `logs/`, `reports/`, `received/`. `full` removes `~/.agentbridge/` + PATH symlinks (automatic backup unless `--no-backup`). Non-interactive requires `--yes`. |
| `agentbridge onboard` | Interactive first-time config wizard. Prompts for Telegram bot token, primary chat ID, default transport provider, default model, optional Discord A2A channel. Writes `config/.env`. Re-run requires `--force` to overwrite owned keys. Non-interactive: `--non-interactive --accept-risk --telegram-token ... --telegram-chat-id ... --default-provider ...` |
| `agentbridge doctor [args]` | Thin wrapper around `scripts/doctor.sh`. Runs pgrep/filesystem/lock inspection, reports issues. `--fix` attempts automated recovery. |
| `agentbridge migrate [--only <name>] [--dry-run]` | Standalone migration runner. Migrations also run at the end of `update` (001/002). 003-flat-to-releases only runs via `install --upgrade`. |
| `agentbridge status` | Print manifest + lock state. Exit 1 if not installed or layout mismatched. |

Plus utility CLIs: `agentbridge-browser`, `agentbridge-restart`, `agentbridge-tweet`.

Run `agentbridge <cmd> --help` for per-command usage.

---

## Runtime layout (post-#158)

```
~/.agentbridge/
├── releases/
│   ├── 0.1.0-<sha>/dist/        # versioned; ~5 MB per release
│   └── 0.1.0-<prev-sha>/dist/   # kept for instant rollback
├── node_modules/                  # shared across releases, ~400 MB (rsync-L dereferenced)
├── current -> releases/0.1.0-<sha>
├── config/                        # operator-owned, never overwritten by update
│   ├── .env                       # Telegram token, transport, DEFAULT_*
│   ├── .env.skills                # skill-specific env (Google, HA, NotebookLM, ...)
│   ├── transport.json             # transport provider definitions
│   ├── transport.default.json     # baseline for /reset, refreshed on update
│   ├── models.json                # model → provider mapping
│   ├── users.json                 # user allowlist
│   └── auto-fix.json              # self-healer rules
├── memory/ logs/ reports/ received/ workspace/ backup/
├── skills/
│   ├── core/                      # bridge-shipped skills
│   ├── personal/                  # operator-added (not overwritten)
│   ├── auto/                      # ad-hoc / agent-generated
│   └── downloaded/                # skill catalog installs
├── agents/ tasks/ prompts/ core/   # operator-editable overlays
├── bin/                           # thin wrappers
│   ├── agentbridge
│   ├── agentbridge-browser
│   ├── agentbridge-restart
│   └── agentbridge-tweet
├── scripts/                       # agentbridge.sh, watchdog.sh, browser-patchright.sh, doctor.sh, ...
├── agentbridge.sh                 # launcher (invoked by watchdog)
├── watchdog.sh                    # process supervisor
├── browser-patchright.sh          # docker browser lifecycle
├── manifest.json                  # {version, commit, branch, source, migrations, abmind_version, ...}
└── .update.lock                   # flock pidfile during update/install
```

**Invariants:**
- `config/` is operator data. Never overwritten by `update`.
- `releases/` is code. Only `update`/`rollback` write here. Retention = 3.
- `node_modules/` is shared, rebuilt fresh on every `update` via `rsync -aL` (dereferences `file:../abmind` symlink).
- `current` symlink is the atomic commit point.
- The launcher + watchdog scripts live at the runtime root (not `releases/<v>/`) so process supervision survives symlink flips.

---

## Configuration files

### `config/.env` (operator-owned)

Seeded from `.env.example` on first install. Managed by `agentbridge onboard` for the core keys; operator can add custom keys freely (preserved across `onboard` re-runs).

Keys written by `onboard`:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `MAIN_CHAT_ID` — primary Telegram user's chat ID (numeric)
- `DEFAULT_PROVIDER` — `openrouter` | `anthropic` | `openai`
- `DEFAULT_MODEL` — model ID for the default provider
- `DISCORD_A2A_CHANNEL_ID` — optional Discord agent-to-agent channel snowflake

Operator-managed (edit by hand):
- `PLATFORMS` — `telegram` | `discord` | comma-separated
- `AGENT_CLI_PATH` — path to `kiro-cli` binary
- `AGENT_TRANSPORT` — `acp` | `direct-api` | `openai-compat`
- `SELFHEAL_ENABLED`, `DISABLED_CAPABILITIES` — feature toggles
- Many more — see `abproject/docs/asbuilts/config-agentbridge.asbuilt.md` for the full reference

### `config/.env.skills` (operator-owned)

Seeded from `.env.skills.example`. Contains skill-specific secrets (Twitter cookies, Discord tokens, API keys for integrations). Not touched by `onboard`.

### `config/transport.json` (operator-owned)

Provider definitions (OpenRouter endpoint, Anthropic base URL, OpenAI key, etc.). Seeded from `transport.json.example` on first install.

### `config/transport.default.json` (repo-owned)

**Overwritten on every update** — this is the baseline the `/reset` command restores from. Intentional.

### `config/models.json` (operator-owned)

Model → provider mapping + per-model defaults. Seeded from example on first install.

### `config/users.json` (operator-owned)

User allowlist. No default — you write this yourself or let `onboard` derive it from `MAIN_CHAT_ID`.

---

## Three deploy modes

### (a) agentbridge-only update

```bash
cd ~/workspace/ab/agentbridge
git pull
agentbridge update
```

Requires abmind already installed at a compatible version (verified via `~/.abmind/manifest.json` read).

### (b) abmind-only update

```bash
cd ~/workspace/ab/abmind
git pull
abmind update
```

Bridge keeps running on its current abmind version. Next bridge `update` will verify compat.

### (c) Combined update

```bash
# abmind first (bridge depends on it)
cd ~/workspace/ab/abmind && git pull && abmind update
# Then bridge
cd ~/workspace/ab/agentbridge && git pull && agentbridge update
```

Deliberately NOT wrapped in a single subcommand — hidden cross-package side effects were the failure mode of the old `deploy.sh` (silent `require.resolve` skip). Explicit wins.

---

## Requirements

- **Node.js** 22+
- **SQLite** — bundled via better-sqlite3
- **rsync** — required by `agentbridge update` to dereference `file:../abmind` dep
- **Git** — `update` reads HEAD SHA + branch for version tag
- **Docker** (optional) — for `browser-patchright.sh` (patchright-based browsing)
- **Ollama** (recommended) — for abmind's embedding-based recall; see `abmind/docs/install.md`

---

## Onboarding (non-interactive)

For CI, automation, or scripted installs:

```bash
agentbridge onboard \
  --non-interactive \
  --accept-risk \
  --telegram-token "123:ABC..." \
  --telegram-chat-id "1234567890" \
  --default-provider openrouter \
  --default-model z-ai/glm-4.6 \
  --discord-a2a-channel 987654321098765432
```

Required flags: `--accept-risk`, `--telegram-token`, `--telegram-chat-id`.
Optional: `--default-provider` (default `openrouter`), `--default-model` (provider-specific default), `--discord-a2a-channel`.

---

## Updating

```bash
cd ~/workspace/ab/agentbridge
git pull
agentbridge update
```

What happens:
1. Check `git fetch` — refuse if local HEAD behind origin (override: `--from-local`)
2. `npm install` in the checkout (if package-lock.json changed)
3. `npm run build` (typescript compile)
4. Stage `dist/` → `~/.agentbridge/releases/<version>/dist/`
5. `rsync -aL` node_modules → `~/.agentbridge/node_modules/` (dereferences abmind symlink)
6. Flip `current` symlink (atomic)
7. Update `manifest.json`
8. Prune oldest release if retention (3) exceeded
9. Run pending migrations (001/002; 003 is install-only)
10. Compatibility check: abmind version vs bridge's package.json dep range

**If the bridge is running during update:** the watchdog keeps the old process on the old symlink target. After `update` completes, `pkill + restart` or `watchdog.sh` restart picks up the new release. The bridge does NOT hot-reload.

---

## Rolling back

```bash
agentbridge rollback                              # previous release, instant
agentbridge rollback --to 0.1.0-28f71ef           # specific version
```

Restart the bridge (kill + watchdog respawn) to pick up the flipped symlink.

**Refusal case:** if `package-lock.json` hash differs between releases:
```
v0.1.0-abc pinned different deps than v0.1.0-xyz (package-lock hashes differ).
Rollback via symlink is unsafe. Instead:
  git checkout <commit>
  agentbridge update --from-local
```
Because `node_modules/` is shared and the old release's deps aren't present. Full rebuild is the correct recovery.

---

## Migration from pre-#158 flat layout

If you had an older `~/.agentbridge/` with `dist/` at the root (no `releases/`), first time only:

1. **Stop the bridge + watchdog:**
   ```bash
   # Linux / KP:
   pkill -f "watchdog.*--all"
   pkill -TERM -f 'node.*dist/main\.js'

   # macOS / Molty:
   launchctl unload ~/Library/LaunchAgents/com.agentbridge.watchdog.plist
   ```
   Verify with `pgrep -f 'node.*agentbridge.*dist/main\.js'` → empty.

2. **Run the upgrade migration:**
   ```bash
   cd ~/workspace/ab/agentbridge
   agentbridge install --upgrade
   ```

   The migration:
   - Refuses if any bridge process is still running
   - Backs up `~/.agentbridge/` → `~/.agentbridge.pre-158.bak/` (automated, ~several hundred MB)
   - Moves `dist/` → `releases/<derived-version>/dist/`
   - Creates `current -> releases/<derived-version>`
   - Preserves any custom files in `bin/` under `bin.pre-158.bak/` inside the backup
   - Regenerates launcher scripts (`agentbridge.sh`, `watchdog.sh`, `browser-patchright.sh`) to use `current/dist/main.js`
   - Writes initial manifest with migration record

3. **First real update:**
   ```bash
   agentbridge update
   ```
   Builds the current checkout into a proper versioned release.

4. **Restart:**
   ```bash
   # Linux / KP:
   ~/.agentbridge/watchdog.sh --all --web --agent &

   # macOS / Molty:
   launchctl load ~/Library/LaunchAgents/com.agentbridge.watchdog.plist
   ```

5. **Verify:**
   ```bash
   agentbridge status
   tail -f ~/.agentbridge/logs/bridge-$(date +%F).log
   ```

**Rollback of the migration itself:**
```bash
pkill -f watchdog && pkill -TERM -f 'node.*main\.js'
rm -rf ~/.agentbridge
mv ~/.agentbridge.pre-158.bak ~/.agentbridge
# Restart via your platform's service manager
```

---

## Reset / uninstall

```bash
# Wipe only operator config (re-run onboard to restore)
agentbridge reset --scope config --yes

# Wipe config + memory + logs + reports + received. Keeps code (releases/).
agentbridge reset --scope config+data --yes

# Full uninstall. Removes ~/.agentbridge/ + PATH symlinks.
# Automatic backup to ~/.agentbridge.reset-<ts>.bak/ unless --no-backup.
agentbridge reset --scope full --yes
```

All destructive ops:
- Support `--dry-run` for preview
- Refuse unsafe targets (`/`, `$HOME`, outside-home paths)
- Require `--yes` in non-interactive mode
- `full` scope only touches PATH symlinks that point into our own `~/.agentbridge/bin/` (exact-match check; never clobbers symlinks owned by other installs)

---

## Launching + supervision

`install` creates `~/.agentbridge/watchdog.sh` — the process supervisor. Start it:

```bash
~/.agentbridge/watchdog.sh --all --web --agent &
```

Flags:
- `--all` — enable all platforms (telegram + discord)
- `--web` — dashboard on `127.0.0.1:3000`
- `--agent` — agent API on `0.0.0.0:3001`

The watchdog:
- Spawns `node current/dist/main.js` with the same flags
- Monitors `bridge.lock` heartbeat; kills + respawns on stale
- Logs to `~/.agentbridge/logs/bridge-<date>.log`

For persistent service supervision:

### macOS (launchd — Molty)
`~/Library/LaunchAgents/com.agentbridge.watchdog.plist` — the file is shipped in the repo's `scripts/` and installed by `install`. Load:
```bash
launchctl load ~/Library/LaunchAgents/com.agentbridge.watchdog.plist
```

### Linux (systemd — optional)
A systemd unit template (`scripts/agentbridge@.service`) ships in the repo but is **not auto-installed**. Manual setup if you want systemd supervision:
```bash
sudo cp ~/workspace/ab/agentbridge/scripts/agentbridge@.service /etc/systemd/system/
sudo systemctl enable --now agentbridge@$USER
```

For KP dev: just background the watchdog (`~/.agentbridge/watchdog.sh --all --web --agent &`). Restart manually on reboot.

---

## Doctor (health check)

```bash
agentbridge doctor
agentbridge doctor --fix
```

Runs `scripts/doctor.sh`. Checks:
- `~/.agentbridge/` layout (releases, current, manifest, config)
- Bridge process state via `pgrep`
- Watchdog process state
- Lock file freshness
- DB reachability (`~/.abmind/memory/memory.db`)
- Filesystem space + permissions

`--fix` attempts automated recovery (clear stale locks, regenerate missing wrappers, restart watchdog).

---

## Troubleshooting

### `agentbridge: command not found`

`~/.local/bin` isn't on `$PATH`. Add to shell config:
```bash
export PATH="$HOME/.local/bin:$PATH"
```
Or re-run `agentbridge install` — it prints the exact line.

### `error: Lock held by pid N`

Another `agentbridge update`/`install` is running. Check:
```bash
agentbridge status    # shows lock state
```
Stale locks (PID dead or >1h old) are auto-stolen on next attempt.

### `Refused: bridge process(es) still running`

`install --upgrade` or a reset is refusing because the bridge is live. Stop it:
```bash
pkill -f watchdog
pkill -TERM -f 'node.*dist/main\.js'
```
Then retry.

### `ENOTDIR: Cannot overwrite directory with non-directory`

Happens during `update` if the destination `node_modules/abmind` is a real directory but source has it as a symlink (`file:../abmind`). The command now deletes destination before copy; if you still hit this on an old release, run:
```bash
rm -rf ~/.agentbridge/node_modules
agentbridge update
```

### Bridge starts but responds with "disk I/O error" in logs

The running bridge's abmind deps point at a symlink into the dev workspace instead of a materialized copy. Run `agentbridge update` again — the rsync-L fix dereferences the symlink.

### `memory_entities` table or entity errors

Should be gone in schema v17. Check with `abmind status` — version should be current. If stuck at v16, run `abmind update`.

### Telegram commands not appearing

The `/setMyCommands` call happens at bridge boot (see `src/boot/phase-platforms.ts`). Restart bridge to re-sync.

### Agent API permission denied from Molty

Check `config/.env`:
```
AGENT_API_ALLOWED_IPS=100.82.167.127,192.168.1.128
```
Update + restart bridge.

---

## Manual uninstall fallback

If the CLI is broken:
```bash
# Stop everything first
pkill -f watchdog
pkill -TERM -f 'node.*dist/main\.js'

# Remove runtime
rm -rf ~/.agentbridge

# Remove PATH symlinks
rm -f ~/.local/bin/agentbridge ~/.local/bin/agentbridge-browser \
      ~/.local/bin/agentbridge-restart ~/.local/bin/agentbridge-tweet

# Remove launchd service (macOS only)
launchctl unload ~/Library/LaunchAgents/com.agentbridge.watchdog.plist
rm ~/Library/LaunchAgents/com.agentbridge.watchdog.plist

# Optionally remove the git checkout
rm -rf ~/workspace/ab/agentbridge
```

abmind is independent — uninstall separately per `abmind/docs/install.md`.

---

## See also

- `abmind/docs/install.md` — memory backend install
- `abproject/docs/plans/158-deploy-rewrite.md` — design doc for this lifecycle
- `abproject/docs/asbuilts/system.asbuilt.md` — bridge architecture overview
- `abproject/docs/asbuilts/config-agentbridge.asbuilt.md` — full `.env` reference
