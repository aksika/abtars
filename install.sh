#!/usr/bin/env bash
# install.sh — First-time abtars setup.
# Usage: ./install.sh [--mode=simple|supervised]
set -euo pipefail
cd "$(dirname "$0")"
node dist/cli/abtars.js install "$@"
