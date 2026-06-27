#!/usr/bin/env bash
# emergency-update.sh — fully-manual deploy when the abtars CLI cannot update itself.
#
# Builds the fresh dev bundle with plain npm + esbuild (NO abtars/abmind CLI
# invocation), stages a release, repoints the symlinks, and restarts the
# watchdog directly via launchctl/systemd. Result is identical to
# `abtars update --dev` but needs no working deployed binary.
#
# This is a MANUAL MIRROR of src/cli/deploy-lib/deploy.ts (deployActivation).
# If deploy.ts changes its stop/respawn sequence or path layout, UPDATE THIS.
#
# Usage: bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh

set -euo pipefail

SRC_DIR="${ABTARS_SRC:-$HOME/.abtars-releases/src/abtars}"
ABMIND_DIR="${ABMIND_SRC:-$HOME/.abtars-releases/src/abmind}"
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
step "fetching latest dev..."
git -C "$SRC_DIR" fetch --depth 1 origin dev
git -C "$SRC_DIR" reset --hard origin/dev
if [ -d "$ABMIND_DIR/.git" ]; then
  git -C "$ABMIND_DIR" fetch --depth 1 origin dev
  git -C "$ABMIND_DIR" reset --hard origin/dev
fi

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

# ── 3. Build abmind + copy into bundle ─────────────────────────────────────
if [ -f "$ABMIND_DIR/package.json" ]; then
  step "building abmind..."
  ( cd "$ABMIND_DIR" && npm install --ignore-scripts && npm run build )
  if [ -f "$ABMIND_DIR/dist/cli/abmind.js" ]; then
    ABMIND_DEST="$SRC_DIR/bundle/node_modules/abmind"
    rm -rf "$ABMIND_DEST"
    mkdir -p "$ABMIND_DEST"
    cp -r "$ABMIND_DIR/." "$ABMIND_DEST/"
    rm -rf "$ABMIND_DEST/node_modules" "$ABMIND_DEST/.git"
    chmod +x "$ABMIND_DEST/dist/cli/abmind.js" 2>/dev/null || true
  else
    echo "! abmind build produced no dist — bundle will fall back to global abmind"
  fi
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

# ── 8. Stop daemon (FROZEN sequence — mirrors deploy.ts deployActivation) ──
step "stopping daemon..."
OLD_PID="$(jget "$BRIDGE_LOCK" pid)"
WD_PID="$(jget "$BRIDGE_LOCK" watchdogPid)"
if [ "$IS_MAC" = "1" ]; then
  launchctl bootout "$UID_LABEL/com.abtars.watchdog" 2>/dev/null || true
else
  systemctl --user stop abtars-watchdog 2>/dev/null || true
fi
echo "update:$VERSION" > "$ABTARS_HOME/.start-reason"
[ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null || true
[ -n "$WD_PID" ]   && kill "$WD_PID"   2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do               # wait up to ~5s for bridge to exit
  if [ -z "$OLD_PID" ] || ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
[ -n "$OLD_PID" ] && kill -9 "$OLD_PID" 2>/dev/null || true
[ -n "$WD_PID" ]   && kill -9 "$WD_PID"   2>/dev/null || true
rm -f "$ABTARS_HOME/.stopped"

# ── 9. Respawn ─────────────────────────────────────────────────────────────
step "respawning daemon..."
echo "deploy-respawn" > "$ABTARS_HOME/.start-reason"
if [ "$IS_MAC" = "1" ]; then
  if [ -f "$PLIST" ]; then
    # bootout->bootstrap can race (launchd tear-down); retry once after a beat
    launchctl bootstrap "$UID_LABEL" "$PLIST" 2>/dev/null || { sleep 2; launchctl bootstrap "$UID_LABEL" "$PLIST" 2>/dev/null || echo "! watchdog bootstrap failed — run: launchctl bootstrap $UID_LABEL \"$PLIST\""; }
  fi
else
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user unmask abtars-watchdog 2>/dev/null || true
  systemctl --user enable abtars-watchdog 2>/dev/null || true
  systemctl --user start abtars-watchdog 2>/dev/null || true
fi

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
