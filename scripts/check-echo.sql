SELECT count(*) FROM messages WHERE role = 'assistant' AND (content LIKE '- [user]%' OR content LIKE '%[INPUT]%');
