#!/bin/bash
DB=~/.agentbridge/memory/memory.db

echo "=== FTS table schema ==="
sqlite3 "$DB" ".schema messages_fts"

echo ""
echo "=== FTS table sample (first 3 rows) ==="
sqlite3 "$DB" "SELECT rowid, substr(content, 1, 80) FROM messages_fts LIMIT 3;"

echo ""
echo "=== Test: simple MATCH on 'jelszó' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"jelszó\"*';"

echo ""
echo "=== Test: simple MATCH on 'jelszo' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"jelszo\"*';"

echo ""
echo "=== Test: simple MATCH on 'kiskutya' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"kiskutya\"*';"

echo ""
echo "=== Test: simple MATCH on 'buzie' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"buzie\"*';"

echo ""
echo "=== Test: simple MATCH on 'centi' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"centi\"*';"

echo ""
echo "=== Test: simple MATCH on 'emlékezz' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"emlékezz\"*';"

echo ""
echo "=== Test: simple MATCH on 'chat' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"chat\"*';"

echo ""
echo "=== Test: simple MATCH on 'Hallom' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"Hallom\"*';"

echo ""
echo "=== Test: MATCH on 'fixálva' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"fixálva\"*';"

echo ""
echo "=== Test: MATCH on 'Elvileg' ==="
sqlite3 "$DB" "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"Elvileg\"*';"

echo ""
echo "=== FTS tokenize config ==="
sqlite3 "$DB" "SELECT sql FROM sqlite_master WHERE name = 'messages_fts';"
