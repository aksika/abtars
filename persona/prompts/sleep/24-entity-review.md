# §8m Entity Review

Scan ABM-L content_compressed for @reference anomalies.

## What to check

1. **Misassigned entities**: common words incorrectly tagged as @references
   - "March" (month) tagged as @march (person)
   - "Bridge" (concept) tagged as @bridge (project)

2. **Missing entities**: known names not tagged
   - "aksika" should be @user
   - "Molty" should be @agent
   - Project names should be @project-name

3. **Ambiguous entities**: same word used as both entity and concept
   - Check context to determine correct usage

## Process

```bash
agentbridge-recall --translated "" --chat-id 0 --pool core --limit 100
```

For each memory with content_compressed containing suspicious @references:
- If wrong: re-compress with corrected entity map
- If missing: re-compress to add the @reference

**Rules:**
- Only fix clear errors — don't over-tag
- When in doubt, leave as plain text
- Focus on core-tier memories (they appear in wake-up)
