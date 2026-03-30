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
Scan for content that the **user explicitly confirmed as personal/private**.

**DO flag** (needs escalation to CONFIDENTIAL):
- Health, medical, financial details **confirmed by user**
- Travel plans, relationship details **confirmed by user**
- Content user explicitly marked as personal/private ("keep this private", "titkos")

**Do NOT flag** (classification=1 is correct):
- Internal operational emails (newsletter subscriptions, tool confirmations)
- Content where user asked for translation/explanation but didn't confirm a personal plan
- General facts that mention an email address used for business
- Agent's own inference about what might be personal — inference alone is not enough to escalate

**Key principle:** Classification escalation comes from user context, not agent inference. If the user didn't confirm something as personal, keep current classification.

```sql
SELECT id, substr(content_en,1,100), classification FROM extracted_memories
WHERE classification < 2 AND (
  content_en LIKE '%health%' OR content_en LIKE '%medical%'
  OR content_en LIKE '%salary%' OR content_en LIKE '%bank%'
  OR content_en LIKE '%relationship%'
)
LIMIT 10;
```
Flag for review only if user context confirms it's personal.

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
