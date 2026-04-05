-- Memory type reclassification: 4 → 6 types
-- Run: sqlite3 ~/.agentbridge/memory/memory.db < migrate-memory-types.sql

SELECT '=== BEFORE ===' AS info;
SELECT memory_type, COUNT(*) as cnt FROM extracted_memories GROUP BY memory_type ORDER BY cnt DESC;

-- Lessons: mistakes/corrections (negative emotion + "Don't"/"Never"/"Avoid"/"Be honest"/"Ask instead")
UPDATE extracted_memories SET memory_type = 'lesson'
WHERE memory_type = 'decision' AND emotion_score < 0
  AND (content_en LIKE 'Don''t %' OR content_en LIKE 'Never %' OR content_en LIKE 'Avoid %'
    OR content_en LIKE 'Be honest%' OR content_en LIKE 'Ask instead%'
    OR content_en LIKE 'Use appropriate%' OR content_en LIKE 'Apply %consistently%'
    OR content_en LIKE 'Follow %rules%');

-- Preferences: "User prefers..." stored as decision
UPDATE extracted_memories SET memory_type = 'preference'
WHERE memory_type = 'decision'
  AND (content_en LIKE 'User prefers%' OR content_en LIKE 'User likes%' OR content_en LIKE 'User wants%');

-- Feedback: positive emotion about agent behavior
UPDATE extracted_memories SET memory_type = 'feedback'
WHERE memory_type = 'fact' AND emotion_score > 0
  AND (content_en LIKE '%appreciated%' OR content_en LIKE '%liked%' OR content_en LIKE '%good job%'
    OR content_en LIKE '%well done%' OR content_en LIKE '%happy%' OR content_en LIKE '%impressed%');

SELECT '=== AFTER ===' AS info;
SELECT memory_type, COUNT(*) as cnt FROM extracted_memories GROUP BY memory_type ORDER BY cnt DESC;
