#!/usr/bin/env bash
# install.sh — First-time abtars setup.
# Handles: TTY detection, Node version check, auto-build if dist/ missing.
# Usage: ./install.sh [--mode=simple|supervised|supervised-daemon] [--force]
set -euo pipefail
cd "$(dirname "$0")"

# ── Help ──────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
abtars install.sh — First-time setup

Usage:
  ./install.sh [--mode=simple|supervised|supervised-daemon] [--force]

Options:
  --mode=simple              No watchdog, no auto-restart (default)
  --mode=supervised          Watchdog restarts bridge on crash
  --mode=supervised-daemon   Watchdog + launchd/systemd service
  --force                    Re-seed config even if ~/.abtars/ exists
  --help                     Show this message

Requirements:
  Node.js >= 20 (https://nodejs.org)

What it does:
  1. Builds the project (npm install + npm run build) if dist/ is missing
  2. Creates ~/.abtars/ with config, state, logs directories
  3. Seeds default config files (.env, transport.json, models.json, tasks.json)
  4. Installs CLI wrappers to ~/.local/bin/
  5. Optionally installs watchdog (supervised modes)
EOF
  exit 0
fi

# ── TTY probe ─────────────────────────────────────────────────────────────
IS_INTERACTIVE=0
if (: </dev/tty) 2>/dev/null; then
  IS_INTERACTIVE=1
fi

# ── Node check ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found." >&2
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "  Install: brew install node" >&2
  else
    echo "  Install: https://nodejs.org or: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -k bash - && sudo -k apt install -y nodejs" >&2
  fi
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [[ "$NODE_VERSION" -lt 20 ]]; then
  echo "ERROR: Node.js >= 20 required (found v$(node --version))." >&2
  echo "  Update: https://nodejs.org" >&2
  exit 1
fi

# ── Build if needed ───────────────────────────────────────────────────────
if [[ ! -d "dist" ]]; then
  echo "dist/ not found — building..."
  if ! npm install 2>&1; then
    echo "npm install failed. Retry with 'npm install' in $(pwd), then re-run ./install.sh." >&2
    exit 1
  fi
  if ! npm run build 2>&1; then
    echo "npm run build failed. Check errors above, fix, then re-run ./install.sh." >&2
    exit 1
  fi
fi

# ── Run install ───────────────────────────────────────────────────────────
exec node dist/cli/abtars.js install "$@"
