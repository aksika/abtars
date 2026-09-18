# Upgrading & Deploying

Full pipeline reference: [Deploy Pipeline](./deploy.md).

## Telegram commands (master role only)

| Command | What it does |
|---------|-------------|
| `/update dev \| alpha \| stable` | Pull/build from channel, deploy, restart |
| `/update abmind` | Update the memory system separately |
| `/software` | Show versions, source, rollback slots |
| `/software rollback <slot>` | Roll back to slot 1-3 |

Remote deploy is one step: `/update dev` (or `alpha` / `stable`).
`pull`, `deploy`, `build`, and `git` are legacy aliases for `/update dev`.

## Linux / WSL

```bash
abtars update --alpha
```

`--stable` tracks stable releases, `--dev` tracks dev (add a directory,
`--dev <dir>`, to deploy from a local checkout). The update builds from
source, stages the release, atomically repoints `releases/current`,
restarts, and health-verifies. There is no auto-rollback — if the bridge
stays unhealthy, roll back manually (below).

## macOS

From Telegram (remote):
```
/update dev          ← pull latest dev, build, deploy, restart (one step)
/update alpha        ← same from the npm alpha channel
```

## abmind-only changes

abtars never bundles abmind — it is discovered at runtime from the global
install. Update it independently; rebuilding/redeploying abtars is not the
abmind update mechanism:

```bash
abmind update --dev
```

Or from the bridge (master role): `/update abmind`.

## Verify after deploy

```bash
abtars status
```

Or via Telegram: `/status`, `/software`

Shows: version, commit, bridge PID + health, source (npm or local + repo path). Also check:

1. `✓ Bridge healthy` in update output
2. Telegram polling started (check logs)
3. No EADDRINUSE errors

## Rollback

```bash
abtars rollback            # previous release (slot 1)
abtars rollback --to 2     # slot 2 (slots 1-3, from history.json)
```

Or via Telegram: `/software rollback 2`. Repoints `releases/current`,
updates the manifest, and respawns the bridge from the target release.

## If deploy fails

There is no auto-rollback. If the bridge stays unhealthy after an update:

1. Check logs: `ls ~/.abtars/logs/` and tail the latest bridge log
2. Check status: `abtars status`, `abtars doctor --fix`
3. Roll back: `abtars rollback`
4. If the CLI itself is broken, use the emergency script below

## If `abtars update` itself is broken

When the deployed CLI is so broken that `abtars update` cannot run — for
example the wrapper can't locate the bundle, or the bridge is dead and the
watchdog can't respawn it — use the emergency script. It builds the source
checkout, stages `releases/<commit>/`, repoints the `current` + `app`
links, restarts the watchdog, and runs a liveness check with plain `npm` +
`node` and direct launchctl/systemd calls. No working deployed binary
required.

```bash
bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh
```

Make sure the source checkout is on the commit you want first:
```bash
cd ~/.abtars-releases/src/abtars && git pull
```
