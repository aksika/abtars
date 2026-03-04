-- Count before cleanup
SELECT 'Before: ' || count(*) || ' echo-polluted assistant messages' FROM messages WHERE role = 'assistant' AND (content LIKE '- [user]%' OR content LIKE '- [assistant]%' OR content LIKE '%[INPUT]%');

-- Delete the polluted assistant messages
DELETE FROM messages WHERE role = 'assistant' AND (content LIKE '- [user]%' OR content LIKE '- [assistant]%' OR content LIKE '%[INPUT]%');

-- Count after cleanup
SELECT 'After: ' || count(*) || ' total messages remaining' FROM messages WHERE chat_id = 7773842843;
SELECT 'Of which ' || count(*) || ' are assistant messages' FROM messages WHERE chat_id = 7773842843 AND role = 'assistant';
