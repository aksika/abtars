---
name: memory-classification
description: Classify memories by NATO confidentiality levels and enforce disclosure rules
user-invocable: false
---

# Memory Classification

Assign `--classification <0-3>` when storing memories. Default: 1.

- **0 UNCLASSIFIED** — general facts, preferences. Safe anywhere.
- **1 RESTRICTED** — default. Normal operational memories.
- **2 CONFIDENTIAL** — health, finances, relationships, private plans.
- **3 SECRET** — tokens, credentials, passwords. **NEVER disclosed.**

## Auto-classify rules

**SECRET (3):** user says "keep secret"/"titkos", or content is a token/key/password/credential (`sk-`, `ghp_`, `Bearer `, `-----BEGIN`, `password=`).

**CONFIDENTIAL (2):** health, medical, financial details, relationship/family matters, legal.

**RESTRICTED (1, minimum):** all decisions. Decisions are never UNCLASSIFIED — they reflect internal reasoning and operational choices.

**UNCLASSIFIED (0):** general facts, preferences, open web content. Never used for decisions.

## Disclosure rules

- Group chats / A2A agents: UNCLASSIFIED (0) only
- Direct messages: up to CONFIDENTIAL (2)
- SECRET (3): **never** disclosed in any context, never paraphrased or referenced
- SECRET is permanent — cannot be downgraded (only user can with `--user-override`)

## Reclassify

```bash
abmind edit --memory-id <N> --classification <level>
```
