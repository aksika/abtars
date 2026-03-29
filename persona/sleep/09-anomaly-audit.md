# §7.5 Memory Anomaly Audit

Audit all extracted memories for attribute anomalies. Auto-fix confident cases, flag uncertain ones.

## Checks

### 1. Default attributes (never tagged)
```sql
SELECT id, substr(content_en,1,80), trust, credibility, integrity
FROM extracted_memories WHERE trust=0 AND credibility=6 AND integrity=2;
```
Auto-fix: `agentbridge-edit --memory-id <N> --trust 2 --credibility 3 --caller dreamy`

### 2. Decisions at classification=0
```sql
SELECT id, substr(content_en,1,80) FROM extracted_memories WHERE memory_type='decision' AND classification=0;
```
Auto-fix: `agentbridge-edit --memory-id <N> --classification 1 --caller dreamy`

### 3. Personal facts at low classification
Scan for content mentioning email addresses, health, finances, travel plans, relationships, family.
```sql
SELECT id, substr(content_en,1,100), classification FROM extracted_memories
WHERE classification < 2 AND (
  content_en LIKE '%@%.%' OR content_en LIKE '%health%' OR content_en LIKE '%medical%'
  OR content_en LIKE '%salary%' OR content_en LIKE '%bank%' OR content_en LIKE '%trip%'
  OR content_en LIKE '%relationship%' OR content_en LIKE '%family%'
);
```
Flag for review — needs human judgment on what's personal.

### 4. Trust mismatches
KP's own decisions/observations should be trust≥2:
```sql
SELECT id, substr(content_en,1,80), trust FROM extracted_memories
WHERE memory_type='decision' AND trust < 2;
```
Auto-fix: `agentbridge-edit --memory-id <N> --trust 2 --caller dreamy`

### 5. Stale credibility=6
Memories older than 7 days still at "unknown" credibility:
```sql
SELECT id, substr(content_en,1,80) FROM extracted_memories
WHERE credibility=6 AND created_at < (strftime('%s','now','-7 days') * 1000);
```
Auto-fix for trust≥2: `agentbridge-edit --memory-id <N> --credibility 3 --caller dreamy`

### 6. NULL embeddings
```sql
SELECT COUNT(*) FROM extracted_memories WHERE embedding IS NULL;
```
Auto-fix: `EMBEDDING_ENABLED=true agentbridge-embed`

### 7. Conflicting attributes
```sql
SELECT id, substr(content_en,1,80), trust, credibility FROM extracted_memories
WHERE (trust=3 AND credibility >= 5) OR (trust=0 AND classification >= 2);
```
Flag for review — contradictory signals.

Respond with: auto-fixed count, flagged count, details of flags.
