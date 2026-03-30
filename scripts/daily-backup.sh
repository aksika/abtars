#!/usr/bin/env bash
set -euo pipefail

AB="$HOME/.agentbridge"
DEST="$HOME/.backup-agentbridge"
DATE=$(date +%Y%m%d)

mkdir -p "$DEST"

# Zip backup
cd "$AB"
zip -qr "$DEST/agentbridge-$DATE.zip" \
  memory/ core/ skills/ prompts/ tasks/ topics/ reports/ finance/ \
  -x "memory/pending_*" "memory/memory.db-wal" "memory/memory.db-shm"

# Encrypted DB backup for git
mkdir -p "$AB/backup"
DB_KEY="$AB/titok/db.key"
if [ -f "$DB_KEY" ] && [ -f "$AB/memory/memory.db" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$DB_KEY" \
    -in "$AB/memory/memory.db" -out "$AB/backup/memory.db.enc"
fi

# Prune >7 days
find "$DEST" -name "agentbridge-*.zip" -mtime +7 -delete

# Git commit + push
cd "$AB"
git add -A
git diff --cached --quiet || git commit -m "daily: $(date +%Y-%m-%d)"
git push 2>/dev/null || true
