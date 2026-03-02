-- What does FTS5 return for "jelszó"?
SELECT m.id, m.role, substr(m.content, 1, 80), rank
FROM messages m
JOIN messages_fts ON messages_fts.rowid = m.id
WHERE messages_fts MATCH '"jelszo"*' AND m.chat_id = 7773842843
ORDER BY rank ASC LIMIT 10;

-- What about "jelszót"?
SELECT '---jelszót---';
SELECT m.id, m.role, substr(m.content, 1, 80), rank
FROM messages m
JOIN messages_fts ON messages_fts.rowid = m.id
WHERE messages_fts MATCH '"jelszót"*' AND m.chat_id = 7773842843
ORDER BY rank ASC LIMIT 10;

-- What about "faszajelszót"?
SELECT '---faszajelszót---';
SELECT m.id, m.role, substr(m.content, 1, 80), rank
FROM messages m
JOIN messages_fts ON messages_fts.rowid = m.id
WHERE messages_fts MATCH '"faszajelszót"*' AND m.chat_id = 7773842843
ORDER BY rank ASC LIMIT 10;

-- What about "buzie"?
SELECT '---buzie---';
SELECT m.id, m.role, substr(m.content, 1, 80), rank
FROM messages m
JOIN messages_fts ON messages_fts.rowid = m.id
WHERE messages_fts MATCH '"buzie"*' AND m.chat_id = 7773842843
ORDER BY rank ASC LIMIT 10;

-- What about "kiskutya"?
SELECT '---kiskutya---';
SELECT m.id, m.role, substr(m.content, 1, 80), rank
FROM messages m
JOIN messages_fts ON messages_fts.rowid = m.id
WHERE messages_fts MATCH '"kiskutya"*' AND m.chat_id = 7773842843
ORDER BY rank ASC LIMIT 10;

-- What about "centi"?
SELECT '---centi---';
SELECT m.id, m.role, substr(m.content, 1, 80), rank
FROM messages m
JOIN messages_fts ON messages_fts.rowid = m.id
WHERE messages_fts MATCH '"centi"*' AND m.chat_id = 7773842843
ORDER BY rank ASC LIMIT 10;

-- FTS tokenizer config
SELECT '---FTS config---';
SELECT sql FROM sqlite_master WHERE name = 'messages_fts';
