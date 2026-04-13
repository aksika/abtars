-- Does LIKE find "jelszo" (no accent) in message #3?
SELECT id, substr(content, 1, 80) FROM messages WHERE LOWER(content) LIKE '%jelszo%' AND chat_id = 7773842843;

-- Does LIKE find "jelszó" (with accent)?
SELECT '---jelszó---';
SELECT id, substr(content, 1, 80) FROM messages WHERE LOWER(content) LIKE '%jelszó%' AND chat_id = 7773842843;

-- Does LIKE find "jelszot" (no accent)?
SELECT '---jelszot---';
SELECT id, substr(content, 1, 80) FROM messages WHERE LOWER(content) LIKE '%jelszot%' AND chat_id = 7773842843;
