---
name: memory-anomalies
description: Definitions of memory attribute anomalies and auto-fix rules for Dreamy audit
user-invocable: false
---

# Memory Anomaly Definitions

Reference for Dreamy's daily audit and review of flagged items.

## Auto-fix rules (Dreamy handles alone)

| Anomaly | Detection | Fix |
|---------|-----------|-----|
| Default attributes (never tagged) | trust=0 AND credibility=6 AND integrity=2 | trust=2, credibility=3 |
| Decisions at classification=0 | memory_type='decision' AND classification=0 | classification=1 |
| Self decisions at trust<2 | memory_type='decision' AND trust<2 | trust=2 |
| Stale credibility=6 (>7 days) | credibility=6 AND age>7d AND trust≥2 | credibility=3 |
| NULL embeddings | embedding IS NULL | run abmind embed |

## Flag-for-review rules (needs human judgment)

| Anomaly | Detection | Why flagged |
|---------|-----------|-------------|
| Personal content at low classification | content mentions health/finance/relationship AND user confirmed it's personal | Only flag if user context confirms — agent inference alone is not enough |
| Conflicting attributes | trust=3 + credibility≥5, or trust=0 + classification≥2 | Contradictory signals |
| Unknown patterns | Anything Dreamy hasn't seen before | Better safe than sorry |

### Classification escalation — key principle
Escalation comes from **user context**, not agent inference. Do NOT flag: operational emails, translations user asked for, business email mentions. DO flag: content user explicitly confirmed as personal/private.

## Classification scale
0=UNCLASSIFIED, 1=RESTRICTED, 2=CONFIDENTIAL, 3=SECRET

## Trust scale
0=untrusted (web), 1=peer (A2A), 2=self, 3=owner (aksika)

## Credibility scale
1=confirmed, 2=probably true, 3=possibly true, 4=doubtful, 5=improbable, 6=unknown
