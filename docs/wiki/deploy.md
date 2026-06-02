# Deploy Pipeline

How code gets from source to a running bridge.

## Quick reference

```bash
# Full deploy (build + stage + restart)
abtars update

# Restart without rebuild
abtars restart

# Cold restart (starts supervisor if dead)
abtars restart --cold
```

## What `abtars update` does

1. **Build** — `npm run build` (TypeScript → `dist/`)
2. **Stage** — copies built artifacts + persona + CLIs + skills to `~/.abtars/`
3. **Doctor** — runs `abtars doctor --fix` (permissions, stale locks, missing dirs)
4. **Restart** — signals the bridge to restart (warm or cold)

## What gets deployed

| Source | Target | Contents |
|--------|--------|----------|
| `dist/` | `~/.abtars/current/` | Compiled JS |
| `persona/core/` | `~/.abtars/core/` | SOUL, TOOLS, profiles (never overwrites newer) |
| `persona/prompts/` | `~/.abtars/prompts/` | Prompt templates |
| `persona/skills/` | `~/.abtars/skills/core/` | Core skills |
| `persona/agents/` | `~/.abtars/agents/` | Sub-agent rules |
| `persona/tasks/` | `~/.abtars/tasks/` | Task descriptions |
| `src/cli/abtars-*.ts` | `~/.local/bin/abtars-*` | CLI tools |
| `scripts/watchdog.sh` | `~/.abtars/watchdog.sh` | External watchdog |

All copies use `safe_cp` — never overwrites a file that's newer in production.

## Restart modes

| Mode | How | When to use |
|------|-----|-------------|
| Warm | Writes `restartRequested` to `bridge.lock` → heartbeat reads → `process.exit(0)` → supervisor respawns | Normal deploys |
| Cold | Same as warm if bridge alive. If dead: starts supervisor directly. | After crashes, first boot |

## Deploy to remote (Molty)

```bash
# From WSL — full deploy to Mac mini
cd ~/abmind && git pull --ff-only origin dev && npm run build
cd ~/abtars && git fetch origin dev && git checkout <commit>
node esbuild.config.js && abtars update --from-local
```

Use `git checkout <commit>` (moves HEAD) — the release version is derived from `git rev-parse --short HEAD`.

## Doctor on every boot

The watchdog runs `doctor.sh --fix` before every bridge spawn:

```
watchdog.sh → doctor.sh --fix → node current/main.js
```

Doctor auto-fixes: permissions, missing dirs, stale locks, unloaded supervisor. If it can't fix something, it warns but doesn't block startup.

## Platform enablement

`.env` is the single source of truth for which components start:

```bash
TELEGRAM_ENABLED=true
DISCORD_ENABLED=true
IRC_ENABLED=false
ENABLE_DASHBOARD=true
ENABLE_AGENT_API=true
```

No CLI flags needed for normal operation. Watchdog service files should pass NO args to the bridge.

## Rollback

```bash
abtars rollback    # Restores previous release from ~/.abtars/previous/
```
