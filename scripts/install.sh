#!/usr/bin/env bash
set -euo pipefail

# abTARS installer — one command to set up everything.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aksika/abtars/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/aksika/abtars/main/scripts/install.sh | CHANNEL=alpha bash

CHANNEL="${CHANNEL:-latest}"
TAG=""
[ "$CHANNEL" = "alpha" ] && TAG="@alpha"

echo "━━━ abTARS installer (channel: $CHANNEL) ━━━"
echo ""

# ── 1. Node.js ──
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 22 ]; then
    echo "⚠ Node.js $NODE_VER found — need 22+. Installing via fnm..."
    curl -fsSL https://fnm.vercel.app/install | bash
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$(fnm env)"
    fnm install 22 && fnm use 22
  else
    echo "✓ Node.js $(node -v)"
  fi
else
  echo "→ Installing Node.js 22 via fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
  fnm install 22 && fnm use 22
  echo "✓ Node.js $(node -v)"
fi

# ── 2. Install packages ──
echo ""
echo "→ Installing abtars${TAG} and abmind${TAG}..."
npm install -g "abtars${TAG}" "abmind${TAG}" --no-audit --no-fund
echo "✓ Packages installed"

# ── 3. abmind install ──
echo ""
echo "━━━ Memory setup (abmind) ━━━"
abmind install

# ── 4. abtars install + update ──
echo ""
echo "━━━ Bridge setup (abtars) ━━━"
abtars install
abtars update

# ── 5. Onboard ──
echo ""
echo "━━━ Configuration ━━━"
abtars onboard

# ── Done ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ abTARS installed and configured!"
echo ""
echo "Start the bridge:"
echo "  sudo \$(which abtars) daemon install"
echo ""
echo "Or manual mode (no auto-start on boot):"
echo "  abtars start"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
