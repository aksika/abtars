# Memory Confidentiality (ISO 27001 Classification)

Created: 2026-03-20
Status: DONE

## Classification Levels

| Level | Label          | Default | Description |
|-------|----------------|---------|-------------|
| 0     | `public`       | no      | Safe to surface anywhere — general facts, preferences |
| 1     | `internal`     | yes     | Normal operational memories — default for all new memories |
| 2     | `confidential` | no      | Sensitive personal info — health, finances, relationships |
| 3     | `restricted / secret` | no      | Tokens, credentials, security-critical — **never disclosed** |

## Core Rules

### R1: Restricted is a black hole
- Restricted memories are stored but **never returned by recall**.
- The agent must never reveal restricted content in any response, summary, or hint.
- Restricted memories are excluded from sleep consolidation, compaction, and merge.

### R2: Restricted is permanent
- The agent **cannot** declassify a restricted memory (level 3 → anything lower).
- Only the user can declassify restricted memories via explicit CLI command.
- The agent **can** freely reclassify between public (0), internal (1), and confidential (2).

### R3: Auto-classification triggers
The agent must classify as **restricted** when:
- The user explicitly says "this is secret", "keep this secret", "don't share this", or similar intent.
- The memory contains a token, API key, password, credential, or secret key pattern.
- The user instructs the agent to implement something using a provided token/secret.

### R4: Recall filtering
- `agentbridge-recall` accepts `--max-classification <0-2>` (default: 2 = confidential).
- Restricted (3) is **always excluded** regardless of max-classification param.
- Context-based defaults:
  - Group Discord chat: max 0 (public only)
  - Direct Telegram: max 2 (up to confidential)
  - Sleep agent: max 2 (never sees restricted)
  - CLI direct query: max 2 (never sees restricted)

### R5: Reclassification
- `agentbridge-store --reclassify --id <N> --classification <level>`
- Agent can set 0/1/2 freely on any non-restricted memory.
- Agent can escalate any memory TO restricted (0/1/2 → 3).
- Agent **cannot** set level < 3 on a memory that is currently 3.
- User override: `agentbridge-store --reclassify --id <N> --classification <level> --user-override` bypasses the restriction.

## Implementation Tasks

- [x] Task 1: Schema — `classification INTEGER DEFAULT 1` column on `extracted_memories` (idempotent ALTER TABLE)
- [x] Task 2: `--classification <0-3>` flag on `agentbridge-store` (store path)
- [x] Task 3: `--reclassify --id <N> --classification <level>` path on `agentbridge-store`
- [x] Task 4: `reclassifyMemory(id, level, userOverride)` on MemoryManager — enforces R2
- [x] Task 5: `--max-classification <0-2>` on `agentbridge-recall` — filter in searchExtracted/searchOriginal WHERE clause
- [x] Task 6: searchExtracted/searchOriginal add `WHERE classification <= ?` filter (restricted always excluded)
- [x] Task 7: Sleep prompt update — instruct sleep agent to never process restricted memories, pass --max-classification 2
- [x] Task 8: Steering skill file for the agent — classification rules, auto-triggers, examples
- [x] Task 9: Tests — reclassify enforcement (R2), recall filtering, auto-exclusion of restricted
