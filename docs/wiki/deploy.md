# Deploy Pipeline

How code gets from source to a running bridge.

## Quick reference

### CLI

```bash
abtars update                # from npm (stable/alpha)
abtars update --local   # build + deploy from local git checkout
abtars update --dry-run      # preview, no mutations
abtars rollback              # swap app/ ↔ app.prev/, restart
abtars restart               # restart without rebuild
abtars restart --cold        # starts supervisor if dead
```

### Telegram

```
/update              # from npm
/update pull         # git pull latest (no build)
/update deploy        # build + deploy from checkout
/software            # versions, source, rollback slots
```

Remote deploy flow: `/update pull` → `/update deploy`

## What `abtars update` does

```
0. Pre-flight: check sentinel, acquire lock, clean stale staging, register SIGHUP trap
1. Resolve source (git fetch + staleness check, or npm package)
2. Build into app.staging/ (esbuild bundle + external deps + copy abmind)
3. Validate: entry point exists at app.staging/bundle/abtars.js
4. Config snapshot: rotate 3 slots, copy config/ → config/.pre-update/
5. Atomic swap: rm app.prev/, mv app/ → app.prev/, mv app.staging/ → app/
6. Post-swap: refresh scripts, bin wrappers, skills, config seeds, doctor --fix
7. Write restart sentinel (status: "pending")
8. Restart bridge (USR1 to watchdog or cold restart)
9. Health probe: poll bridge.lock for 60s (fresh lastHeartbeat)
10. On failure: auto-rollback (swap app/ ↔ app.prev/, re-restart)
```

## Directory layout

```
~/.abtars/
  app/                  ← Active code (no symlinks)
    bundle/abtars.js    ← Bridge entry point
    node_modules/abmind/← Real copy of abmind dist
    package.json
    core/skills/
    install-manifest.json
  app.prev/             ← Previous version (one-step rollback)
  bin/                  ← CLI wrapper scripts (→ app/bundle/)
  scripts/              ← watchdog.sh, doctor.sh, abtars.sh
  config/
    .pre-update/        ← Config snapshot rotation (3 slots)
  state/
    update.sentinel     ← Tracks update lifecycle
  manifest.json         ← Version, commit, installMode
```

## What gets deployed

| Source | Target | Contents |
|--------|--------|----------|
| `bundle/` (esbuild output) | `~/.abtars/app/bundle/` | Compiled+bundled JS |
| `../abmind/dist/` | `~/.abtars/app/node_modules/abmind/` | Memory system (real copy) |
| `core/skills/` | `~/.abtars/skills/core/` | Core skill files |
| `scripts/*.sh` | `~/.abtars/scripts/` | watchdog, doctor, abtars launcher |
| `config/*.example` | `~/.abtars/config/` | Seeds missing config files |

## Entry point

```bash
# watchdog.sh spawns the bridge:
NODE_PATH="${ABMIND_HOME:-$HOME/.abmind}/lib/node_modules"
node "$AB/app/bundle/abtars.js" "$@"
```

No symlinks. One path. `NODE_PATH` only includes `$ABMIND_HOME/lib/node_modules/` for the `better-sqlite3` native addon.

## Restart modes

| Mode | How | When to use |
|------|-----|-------------|
| Warm | Writes `restartRequested` to `bridge.lock` → heartbeat reads → `process.exit(0)` → supervisor respawns | Config changes |
| Cold | Starts supervisor directly if bridge dead | After crashes, first boot |
| USR1 | Signals watchdog → graceful TERM → respawn | Normal deploys (`abtars update`) |

## Health probe

After restart, `abtars update` polls `bridge.lock` every 3s for a `lastHeartbeat` newer than the restart timestamp. If healthy within 60s → success. If not → auto-rollback.

## Auto-rollback

If health probe fails:
1. `mv app/ app.broken/`
2. `mv app.prev/ app/`
3. Restart bridge again
4. If second restart healthy → print warning, exit 1
5. If second also fails → print diagnostics, exit 2

## Config snapshot

3 rotating slots before every update:
```
config/.pre-update/       ← most recent
config/.pre-update.1/     ← one update ago
config/.pre-update.2/     ← two updates ago
```

Recovery: `cp ~/.abtars/config/.pre-update/* ~/.abtars/config/`

## Restart sentinel

`state/update.sentinel` — written before restart (status: "pending"), cleared by bridge on first heartbeat tick (status: "success"). If stale, `abtars status` warns.

## Deploy to remote (Molty)

Via Telegram:
```
/update pull          ← fetches latest
/update deploy         ← builds + deploys + restarts
```

Or via SSH/tmux:
```bash
tmux send-keys -t remote 'cd ~/abmind && git pull --ff-only origin dev && npm run build && cd ~/abtars && git pull --ff-only origin dev && abtars update --local' Enter
```

## Rollback

```bash
abtars rollback
# Swaps app/ ↔ app.prev/, restarts, health-verifies, updates manifest
```

Always works — `app.prev/` is a full copy of the previous working version. No "pruned release" edge cases.

## Manual recovery (when `abtars update` itself is broken)

If the deployed CLI is in a state where it cannot run the update flow at all
— typically `abtars: no release staged. Run 'abtars install' first.` from the
wrapper, with a dead bridge the watchdog cannot respawn — use
`scripts/emergency-update.sh`. It is a small standalone fallback that uses only
plain `npm`/`node`, filesystem operations, and direct launchctl/systemd calls.
It does not invoke any abtars CLI or supervisor-state helper.

```bash
bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh
```

Source HEAD determines the deployed version. Pull or check out the commit you
want first if needed. The script updates `manifest.json`, `history.json`, and
the canonical `app -> current -> release` symlinks, then restarts the watchdog
and verifies that the OS service is active. It intentionally does not mirror the
normal deploy state machine; keep it limited to this recovery path.

## Doctor on every boot

The watchdog runs `doctor.sh --fix` before every bridge spawn:

```
watchdog.sh → doctor.sh --fix → node app/bundle/abtars.js
```

## Platform enablement

`.env` is the single source of truth for which components start:

```bash
TELEGRAM_ENABLED=true
DISCORD_ENABLED=true
IRC_ENABLED=false
ENABLE_DASHBOARD=true
ENABLE_AGENT_API=true
```

No CLI flags needed. Watchdog service files pass NO args.
