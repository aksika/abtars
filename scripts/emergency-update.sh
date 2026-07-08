#!/usr/bin/env bash
# emergency-update.sh — fully-manual deploy when the abtars CLI cannot update itself.
#
# Builds the fresh dev bundle with plain npm + esbuild (NO abtars CLI
# invocation), stages a release, repoints the symlinks, and restarts the
# watchdog directly via launchctl/systemd. Result is identical to
# `abtars update --dev` but needs no working deployed binary.
#
# This is a MANUAL MIRROR of src/cli/deploy-lib/deploy.ts (deployActivation),
# EXCEPT for the stop/respawn sequence, which intentionally diverges (#1299):
#   - deploy.ts `/update dev` runs INSIDE the abtars-watchdog.service cgroup, so
#     it must NOT stop the service or kill the watchdog (cgroup suicide under
#     KillMode=control-group). It kills only the bridge and lets L3 respawn it;
#     it CANNOT refresh the watchdog.
#   - THIS script runs OUTSIDE the cgroup (manual login shell), so it CAN and
#     DOES fully refresh the watchdog via one atomic `systemctl restart`. This is
#     the foolproof, dependency-free WD-refresh path for when the CLI is broken.
# If deploy.ts changes its release path layout, UPDATE THIS. Do NOT "re-sync" the
# stop/respawn sequences — the divergence is deliberate.
#
# Usage: bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh

set -euo pipefail

SRC_DIR="${ABTARS_SRC:-$HOME/.abtars-releases/src/abtars}"
RELEASES_DIR="$HOME/.abtars-releases"
ABTARS_HOME="${ABTARS_HOME:-$HOME/.abtars}"
PLIST="$HOME/Library/LaunchAgents/com.abtars.watchdog.plist"
BRIDGE_LOCK="$ABTARS_HOME/bridge.lock"
UID_LABEL="gui/$(id -u)"
IS_MAC="$(uname | grep -q Darwin && echo 1 || echo 0)"

die() { echo "x $*" >&2; exit 1; }
step() { echo "+ $*"; }
# Read a JSON field from a file via node (node is always present — esbuild needs it).
jget() { node -e 'const fs=require("fs");try{const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]];if(v!=null)process.stdout.write(String(v))}catch{}' "$1" "$2" 2>/dev/null || true; }

[ -d "$SRC_DIR/.git" ] || die "abtars source not found at $SRC_DIR"

# ── 1. Sync source ─────────────────────────────────────────────────────────
step "bypassing dev branch fetch/reset..."
# git -C "$SRC_DIR" fetch --depth 1 origin dev
# git -C "$SRC_DIR" reset --hard origin/dev


COMMIT="$(git -C "$SRC_DIR" rev-parse --short HEAD)"
PKG_VERSION="$(node -p "require('$SRC_DIR/package.json').version")"
VERSION="$PKG_VERSION-$COMMIT"
RELEASE_DIR="$RELEASES_DIR/$COMMIT"

# ── 2. Build abtars ────────────────────────────────────────────────────────
step "installing abtars deps (npm ci)..."
( cd "$SRC_DIR" && npm ci )

step "building abtars bundle (esbuild)..."
( cd "$SRC_DIR" && node esbuild.config.js )
if [ -d "$SRC_DIR/src/components/dashboard/public" ]; then
  rm -rf "$SRC_DIR/bundle/public"
  cp -r "$SRC_DIR/src/components/dashboard/public" "$SRC_DIR/bundle/public"
fi
if [ -d "$SRC_DIR/agents" ]; then
  rm -rf "$SRC_DIR/bundle/agents"
  cp -r "$SRC_DIR/agents" "$SRC_DIR/bundle/agents"
fi

# ── 4. Stage release ───────────────────────────────────────────────────────
step "staging release $VERSION -> $RELEASE_DIR ..."
mkdir -p "$RELEASES_DIR"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"                # must exist so cp nests bundle/ rather than flattening it
cp -r "$SRC_DIR/bundle" "$RELEASE_DIR/"   # -> $RELEASE_DIR/bundle/
printf '{"type":"module","name":"abtars","version":"%s"}\n' "$VERSION" > "$RELEASE_DIR/package.json"
[ -d "$SRC_DIR/templates" ] && cp -r "$SRC_DIR/templates" "$RELEASE_DIR/templates"
[ -f "$SRC_DIR/install-manifest.json" ] && cp "$SRC_DIR/install-manifest.json" "$RELEASE_DIR/install-manifest.json"

# ── 5. history.json (unshift, cap 4) ───────────────────────────────────────
node -e '
  const fs = require("fs");
  const dir = process.argv[1], commit = process.argv[2], path = dir + "/history.json";
  let h = []; try { h = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
  h = h.filter(x => x !== commit); h.unshift(commit);
  while (h.length > 4) { const d = h.pop(); try { fs.rmSync(dir + "/" + d, { recursive: true, force: true }); } catch {} }
  fs.writeFileSync(path, JSON.stringify(h) + "\n");
' "$RELEASES_DIR" "$COMMIT"

# ── 6. Repoint symlinks (watchdog execs ~/.abtars/app/bundle/abtars.js) ─────
ln -sfn "$RELEASE_DIR" "$RELEASES_DIR/current"
rm -rf "$ABTARS_HOME/app"
ln -s "$RELEASE_DIR" "$ABTARS_HOME/app"

# ── 7. manifest.json (version/commit) ──────────────────────────────────────
node -e '
  const fs = require("fs");
  const home = process.argv[1], path = home + "/manifest.json";
  let m = {}; try { m = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
  m.previousVersion = m.version || null; m.previousCommit = m.commit || null;
  m.version = process.argv[2]; m.commit = process.argv[3]; m.branch = "dev";
  m.activatedAt = new Date().toISOString(); m.source = "dev";
  m.installMode = m.installMode || "daemon";
  fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
' "$ABTARS_HOME" "$VERSION" "$COMMIT"

# ── 8. Stop (mirrors deploy.ts, but see #1299 divergence) ──────────────────
step "stopping daemon..."
OLD_PID="$(jget "$BRIDGE_LOCK" pid)"
WD_PID="$(jget "$BRIDGE_LOCK" watchdogPid)"
if [ "$IS_MAC" = "1" ]; then
  # macOS: bootout now, bootstrap in step 9. No cgroup teardown, so the detached
  # deploy survives — the full stop/kill sequence is safe here.
  launchctl bootout "$UID_LABEL/com.abtars.watchdog" 2>/dev/null || true
  echo "update:$VERSION" > "$ABTARS_HOME/.start-reason"
  [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null || true
  [ -n "$WD_PID" ]  && kill "$WD_PID"  2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do               # wait up to ~5s for bridge to exit
    if [ -z "$OLD_PID" ] || ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
    sleep 0.5
  done
  [ -n "$OLD_PID" ] && kill -9 "$OLD_PID" 2>/dev/null || true
  [ -n "$WD_PID" ]  && kill -9 "$WD_PID"  2>/dev/null || true
fi
# Linux (#1299): NO `systemctl stop` and NO manual kill here. An explicit stop
# opens a durable "stopped" window — if the reconcile in 8b fails under set -e,
# the watchdog is left dead before the verify in 9b (the 2026-07-03 14.4h outage
# class). Instead we reconcile while the watchdog is still up, then do ONE atomic
# `systemctl restart` in step 9: it tears down the old watchdog cgroup (old WD +
# bridge) and starts a fresh watchdog with the new service def + new
# abtars-watchdog.sh. This script runs OUTSIDE the service cgroup (manual login
# shell), so the restart does not kill it — this is the foolproof WD-refresh path.
rm -f "$ABTARS_HOME/.stopped"

# ── 8b. Reconcile watchdog service definition from repo template (#1284) ────
# MIRROR of deploy.ts deployActivation (the plist/systemd reconcile block).
# Renders the service definition from the source-of-truth template so we never
# bootstrap a stale plist left over from an older path scheme. The template
# points ProgramArguments at the persistent source checkout
# ($SRC_DIR/scripts/abtars-watchdog.sh), which git pull keeps current — no
# copy into the release dir, no versioned path, no drift. Fails loudly (set -e)
# if the template is missing rather than bootstrapping a wrong path.
step "reconciling watchdog service definition..."
if [ "$IS_MAC" = "1" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  # {{HOME}} -> $HOME. Use | as sed delimiter ($HOME contains /).
  sed "s|{{HOME}}|$HOME|g" "$SRC_DIR/scripts/com.abtars.watchdog.plist" > "$PLIST"
else
  mkdir -p "$HOME/.config/systemd/user"
  cp "$SRC_DIR/scripts/abtars-watchdog.service" "$HOME/.config/systemd/user/abtars-watchdog.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi

# ── 9. Respawn ─────────────────────────────────────────────────────────────
step "respawning daemon..."
echo "deploy-respawn" > "$ABTARS_HOME/.start-reason"
if [ "$IS_MAC" = "1" ]; then
  # bootout->bootstrap can race (launchd tear-down); retry once after a beat
  launchctl bootstrap "$UID_LABEL" "$PLIST" 2>/dev/null || { sleep 2; launchctl bootstrap "$UID_LABEL" "$PLIST" 2>/dev/null || true; }
else
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user unmask abtars-watchdog 2>/dev/null || true
  systemctl --user enable abtars-watchdog 2>/dev/null || true
  # #1278/#1299: single atomic restart is the ONLY teardown+respawn on Linux —
  # step 8 no longer does an explicit stop, so there is no durable stopped
  # window. restart tears down the old watchdog cgroup and starts a fresh
  # watchdog with the reconciled service def + new abtars-watchdog.sh.
  systemctl --user restart abtars-watchdog 2>/dev/null || systemctl --user start abtars-watchdog 2>/dev/null || true
fi

# ── 9b. Verify the watchdog actually came up (#1278) ───────────────────────
# The old code masked the restart with `|| true` and only probed BRIDGE health.
# A swallowed watchdog restart left the unit dead with no signal — the 2026-07-03
# 14.4h outage. Verify the watchdog is alive; loud-fail (exit 1) if not, with a
# copy-pasteable recovery command. No silent mask on this critical path.
step "verifying watchdog is alive..."
wd_ok=""
WD_NEW=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  WD_NEW="$(jget "$BRIDGE_LOCK" watchdogPid)"
  if [ -n "$WD_NEW" ] && [ "$WD_NEW" != "0" ] && kill -0 "$WD_NEW" 2>/dev/null; then
    if [ "$IS_MAC" = "1" ]; then
      if launchctl print "$UID_LABEL/com.abtars.watchdog" >/dev/null 2>&1; then wd_ok=1; break; fi
    else
      if systemctl --user is-active --quiet abtars-watchdog; then wd_ok=1; break; fi
    fi
  fi
  sleep 1
done
if [ -z "$wd_ok" ]; then
  echo "x watchdog did NOT come up after respawn — bridge has NO supervisor." >&2
  if [ "$IS_MAC" = "1" ]; then
    echo "  recover: launchctl bootout \"$UID_LABEL/com.abtars.watchdog\" 2>/dev/null; launchctl bootstrap \"$UID_LABEL\" \"$PLIST\"" >&2
  else
    echo "  recover: systemctl --user daemon-reload && systemctl --user enable --now abtars-watchdog" >&2
  fi
  exit 1
fi
step "watchdog alive (pid $WD_NEW)"

# ── 10. Health probe (new pid + fresh lastHeartbeat) ───────────────────────
step "waiting for bridge health..."
START_MS="$(node -e 'console.log(Date.now())')"
ok=""
i=0
while [ "$i" -lt 60 ]; do
  if node -e '
    const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const pid = l.pid || 0, hb = l.lastHeartbeat || 0;
    process.exit(pid !== Number(process.argv[2]) && hb > Number(process.argv[3]) ? 0 : 1);
  ' "$BRIDGE_LOCK" "${OLD_PID:-0}" "$START_MS" 2>/dev/null; then ok=1; break; fi
  sleep 2
  i=$((i + 1))
done
if [ -n "$ok" ]; then
  echo "✓ bridge healthy ($VERSION)"
else
  echo "! bridge not healthy after ~120s — check ~/.abtars/logs. Watchdog (KeepAlive) will keep retrying."
fi
