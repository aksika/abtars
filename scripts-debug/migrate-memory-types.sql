-- Memory type reclassification: 4 → 6 types
-- Run: sqlite3 ~/.agentbridge/memory/memory.db < migrate-memory-types.sql

-- Preview changes
SELECT '=== BEFORE ===' AS info;
SELECT memory_type, COUNT(*) as cnt FROM extracted_memories GROUP BY memory_type ORDER BY cnt DESC;

-- Lessons: retro-extract mistakes/corrections (chat_id=0, negative emotion, "Don't"/"Never" pattern)
UPDATE extracted_memories SET memory_type = 'lesson'
WHERE chat_id = 0 AND memory_type IN ('decision', 'fact')
  AND emotion_score < 0
  AND (content_en LIKE 'Don''t %' OR content_en LIKE 'Never %' OR content_en LIKE 'Avoid %');

-- Preferences: "User prefers..." stored as decision
UPDATE extracted_memories SET memory_type = 'preference'
WHERE chat_id = 0 AND memory_type = 'decision'
  AND (content_en LIKE 'User prefers%' OR content_en LIKE 'User likes%' OR content_en LIKE 'User wants%');

-- Feedback: positive retro-extract about agent behavior
UPDATE extracted_memories SET memory_type = 'feedback'
WHERE chat_id = 0 AND memory_type = 'fact'
  AND emotion_score > 0
  AND (content_en LIKE '%appreciated%' OR content_en LIKE '%liked%' OR content_en LIKE '%good job%' OR content_en LIKE '%well done%' OR content_en LIKE '%happy%');

SELECT '=== AFTER ===' AS info;
SELECT memory_type, COUNT(*) as cnt FROM extracted_memories GROUP BY memory_type ORDER BY cnt DESC;
