#!/usr/bin/env bash
# Emergency update fallback.
#
# This is deliberately independent of every abtars CLI, including the
# supervisor-state helper. It only builds the source checkout, stages a release,
# swaps the release links, restarts the OS watchdog, and performs a small liveness
# check. Use it when the deployed abtars command is broken.
#
# Usage: bash ~/.abtars-releases/src/abtars/scripts/emergency-update.sh

set -euo pipefail

SRC_DIR="${ABTARS_SRC:-$HOME/.abtars-releases/src/abtars}"
HOME_DIR="${ABTARS_HOME:-$HOME/.abtars}"
RELEASES_DIR="${ABTARS_RELEASES:-$HOME/.abtars-releases}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/abtars-watchdog.service"
PLIST="$HOME/Library/LaunchAgents/com.abtars.watchdog.plist"
SERVICE="abtars-watchdog"

fail() { echo "x $*" >&2; exit 1; }

[ -d "$SRC_DIR/.git" ] || fail "source checkout not found: $SRC_DIR"
[ -d "$HOME_DIR" ] || fail "abtars home not found: $HOME_DIR"

COMMIT="$(git -C "$SRC_DIR" rev-parse --short HEAD)"
VERSION="$(node -p "require('$SRC_DIR/package.json').version")-$COMMIT"
RELEASE_DIR="$RELEASES_DIR/$COMMIT"

echo "+ build $VERSION"
( cd "$SRC_DIR" && npm ci && npm run bundle )

echo "+ stage $RELEASE_DIR"
mkdir -p "$RELEASES_DIR"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
cp -a "$SRC_DIR/bundle" "$RELEASE_DIR/"
[ ! -d "$SRC_DIR/templates" ] || cp -a "$SRC_DIR/templates" "$RELEASE_DIR/"
[ ! -f "$SRC_DIR/install-manifest.json" ] || cp -a "$SRC_DIR/install-manifest.json" "$RELEASE_DIR/"

# Keep the rollback history small and deterministic. This is plain release
# bookkeeping; it does not invoke the deployed application.
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const [dir, ref] = process.argv.slice(1);
  const file = path.join(dir, "history.json");
  let history = [];
  try { history = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const next = [ref, ...history.filter((x) => x !== ref)];
  for (const old of next.slice(4)) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  history = next.slice(0, 4);
  fs.writeFileSync(file, JSON.stringify(history) + "\n");
' "$RELEASES_DIR" "$COMMIT"

# Only current is the activation point. app is a stable compatibility link to
# current, never a direct link to a release.
swap_link() {
  local target="$1" link="$2" tmp="${2}.new.$$"
  ln -s "$target" "$tmp"
  mv -f "$tmp" "$link"
}
swap_link "$RELEASE_DIR" "$RELEASES_DIR/current"
swap_link "$RELEASES_DIR/current" "$HOME_DIR/app"

node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const [home, version, commit] = process.argv.slice(1);
  const file = path.join(home, "manifest.json");
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  manifest.previousVersion = manifest.version ?? null;
  manifest.previousCommit = manifest.commit ?? null;
  manifest.version = version;
  manifest.commit = commit;
  manifest.branch = "dev";
  manifest.source = "dev";
  manifest.activatedAt = new Date().toISOString();
  manifest.installMode = manifest.installMode ?? "daemon";
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$HOME_DIR" "$VERSION" "$COMMIT"

# Stop only the bridge. The watchdog itself is replaced by launchd/systemd and
# will start/adopt one bridge from the newly activated release.
signal_bridge() {
  node -e '
  const fs = require("node:fs");
  try {
    const l = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pid = typeof l.pid === "number" ? l.pid : 0;
    const expected = typeof l.startIdentity === "string" ? l.startIdentity : "";
    let identity = `${pid}:0`;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      identity = `${pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmdline.includes("abtars.js") && !cmdline.includes("bundle")) process.exit(0);
    } catch {
      if (process.platform !== "darwin") process.exit(0);
    }
    if (pid > 0 && expected === identity) {
      process.kill(pid, process.argv[2]);
      process.stdout.write(String(pid));
    }
  } catch {}
' "$HOME_DIR/bridge.lock" "$1"
}

BRIDGE_PID="$(signal_bridge SIGTERM)"
if [[ "$BRIDGE_PID" =~ ^[1-9][0-9]*$ ]]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$BRIDGE_PID" 2>/dev/null || break
    sleep 0.5
  done
  signal_bridge SIGKILL >/dev/null || true
fi

if [[ "$(uname)" == "Darwin" ]]; then
  mkdir -p "$(dirname "$PLIST")"
  tmp_plist="${PLIST}.new.$$"
  sed "s|{{HOME}}|$HOME|g" "$SRC_DIR/scripts/com.abtars.watchdog.plist" > "$tmp_plist"
  mv -f "$tmp_plist" "$PLIST"
  launchctl bootout "gui/$(id -u)/com.abtars.watchdog" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl print "gui/$(id -u)/com.abtars.watchdog" >/dev/null
else
  mkdir -p "$UNIT_DIR"
  if [[ ! -f "$UNIT" ]] || ! cmp -s "$SRC_DIR/scripts/abtars-watchdog.service" "$UNIT"; then
    cp "$SRC_DIR/scripts/abtars-watchdog.service" "$UNIT"
    systemctl --user daemon-reload
  fi
  systemctl --user unmask "$SERVICE"
  systemctl --user enable "$SERVICE"
  systemctl --user restart "$SERVICE" || systemctl --user start "$SERVICE"
  if ! systemctl --user is-active --quiet "$SERVICE"; then
    echo "x watchdog is not active" >&2
    exit 1
  fi
fi

echo "✓ emergency update deployed: $VERSION"
