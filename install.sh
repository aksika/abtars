#!/usr/bin/env bash
# install.sh — First-time agentbridge setup.
# Usage: ./install.sh [--mode=simple|supervised]
set -euo pipefail
cd "$(dirname "$0")"
node dist/cli/agentbridge.js install "$@"
