#!/usr/bin/env bash
set -euo pipefail

# Integration test: run one sleep cycle on a copy of the live DB and diff the results.
# Usage:
#   bash scripts/test-sleep-gc.sh          # Step 1: copy DB + pre-snapshot
#   (run sleep cycle against /tmp/agentbridge-gc-test/memory/)
#   bash scripts/test-sleep-gc.sh --diff   # Step 2: post-snapshot + diff

AB="$HOME/.agentbridge"
TEST_DIR="/tmp/agentbridge-gc-test"
DB="$TEST_DIR/memory/memory.db"

if [ "${1:-}" = "--diff" ]; then
  if [ ! -f "$DB" ]; then
    echo "❌ No test DB. Run without --diff first."
    exit 1
  fi
  echo "=== POST-SLEEP SNAPSHOT ==="
  echo "Messages:           $(sqlite3 "$DB" 'SELECT COUNT(*) FROM messages;')"
  echo "  user:             $(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE role='user';")"
  echo "  assistant:        $(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE role='assistant';")"
  echo "Extracted memories: $(sqlite3 "$DB" 'SELECT COUNT(*) FROM extracted_memories;')"
  echo "FTS entries:        $(sqlite3 "$DB" 'SELECT COUNT(*) FROM messages_fts;')"

  sqlite3 "$DB" "SELECT id, role, substr(content,1,80) FROM messages ORDER BY id;" > "$TEST_DIR/post_messages.txt"
  sqlite3 "$DB" "SELECT id, emotion_score, substr(content_en,1,80) FROM extracted_memories ORDER BY id;" > "$TEST_DIR/post_memories.txt"

  echo ""
  echo "=== MESSAGES DIFF ==="
  echo "--- Deleted messages:"
  diff "$TEST_DIR/pre_messages.txt" "$TEST_DIR/post_messages.txt" | grep '^<' | head -50 || echo "(none)"
  echo ""
  echo "--- New messages:"
  diff "$TEST_DIR/pre_messages.txt" "$TEST_DIR/post_messages.txt" | grep '^>' | head -20 || echo "(none)"

  echo ""
  echo "=== EMOTION SCORE CHANGES ==="
  diff "$TEST_DIR/pre_memories.txt" "$TEST_DIR/post_memories.txt" || echo "(no changes)"

  echo ""
  echo "=== GARBAGE.JSON ==="
  if [ -f "$TEST_DIR/memory/garbage.json" ]; then
    echo "Entries: $(python3 -c "import json; print(len(json.load(open('$TEST_DIR/memory/garbage.json'))))" 2>/dev/null || echo "?")"
    cat "$TEST_DIR/memory/garbage.json"
  else
    echo "(not created)"
  fi

  echo ""
  echo "=== FTS INTEGRITY ==="
  FTS_COUNT=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM messages_fts;')
  MSG_COUNT=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM messages;')
  if [ "$FTS_COUNT" = "$MSG_COUNT" ]; then
    echo "✅ FTS in sync ($FTS_COUNT = $MSG_COUNT)"
  else
    echo "❌ FTS mismatch: FTS=$FTS_COUNT, messages=$MSG_COUNT"
  fi
  exit 0
fi

# --- Step 1: Copy + pre-snapshot ---
DB_SRC="$AB/memory/memory.db"

if [ ! -f "$DB_SRC" ]; then
  echo "❌ No live DB at $DB_SRC"
  exit 1
fi

rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/memory"

sqlite3 "$DB_SRC" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
cp "$DB_SRC" "$DB"

echo "=== PRE-SLEEP SNAPSHOT ==="
echo "Messages:           $(sqlite3 "$DB" 'SELECT COUNT(*) FROM messages;')"
echo "  user:             $(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE role='user';")"
echo "  assistant:        $(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE role='assistant';")"
echo "Extracted memories: $(sqlite3 "$DB" 'SELECT COUNT(*) FROM extracted_memories;')"
echo "FTS entries:        $(sqlite3 "$DB" 'SELECT COUNT(*) FROM messages_fts;')"

sqlite3 "$DB" "SELECT id, role, substr(content,1,80) FROM messages ORDER BY id;" > "$TEST_DIR/pre_messages.txt"
sqlite3 "$DB" "SELECT id, emotion_score, substr(content_en,1,80) FROM extracted_memories ORDER BY id;" > "$TEST_DIR/pre_memories.txt"

echo ""
echo "Test DB ready at: $DB"
echo "Run GC against it, then: bash $0 --diff"
