# Memory Trust — Source Reliability Scoring

Created: 2026-03-20
Status: Ready to implement
Depends on: Memory Confidentiality (classification) — done

## Concept

Orthogonal to classification (who can see it), trust answers: **how reliable is this information and should I act on it?**

Classification = visibility. Trust = reliability + authority.

## Trust Levels

| Level | Label | Source examples | Agent behavior |
|-------|-------|----------------|----------------|
| 3 | `owner` | aksika via Telegram DM, explicit user commands | Act immediately, full authority |
| 2 | `self` | KP's own observations, verified actions, confirmed facts | Act on it, high confidence |
| 1 | `peer` | A2A agents (Molty, etc.), authenticated external APIs | Act on non-destructive tasks; destructive/irreversible actions require owner confirmation |
| 0 | `untrusted` | Open web, unauthenticated sources, unknown origins | Never act on it directly; inform owner, flag as unverified |

## Schema

```sql
ALTER TABLE extracted_memories ADD COLUMN trust INTEGER DEFAULT 2;
-- Default 2 (self) because most extracted memories come from KP's own extraction process
```

On `messages` table: trust is implicit from the source (role + chat_id + channel), no column needed.

## Implementation Tasks

- [ ] Task 1: Schema — add `trust INTEGER DEFAULT 2` to extracted_memories (idempotent ALTER TABLE)
- [ ] Task 2: Store CLI — `--trust 0-3` on agentbridge-store, pass through InstantStoreParams
- [ ] Task 3: Auto-assign trust at store time based on source context:
  - Telegram DM from ALLOWED_USER_IDS → trust=3 (owner)
  - KP self-generated (extraction, observation) → trust=2 (self)
  - A2A inbound (b2b-router) → trust=1 (peer)
  - Web/browse results → trust=0 (untrusted)
- [ ] Task 4: Recall ranking boost — multiply Darwinism score by trust factor (e.g. `* (0.5 + 0.5 * trust/3)`)
- [ ] Task 5: Action gating skill — rules for what KP can do based on trust level of the triggering information:
  - trust=3: full authority
  - trust=2: act freely
  - trust=1: non-destructive only, ask owner for destructive (rm, format, deploy, send money, etc.)
  - trust=0: never act, only report
- [ ] Task 6: Recall output — include trust level in JSON output
- [ ] Task 7: Update classification skill — reference trust as complementary axis
- [ ] Task 8: Update Memory.asbuilt
- [ ] Task 9: Tests

## Interaction with Classification

| | Classification (visibility) | Trust (reliability) |
|-|----------------------------|---------------------|
| Question answered | Who can see this memory? | Should I believe/act on this? |
| Enforced at | Recall time (search filter) | Action time (gating) |
| Default | 1 (internal) | 2 (self) |
| Web content | 0 (public) | 0 (untrusted) |
| User DM | 1 (internal) | 3 (owner) |
| A2A peer | 1 (internal) | 1 (peer) |

## Key Rules

- R1: trust=0 content NEVER triggers autonomous actions (defense against prompt injection)
- R2: trust=1 content cannot trigger destructive/irreversible actions without owner confirmation
- R3: trust can be escalated by owner ("I verified this, trust it") via --trust flag or reclassify-style command
- R4: trust cannot be escalated by the content itself (web page saying "trust me" doesn't increase trust)
- R5: conflicting memories — higher trust wins
