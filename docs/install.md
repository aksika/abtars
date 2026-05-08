# AgentBridge Installation Guide

**Version:** 0.1.0 (post-#158 lifecycle rewrite)

AgentBridge ships a full lifecycle CLI: `install`, `update`, `rollback`, `reset`, `onboard`, `doctor`, `migrate`, `status`.

Runtime lives at `~/.abtars/` (override via `$ABTARS_HOME`). Code is versioned under `releases/<version>/` with a `current` symlink for instant rollback.

The bridge depends on **abmind** as a memory backend. Install options:
- `brew tap aksika/tap && brew install abmind` (macOS)
- `npm install -g abmind` (any platform)
- From source (see `abmind/docs/install.md`)

---

## Quick start (combined bridge + abmind)

```bash
# 1. Clone both repos side by side
cd ~/workspace
git clone git@github.com:aksika/abmind.git
git clone git@github.com:aksika/abtars.git

# 2. Build + install abmind first (bridge depends on it)
cd abmind
npm install && npm run build
node dist/cli/abmind.js install
abmind update

# 3. Build + install abtars
cd ../abtars
npm install && npm run build                  # npm install picks up the file:../abmind dep
node dist/cli/abtars.js install
abtars update

# 4. Configure (interactive wizard) — Telegram token, chat ID, transport, etc.
abtars onboard

# 5. Start the watchdog → bridge auto-starts
~/.abtars/watchdog.sh --all --web --agent &
```

Verify:
```bash
abtars status      # manifest + lock state
abmind status           # same for abmind
abtars doctor      # filesystem + process health check
```

If `~/.local/bin` isn't on `$PATH`, `install` prints the shell config line.

---

## Lifecycle commands

| Command | Purpose |
|---|---|
| `abtars install [--upgrade] [--force]` | First-time setup. Creates dirs, seeds `config/.env` + `config/.env.skills` from examples, writes CLI wrappers, creates PATH symlinks. `--upgrade` runs the one-time flat→releases migration on pre-#158 hosts. `--force` re-seeds missing config. |
| `abtars update [--source local\|npm\|github] [--from-local]` | Build current checkout → stage → flip `current` → prune old. Reads `~/.abmind/manifest.json` for version compat (errors with actionable hint if abmind is outdated, unless `--allow-abmind-mismatch`). Runs 001/002 env-path migrations at end. Warns and exits if local branch behind `origin/<branch>` (use `--from-local` to override). |
| `abtars rollback [--to <version>]` | Flip `current` back. Validates target exists in `releases/`. Refuses if `package-lock.json` hash differs (requires full rebuild instead). |
| `abtars reset --scope <config\|config+data\|full> [--yes] [--dry-run] [--non-interactive] [--no-backup] [--force]` | Scoped destructive reset. `config` wipes `config/` only. `config+data` adds `memory/`, `logs/`, `reports/`, `received/`. `full` removes `~/.abtars/` + PATH symlinks (automatic backup unless `--no-backup`). Non-interactive requires `--yes`. |
| `abtars onboard` | Interactive first-time config wizard. Prompts for Telegram bot token, primary chat ID, default transport provider, default model, optional Discord A2A channel. Writes `config/.env`. Re-run requires `--force` to overwrite owned keys. Non-interactive: `--non-interactive --accept-risk --telegram-token ... --telegram-chat-id ... --default-provider ...` |
| `abtars doctor [args]` | Thin wrapper around `scripts/doctor.sh`. Runs pgrep/filesystem/lock inspection, reports issues. `--fix` attempts automated recovery. |
| `abtars migrate [--only <name>] [--dry-run]` | Standalone migration runner. Migrations also run at the end of `update` (001/002). 003-flat-to-releases only runs via `install --upgrade`. |
| `abtars status` | Print manifest + lock state. Exit 1 if not installed or layout mismatched. |

Plus utility CLIs: `abtars-browser`, `abtars-restart`, `abtars-tweet`.

Run `abtars <cmd> --help` for per-command usage.

---

## Runtime layout (post-#158)

```
~/.abtars/
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
│   ├── abtars
│   ├── abtars-browser
│   ├── abtars-restart
│   └── abtars-tweet
├── scripts/                       # abtars.sh, watchdog.sh, browser-patchright.sh, doctor.sh, ...
├── abtars.sh                 # launcher (invoked by watchdog)
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

Seeded from `.env.example` on first install. Managed by `abtars onboard` for the core keys; operator can add custom keys freely (preserved across `onboard` re-runs).

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
- Many more — see `abproject/docs/asbuilts/config-abtars.asbuilt.md` for the full reference

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

### (a) abtars-only update

```bash
cd ~/workspace/ab/abtars
git pull
abtars update
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
cd ~/workspace/ab/abtars && git pull && abtars update
```

Deliberately NOT wrapped in a single subcommand — hidden cross-package side effects were the failure mode of the old `deploy.sh` (silent `require.resolve` skip). Explicit wins.

---

## Requirements

- **Node.js** 22+
- **SQLite** — bundled via better-sqlite3
- **rsync** — required by `abtars update` to dereference `file:../abmind` dep
- **Git** — `update` reads HEAD SHA + branch for version tag
- **Docker** (optional) — for `browser-patchright.sh` (patchright-based browsing)
- **Ollama** (recommended) — for abmind's embedding-based recall; see `abmind/docs/install.md`

---

## Onboarding (non-interactive)

For CI, automation, or scripted installs:

```bash
abtars onboard \
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
cd ~/workspace/ab/abtars
git pull
abtars update
```

What happens:
1. Check `git fetch` — refuse if local HEAD behind origin (override: `--from-local`)
2. `npm install` in the checkout (if package-lock.json changed)
3. `npm run build` (typescript compile)
4. Stage `dist/` → `~/.abtars/releases/<version>/dist/`
5. `rsync -aL` node_modules → `~/.abtars/node_modules/` (dereferences abmind symlink)
6. Flip `current` symlink (atomic)
7. Update `manifest.json`
8. Prune oldest release if retention (3) exceeded
9. Run pending migrations (001/002; 003 is install-only)
10. Compatibility check: abmind version vs bridge's package.json dep range

**If the bridge is running during update:** the watchdog keeps the old process on the old symlink target. After `update` completes, `pkill + restart` or `watchdog.sh` restart picks up the new release. The bridge does NOT hot-reload.

---

## Rolling back

```bash
abtars rollback                              # previous release, instant
abtars rollback --to 0.1.0-28f71ef           # specific version
```

Restart the bridge (kill + watchdog respawn) to pick up the flipped symlink.

**Refusal case:** if `package-lock.json` hash differs between releases:
```
v0.1.0-abc pinned different deps than v0.1.0-xyz (package-lock hashes differ).
Rollback via symlink is unsafe. Instead:
  git checkout <commit>
  abtars update --from-local
```
Because `node_modules/` is shared and the old release's deps aren't present. Full rebuild is the correct recovery.

---

## Migration from pre-#158 flat layout

If you had an older `~/.abtars/` with `dist/` at the root (no `releases/`), first time only:

1. **Stop the bridge + watchdog:**
   ```bash
   # Linux / KP:
   pkill -f "watchdog.*--all"
   pkill -TERM -f 'node.*dist/main\.js'

   # macOS / Molty:
   launchctl unload ~/Library/LaunchAgents/com.abtars.watchdog.plist
   ```
   Verify with `pgrep -f 'node.*abtars.*dist/main\.js'` → empty.

2. **Run the upgrade migration:**
   ```bash
   cd ~/workspace/ab/abtars
   abtars install --upgrade
   ```

   The migration:
   - Refuses if any bridge process is still running
   - Backs up `~/.abtars/` → `~/.abtars.pre-158.bak/` (automated, ~several hundred MB)
   - Moves `dist/` → `releases/<derived-version>/dist/`
   - Creates `current -> releases/<derived-version>`
   - Preserves any custom files in `bin/` under `bin.pre-158.bak/` inside the backup
   - Regenerates launcher scripts (`abtars.sh`, `watchdog.sh`, `browser-patchright.sh`) to use `current/dist/main.js`
   - Writes initial manifest with migration record

3. **First real update:**
   ```bash
   abtars update
   ```
   Builds the current checkout into a proper versioned release.

4. **Restart:**
   ```bash
   # Linux / KP:
   ~/.abtars/watchdog.sh --all --web --agent &

   # macOS / Molty:
   launchctl load ~/Library/LaunchAgents/com.abtars.watchdog.plist
   ```

5. **Verify:**
   ```bash
   abtars status
   tail -f ~/.abtars/logs/bridge-$(date +%F).log
   ```

**Rollback of the migration itself:**
```bash
pkill -f watchdog && pkill -TERM -f 'node.*main\.js'
rm -rf ~/.abtars
mv ~/.abtars.pre-158.bak ~/.abtars
# Restart via your platform's service manager
```

---

## Reset / uninstall

```bash
# Wipe only operator config (re-run onboard to restore)
abtars reset --scope config --yes

# Wipe config + memory + logs + reports + received. Keeps code (releases/).
abtars reset --scope config+data --yes

# Full uninstall. Removes ~/.abtars/ + PATH symlinks.
# Automatic backup to ~/.abtars.reset-<ts>.bak/ unless --no-backup.
abtars reset --scope full --yes
```

All destructive ops:
- Support `--dry-run` for preview
- Refuse unsafe targets (`/`, `$HOME`, outside-home paths)
- Require `--yes` in non-interactive mode
- `full` scope only touches PATH symlinks that point into our own `~/.abtars/bin/` (exact-match check; never clobbers symlinks owned by other installs)

---

## Launching + supervision

`install` creates `~/.abtars/watchdog.sh` — the process supervisor. Start it:

```bash
~/.abtars/watchdog.sh --all --web --agent &
```

Flags:
- `--all` — enable all platforms (telegram + discord)
- `--web` — dashboard on `127.0.0.1:3000`
- `--agent` — agent API on `0.0.0.0:3001`

The watchdog:
- Spawns `node current/dist/main.js` with the same flags
- Monitors `bridge.lock` heartbeat; kills + respawns on stale
- Logs to `~/.abtars/logs/bridge-<date>.log`

For persistent service supervision:

### macOS (launchd — Molty)
`~/Library/LaunchAgents/com.abtars.watchdog.plist` — the file is shipped in the repo's `scripts/` and installed by `install`. Load:
```bash
launchctl load ~/Library/LaunchAgents/com.abtars.watchdog.plist
```

### Linux (systemd — optional)
A systemd unit template (`scripts/abtars@.service`) ships in the repo but is **not auto-installed**. Manual setup if you want systemd supervision:
```bash
sudo cp ~/workspace/ab/abtars/scripts/abtars@.service /etc/systemd/system/
sudo systemctl enable --now abtars@$USER
```

For KP dev: just background the watchdog (`~/.abtars/watchdog.sh --all --web --agent &`). Restart manually on reboot.

---

## Doctor (health check)

```bash
abtars doctor
abtars doctor --fix
```

Runs `scripts/doctor.sh`. Checks:
- `~/.abtars/` layout (releases, current, manifest, config)
- Bridge process state via `pgrep`
- Watchdog process state
- Lock file freshness
- DB reachability (`~/.abmind/memory/memory.db`)
- Filesystem space + permissions

`--fix` attempts automated recovery (clear stale locks, regenerate missing wrappers, restart watchdog).

---

## Troubleshooting

### `abtars: command not found`

`~/.local/bin` isn't on `$PATH`. Add to shell config:
```bash
export PATH="$HOME/.local/bin:$PATH"
```
Or re-run `abtars install` — it prints the exact line.

### `error: Lock held by pid N`

Another `abtars update`/`install` is running. Check:
```bash
abtars status    # shows lock state
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
rm -rf ~/.abtars/node_modules
abtars update
```

### Bridge starts but responds with "disk I/O error" in logs

The running bridge's abmind deps point at a symlink into the dev workspace instead of a materialized copy. Run `abtars update` again — the rsync-L fix dereferences the symlink.

### `memory_entities` table or entity errors

Should be gone in schema v17. Check with `abmind status` — version should be current. If stuck at v16, run `abmind update`.

### Telegram commands not appearing

The `/setMyCommands` call happens at bridge boot (see `src/boot/phase-platforms.ts`). Restart bridge to re-sync.

### Agent API permission denied from Molty

Check `config/.env`:
```
AGENT_API_ALLOWED_IPS=<TAILSCALE_IP>,<LAN_IP>
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
rm -rf ~/.abtars

# Remove PATH symlinks
rm -f ~/.local/bin/abtars ~/.local/bin/abtars-browser \
      ~/.local/bin/abtars-restart ~/.local/bin/abtars-tweet

# Remove launchd service (macOS only)
launchctl unload ~/Library/LaunchAgents/com.abtars.watchdog.plist
rm ~/Library/LaunchAgents/com.abtars.watchdog.plist

# Optionally remove the git checkout
rm -rf ~/workspace/ab/abtars
```

abmind is independent — uninstall separately per `abmind/docs/install.md`.

---

## Troubleshooting

### Bridge won't start after reboot (macOS)

**Symptom:** `launchctl list | grep abtars` shows the watchdog with a non-zero exit status or PID `-`. Bridge process not running.

**Check watchdog log:**
```bash
tail -30 ~/.abtars/logs/watchdog-launchd.log
```

| Log pattern | Cause | Fix |
|---|---|---|
| Repeated "Watchdog starting" every 10s, no "Starting bridge" | Watchdog self-destruct loop (doctor.sh or other startup crash) | Check `~/.abtars/logs/launchd.log` for errors. If doctor.sh is the cause, verify it's not called from watchdog startup. |
| "Bridge spawned (PID=N)" then "Bridge process gone (PID=N)" in <60s | Bridge crashes on startup | Check `~/.abtars/logs/launchd.log` for the crash. Common: missing `better-sqlite3`, port conflict, bad `.env`. |
| "Port 3000 is already in use" | Another bridge instance or stale process holds the port | `lsof -i :3000` to find it. Kill the stale process. If two launchd plists are loaded, remove the legacy one (see below). |
| No log at all | Watchdog not loaded or plist missing | `ls ~/Library/LaunchAgents/com.abtars.watchdog.plist` — if missing, run `abtars update` (copies plist). Then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.abtars.watchdog.plist`. |

### Bridge won't start after reboot (Linux)

```bash
systemctl --user status abtars-watchdog
journalctl --user -u abtars-watchdog -n 50
```

If the service file is missing: `abtars update` installs it to `~/.config/systemd/user/`. Then:
```bash
systemctl --user daemon-reload
systemctl --user enable --now abtars-watchdog
```

### Two bridge instances fighting (Telegram 409 Conflict)

**Symptom:** Telegram poller logs `409: terminated by other getUpdates request`. Two processes polling the same bot token.

**Diagnose:**
```bash
ps aux | grep "node.*main.js" | grep -v grep
launchctl list | grep abtars   # macOS
```

If two launchd jobs are loaded (e.g. `com.abtars.watchdog` AND `com.abtars.<agent>`):
```bash
# Keep only the watchdog plist
launchctl unload ~/Library/LaunchAgents/com.abtars.<agent>.plist
rm ~/Library/LaunchAgents/com.abtars.<agent>.plist
```

If two node processes from the same plist: the watchdog spawns one, something else (cron agent, manual start) spawned another. Kill the rogue:
```bash
# Find the watchdog's bridge PID
cat ~/.abtars/bridge.lock | python3 -c "import json,sys;print(json.load(sys.stdin)['pid'])"
# Kill any OTHER node main.js process
```

### `abmind recall` / CLI tools not found from bridge

**Symptom:** Model says "can't find abmind" or execute_bash returns "command not found" for `abmind`, `abtars-tweet`, etc.

**Cause:** The bridge inherits PATH from the watchdog's launchd plist (macOS) or systemd service (Linux). If PATH doesn't include user-local bin dirs, CLI tools are invisible.

**Check:**
```bash
# See what PATH the bridge actually has (macOS)
ps -p $(cat ~/.abtars/bridge.lock | python3 -c "import json,sys;print(json.load(sys.stdin)['pid'])") -E | grep PATH
```

**Fix:** `abtars update` templates the plist with `$HOME`-relative paths. If you see hardcoded `/Users/akos/...` in the plist, run `abtars update` to regenerate it. Then reload:
```bash
# macOS
launchctl bootout gui/$(id -u)/com.abtars.watchdog
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.abtars.watchdog.plist
# Linux
systemctl --user daemon-reload && systemctl --user restart abtars-watchdog
```

### `better-sqlite3` not found (ERR_MODULE_NOT_FOUND)

**Symptom:** Bridge crashes with `Cannot find package 'better-sqlite3' imported from .abtars/node_modules/abmind/dist/src/memory-db.js`.

**Cause:** `better-sqlite3` is an abmind dependency. It lives at `~/.abtars/node_modules/abmind/node_modules/better-sqlite3/`. If this directory is missing, the deploy's rsync didn't include it.

**Fix:**
```bash
# Ensure abmind's source checkout has it installed
cd ~/abmind && npm install   # (or wherever abmind checkout lives)
# Re-deploy bridge (rsync picks up abmind's node_modules)
cd ~/abtars && abtars update
```

If the problem persists, check that `abtars update` is NOT deleting `~/.abtars/node_modules/abmind/node_modules/`. This was a known bug fixed in commit `ae65108`.

### Plist changes not taking effect

**Symptom:** You updated the plist (PATH, KeepAlive, etc.) but the running watchdog still uses old values.

**Cause:** launchd caches the plist at load time. `launchctl kickstart -k` restarts the process but reuses the cached config. You need a full unload/reload.

```bash
launchctl bootout gui/$(id -u)/com.abtars.watchdog
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.abtars.watchdog.plist
```

Or reboot. `abtars update` prints a hint when plist content changes.

### Sleep cycle fails / Mac stays awake

**Symptom:** Mac doesn't sleep after BED_TIME. Bridge log shows sleep failures.

**Check:**
```bash
grep -E "sleep|dreamy|BUDGET|🏁" ~/.abtars/logs/bridge-$(date +%F).log | tail -20
```

| Pattern | Cause | Fix |
|---|---|---|
| "All models exhausted" on multiple steps | LLM provider rate-limited or down | Wait for provider recovery. Sleep retries up to 3 times (5min apart). Check model config: `cat ~/.abtars/config/transport.json`. |
| "LLM call limit (N) reached — suspending" | Sleep budget exhausted | Normal if many steps failed (each retry burns budget). The `suspended` status now allows retry (fixed in abmind `c87847a`). |
| "Sleep already done today — skip" after a failed attempt | Retry blocked by daily flag | Update abmind — fix `c87847a` treats `suspended` as retryable. |
| Sleep succeeded but no "Putting hardware to sleep" | Quiet-tick countdown not reached (user messaged during wait) | Normal — bridge waits for N quiet ticks (no messages) after Dreamy finishes before calling `pmset sleepnow`. |
| `pmset -g` shows `sleep 0` | macOS auto-sleep disabled | Not a problem — bridge uses `pmset sleepnow` (forced), not idle-based. But if the bridge's sleep cycle fails, the Mac won't auto-sleep as fallback. Set `sudo pmset -c sleep 30` if you want a safety net. |

### Watchdog kills bridge with "heartbeat stale"

**Symptom:** Watchdog log shows `Killing bridge PID=N (heartbeat stale (Xs))` repeatedly.

**Cause:** Bridge isn't updating `lastHeartbeat` in `bridge.lock`. The watchdog's staleness threshold is `WATCHDOG_STALE_SEC` (default 360s = 6 min).

**Common causes:**
- Bridge is stuck in a long-running LLM call (model timeout)
- Bridge event loop is blocked (sync I/O, infinite loop)
- Bridge crashed silently (no graceful shutdown, heartbeat stops)

**Check:**
```bash
cat ~/.abtars/bridge.lock   # lastHeartbeat timestamp
tail -50 ~/.abtars/logs/bridge-$(date +%F).log   # last activity
```

If heartbeat is stale but bridge is responsive via Telegram, the heartbeat task may have thrown. Check for `[heartbeat]` errors in the log.

### Messages lost during outage

**Symptom:** User sent messages while bridge was down, but they never arrived after recovery.

**Cause (pre-fix):** The Telegram poller advanced its offset before processing handlers. If the bridge crashed mid-processing, messages were acked to Telegram but never handled. Fixed in commit `7e4623c` — offset now advances only after handler success, persisted to `~/.abtars/state/telegram-offset`.

**If still happening post-fix:** Check `~/.abtars/state/telegram-offset` — it should contain the last successfully-processed update_id. On restart, the poller resumes from this offset. If the file is missing or corrupt, the poller starts from 0 (Telegram replays retained updates, up to 24h).

### Model returns empty response (🤷 fallback)

**Symptom:** User gets `🤷 Model returned an empty response. Try again or /reset.`

**Cause:** The model returned 0 characters after processing. If the model made successful tool calls (e.g. `memory_store`), the 🤷 is suppressed (fixed in `bfb72f6`). If no tool calls succeeded, the fallback fires.

**Common causes:**
- Model rate-limited (returns empty on exhaustion)
- Model context window full (returns empty when prompt exceeds limit)
- Model bug (specific prompt triggers empty response)

**Check:** `grep "Empty response" ~/.abtars/logs/bridge-$(date +%F).log` — if frequent, check model health: `/models` command in Telegram, or `cat ~/.abtars/config/transport.json`.

### execute_bash blocked ("Command blocked: this would spawn/restart a bridge")

**Symptom:** Model's bash command returns `Command blocked: this would spawn/restart a bridge or watchdog process`.

**Cause:** Safety guardrail in `tool-registry.ts` blocks commands matching `main.js`, `abtars.sh`, `watchdog.sh`, or `launchctl load/bootstrap/kickstart/start`. Prevents LLMs from accidentally spawning duplicate bridge instances (observed in the 2026-04-22 outage).

**If legitimate:** The guardrail is intentionally broad. If you need to run a blocked command, do it from a terminal, not through the bot.

---

## See also

- `abmind/docs/install.md` — memory backend install
- `abproject/docs/plans/158-deploy-rewrite.md` — design doc for this lifecycle
- `abproject/docs/asbuilts/system.asbuilt.md` — bridge architecture overview
- `abproject/docs/asbuilts/config-abtars.asbuilt.md` — full `.env` reference


---

## Post-install checklist (manual restore after clean install)

After `abtars install` + `abtars update` complete, these items need manual setup or restore from backup (`abproject/backups/<agent>/`):

### Required

- [ ] **`.env`** — copy secrets from `abproject/config/<agent>/secrets.env` to `~/.abtars/config/.env` (Telegram token, Discord token, API keys)
- [ ] **`transport.json`** — restore from `abproject/secret/<agent>/transport.json` to `~/.abtars/config/transport.json` (providers, agents, models)
- [ ] **`models.json`** — restore from `abproject/secret/<agent>/models.json` to `~/.abtars/config/models.json` (model catalog with status)
- [ ] **`users.json`** — restore user registry to `~/.abtars/config/users.json`
- [ ] **abmind** — install abmind separately (`cd ~/abmind && abmind install && abmind update`), restore `~/.abmind/memory/memory.db` from backup if needed
- [ ] **Watchdog plist** — copy `scripts/com.abtars.watchdog.plist` to `~/Library/LaunchAgents/` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.abtars.watchdog.plist`

### Recommended

- [ ] **`cron.json`** — restore scheduled tasks from `abproject/backups/<agent>/cron.json` to `~/.abtars/state/cron.json`
- [ ] **SOUL.md** — restore persona from `~/.abmind/memory/core/SOUL.md` (backed up in abmind's memory dir)
- [ ] **Skills** — copy skill scripts to `~/.abtars/skills/core/` (scout-ollama.py, scout-openrouter.py, scout-add-model.py)
- [ ] **Hooks** — restore `~/.abtars/config/hooks.json` if custom hooks were configured

### Verify

- [ ] `abtars status` — shows version + lock state
- [ ] Send a Telegram message — bot responds
- [ ] `/doctor` — all probes pass
- [ ] `/tasks` — shows restored cron entries
- [ ] `abmind memory-stats` — DB accessible, memory count > 0
