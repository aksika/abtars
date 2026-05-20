#!/usr/bin/env bash
set -euo pipefail

AB="$HOME/.abtars"
ABMIND="${ABMIND_HOME:-$HOME/.abmind}"
DEST="$HOME/.backup-abtars"
DATE=$(date +%Y%m%d)

mkdir -p "$DEST"

# WAL-safe memory.db backup via sqlite3
DB="$ABMIND/memory/memory.db"
DB_TMP="$DEST/.memory-$DATE.db"
if [ -f "$DB" ] && command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB" ".backup '$DB_TMP'"
fi

# Zip backup: abtars config/skills + abmind core/memory
cd "$AB"
zip -qr "$DEST/abtars-$DATE.zip" \
  config/ secret/ skills/ prompts/ tasks/ topics/ reports/ finance/ core/ \
  -x "config/.env.skills" 2>/dev/null || true

# Add abmind memory/core + sleep reports
cd "$ABMIND"
zip -qr "$DEST/abtars-$DATE.zip" \
  memory/core/ memory/sleep/ 2>/dev/null || true

# Add the WAL-safe DB copy
if [ -f "$DB_TMP" ]; then
  cd "$DEST"
  zip -qj "$DEST/abtars-$DATE.zip" "$DB_TMP"
  rm -f "$DB_TMP"
fi

# Encrypted DB backup
mkdir -p "$AB/backup"
DB_KEY="$AB/secret/db.key"
if [ -f "$DB_KEY" ] && [ -f "$DB" ]; then
  sqlite3 "$DB" ".backup '$AB/backup/memory.db.tmp'"
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$DB_KEY" \
    -in "$AB/backup/memory.db.tmp" -out "$AB/backup/memory.db.enc"
  rm -f "$AB/backup/memory.db.tmp"
fi

# Prune >7 days
find "$DEST" -name "abtars-*.zip" -mtime +7 -delete

# DoD: verify zip contains memory DB and is reasonable size
ZIP="$DEST/abtars-$DATE.zip"
if ! unzip -l "$ZIP" 2>/dev/null | grep -q "memory.*\.db"; then
  echo "ERROR: backup zip missing memory.db" >&2
  exit 1
fi
MIN_SIZE=100000  # 100KB minimum
ACTUAL=$(stat -f%z "$ZIP" 2>/dev/null || stat -c%s "$ZIP" 2>/dev/null || echo 0)
if [ "$ACTUAL" -lt "$MIN_SIZE" ]; then
  echo "ERROR: backup zip too small (${ACTUAL} bytes)" >&2
  exit 1
fi
