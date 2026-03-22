#!/usr/bin/env bash
set -euo pipefail

AB="$HOME/.agentbridge"
DEST="$HOME/.backup-agentbridge"
DATE=$(date +%Y%m%d)

mkdir -p "$DEST"

# Zip backup
cd "$AB"
zip -qr "$DEST/agentbridge-$DATE.zip" \
  memory/ topics/ .kiro/ titok/ notebooklm/ \
  sleeping_prompt.md browsing_prompt.md \
  -x "memory/pending_*" "memory/memory.db-wal" "memory/memory.db-shm"

# Prune >7 days
find "$DEST" -name "agentbridge-*.zip" -mtime +7 -delete

# Git commit + push
cd "$AB"
git add -A
git diff --cached --quiet || git commit -m "daily: $(date +%Y-%m-%d)"
git push 2>/dev/null || true
