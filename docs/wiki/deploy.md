# Deploy Pipeline

How code gets from source to a running bridge. For first-time setup on a
new machine, see [Installation](./install.md) — this page covers updates
to an existing node.

## Quick reference

### CLI

```bash
abtars update --alpha          # npm alpha channel
abtars update --stable         # npm stable channel
abtars update --dev            # latest dev (syncs source, builds, deploys)
abtars update --dev <dir>      # build + deploy from a local checkout
abtars rollback                # back to the previous release (slot 1)
abtars rollback --to 2         # back to slot 2 (slots 1-3)
abtars restart                 # warm restart without rebuild
abtars restart --cold          # kill + fresh start
```

A channel flag is required — bare `abtars update` prints usage and exits.

### Telegram (master role only)

```
/update dev | alpha | stable   # build + deploy + restart
/update abmind                 # update the memory system separately
/software                      # versions, source, rollback slots
/software rollback <slot>      # roll back to slot 1-3
```

`pull`, `deploy`, `build`, and `git` are legacy aliases for `/update dev`.
Remote deploy is a single step: `/update dev` (or `alpha` / `stable`).

## What `abtars update` does

```
0. Pre-flight: acquire lock, clean stale staging
1. Resolve source (sync dev checkout, or fetch npm channel;
   --dev <dir> builds that checkout as-is)
2. Build into staging (bundle + wrappers + templates)
3. Validate: entry point exists at staging/bundle/abtars.js
4. Pi compatibility preflight (skipped on first install)
5. Skill dependency gate: prepare exact dependencies for staged core
   skills plus preserved user skills before activation; failure leaves the
   previous release active
6. Copy staged → releases/<commit>/, update history.json (max 4, deduped)
7. Atomic activation: repoint releases/current, normalize app → current
8. Refresh: CLI wrappers, service files, skills/prompts from templates,
   manifest + deploy.state
9. Stop + respawn the bridge (full service restart from the CLI;
   bridge-only kill + watchdog respawn on the Telegram /update path)
10. Health probe: poll bridge.lock for ~3 min (new PID + fresh lastHeartbeat).
    Writes deploy.state success / unhealthy / failed. No auto-rollback —
    roll back manually if unhealthy.
```

## Directory layout

```
~/.abtars/
  app -> ../.abtars-releases/current  ← compat link (current is canonical)
  config/ secret/ skills/ logs/ state/ auth/
  manifest.json   ← version, commit, source, installMode, previous-*
  bridge.lock     ← live PIDs + lastHeartbeat (single source of truth)
  deploy.state    ← last deploy status (deploying/success/unhealthy/failed/rollback)

~/.abtars-releases/
  <commit>/       ← deployed releases (bundle/, templates/, install-manifest.json)
  current -> <commit>  ← canonical activation point (atomic swap)
  history.json    ← ordered release refs, max 4 (rollback slots 1-3)
  src/abtars/     ← synced dev checkout
  app.staging/    ← build staging (cleaned on every run)

~/.local/bin/     ← CLI wrappers (abtars, abtars-task, ...)
~/.local/lib/node_modules/  ← native deps (better-sqlite3, optional groups)
```

## What gets deployed

| Source | Target | Contents |
|--------|--------|----------|
| `bundle/` (esbuild output) | `releases/<commit>/bundle/` | Compiled JS, entry `bundle/abtars.js` |
| `templates/` | `releases/<commit>/templates/` → reconciled into runtime | Skills, prompts, config seeds |
| `scripts/*.sh|*.service|*.plist` | OS service files, reloaded if changed | watchdog, daemon units |
| `install-manifest.json` | `~/.local/bin/` | CLI wrapper refresh |

abmind is never bundled into a release. It ships as a separate global
package and is discovered at runtime. Update it independently
(`/update abmind` or `abmind update --dev`).

## Entry point

```bash
# watchdog.sh spawns the bridge through the links:
node "$HOME/.abtars/app/bundle/abtars.js" "$@"
# app → releases/current → releases/<commit>/ — never a direct version path
```

`NODE_PATH` includes `~/.local/lib/node_modules/` for native addons
such as `better-sqlite3`.

## Restart modes

| Mode | How | When to use |
|------|-----|-------------|
| Warm | Supervisor command → graceful restart (bridge back within ~30s) | Config changes |
| Cold | `abtars restart --cold`: kill bridge + fresh start | After crashes, first boot |
| Deploy | `abtars update`: stop service, activate release, respawn, health-probe | New code |

## Health probe

After respawn, the deploy polls `bridge.lock` every 3s for a new PID with
a `lastHeartbeat` newer than the restart timestamp (~3 min timeout).
Success writes `deploy.state: success`. Failure writes `unhealthy`/`failed`
and the watchdog keeps retrying — check `abtars status` and the logs, then
roll back manually. There is no automatic rollback.

## Deploy to a remote instance

Via Telegram (master role only):

```
/update dev      ← pull latest dev, build, deploy, restart (one step)
/update alpha    ← same from the npm alpha channel
```

Or over SSH:

```bash
ssh remote-host 'abtars update --alpha'
```

Update abmind separately — it is not part of the abtars deploy:

```bash
ssh remote-host 'abmind update --dev'
```

## Rollback

```bash
abtars rollback            # previous release (slot 1)
abtars rollback --to 2     # slot 2 (slots 1-3, from history.json)
# or via Telegram: /software rollback 2
```

Repoints `releases/current` at the target, updates `manifest.json` and
`deploy.state`, kills the bridge, and lets the watchdog respawn from the
target release. Slots come from `history.json` (current + up to 3 priors).

## Manual recovery (when `abtars update` itself is broken)

If the deployed CLI cannot run the update flow at all — for example the
wrapper cannot locate the bundle, or the bridge is dead and the watchdog
cannot respawn it — use `scripts/emergency-update.sh`. It is a small
standalone fallback that uses only plain `npm`/`node`, filesystem
operations, and direct launchd/systemd calls. It does not invoke any
abtars CLI.

```bash
bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh
```

Source HEAD determines the deployed version. Pull or check out the commit
you want first. The script builds the checkout, stages
`releases/<commit>/`, updates `history.json`, repoints the `current` +
`app` links, updates `manifest.json`, restarts the OS watchdog, and runs a
liveness check. It intentionally does not mirror the normal deploy state
machine; keep it limited to this recovery path.

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
ENABLE_DASHBOARD=true
ENABLE_AGENT_API=true
```

No CLI flags needed. Watchdog service files pass NO args.
