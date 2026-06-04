#!/usr/bin/env bash
# upgrade-deps.sh — Upgrade all external dependencies (abtars + abmind).
# Portable: macOS and Linux. Runs weekly via cron; safe to run manually.
# Does not restart the bridge. Deploy with `abtars update` to activate.

# Intentionally no `set -e`: one failing step must not skip later steps.
set -uo pipefail

echo "🔄 Dependency upgrade ($(uname -s))"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Locate an abmind checkout (sibling of bridge source, or common HOME layouts).
ABMIND_ROOT=""
for candidate in "$BRIDGE_ROOT/../abmind" "$HOME/abmind" "$HOME/workspace/ab/abmind"; do
  if [[ -f "$candidate/package.json" ]]; then
    ABMIND_ROOT="$(cd "$candidate" && pwd)"
    break
  fi
done

npm_update() {
  local label="$1" dir="$2"
  echo "📦 $label npm ($dir)..."
  ( cd "$dir" && npm update --save 2>&1 | tail -3 ) || echo "  ⚠️  $label npm update failed"
  ( cd "$dir" && npm audit fix --force 2>&1 | tail -2 ) || echo "  ⚠️  $label npm audit fix failed"
  echo ""
}

npm_update "abtars" "$BRIDGE_ROOT"
if [[ -n "$ABMIND_ROOT" ]]; then
  npm_update "abmind" "$ABMIND_ROOT"
else
  echo "📦 abmind npm: checkout not found — skipped"
  echo ""
fi

# pipx tools — use `pipx upgrade` (no grep -P, portable).
if command -v pipx >/dev/null 2>&1; then
  echo "🐍 pipx tools..."
  for name in notebooklm-mcp-cli; do
    echo -n "  $name: "
    if pipx list --short 2>/dev/null | grep -q "^$name "; then
      pipx upgrade "$name" 2>&1 | tail -1
    else
      echo "not installed (skip)"
    fi
  done
  echo ""
fi

# Homebrew — macOS only.
if command -v brew >/dev/null 2>&1; then
  echo "🍺 Homebrew..."
  brew update 2>&1 | tail -2
  brew upgrade 2>&1 | tail -5
  echo ""
fi

echo "🤖 kiro-cli: $(kiro-cli --version 2>/dev/null || echo 'not found') — update via kiro.dev"
echo ""
echo "✅ Done. Activate with: (cd abmind && abmind update) && (cd abtars && abtars update)"
