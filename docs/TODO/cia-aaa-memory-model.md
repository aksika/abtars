# CIA + AAA Memory Security Model — AgentBridge

Created: 2026-03-20
Status: Mapping complete, implementation in progress

## The Model

Applying the extended CIA triad + AAA framework to per-memory security in an autonomous agent system.

---

## CIA Triad

### C — Confidentiality ✅ DONE (cb2296e)

**Question:** Who can see this memory?

| Field | `classification` |
|-------|-----------------|
| Type | INTEGER 0-3 |
| Default | 1 (internal) |
| Levels | 0=public, 1=internal, 2=confidential, 3=restricted |

**How it works in AgentBridge:**
- Per-memory field on `extracted_memories`
- Enforced at recall time: `COALESCE(classification, 1) <= maxClassification`
- Restricted (3) ALWAYS excluded — `Math.min(maxClassification, 2)` hard cap
- Context-based: DM=up to 2, group chat=0, A2A=0
- Reclassify with guard: restricted cannot be lowered without `--user-override`
- Skill: `skills/classification/SKILL.md` — auto-trigger rules (tokens, health, secrets)
- Open web content forced to class 0 (R5)

### I — Integrity 📋 SPEC READY (memory-trust.md)

**Question:** How far is this content from ground truth?

| Field | `integrity` |
|-------|------------|
| Type | TEXT enum |
| Default | 'extracted' |
| Values | verbatim, translated, extracted, compacted |

**How it maps to AgentBridge:**

| Value | When | Example |
|-------|------|---------|
| `verbatim` | User's exact words stored unmodified | aksika says "I prefer dark mode" → stored as-is |
| `translated` | KP translated from Hungarian to English | "szeretem a sötét módot" → "I like dark mode" |
| `extracted` | Sleep subagent summarized from conversation | 5 messages about dark mode → "User prefers dark mode" |
| `compacted` | `mergeMemories()` combined multiple memories | 3 dark mode memories → 1 merged memory |

**Trust precedence:** verbatim > translated > extracted > compacted
**Language precedence:** `content_original` > `content_en` (original is ground truth)

### A — Availability ⚙️ SYSTEM-LEVEL (no per-memory field)

**Question:** Can this memory be found when needed?

Not a per-memory field — it's an architectural property:

| Mechanism | What it ensures | Status |
|-----------|----------------|--------|
| 8-stage recall cascade | Memories found via multiple search strategies | ✅ Done |
| FTS5 dual-column (EN + original) | Bilingual search coverage | ✅ Done |
| `chat_backup` table | Immutable safety copy of raw messages | ✅ Done |
| JSONL transcripts | Append-only session logs, never lost | ✅ Done |
| `daily-backup.sh` | Nightly zip + git push to backup repo | ✅ Done |
| Recall cascade refactor (future) | Flip to extracted-first, improve hit rate | 📋 Planned |
| Archive DB (future) | Cold storage for zero-recall old memories | 📋 Future idea |

---

## AAA Framework

### Authentication — Who created this memory?

**Question:** Which entity wrote this, and can we verify it?

| Signal | Source | Status |
|--------|--------|--------|
| `role` on messages | user / assistant / system | ✅ Done |
| `chat_id` | Which channel/conversation | ✅ Done |
| `source_message_ids` | Trace back to original messages | ✅ Done |
| `trust` field (NEW) | Source reliability: 0=untrusted, 1=peer, 2=self, 3=owner | 📋 Spec ready |

**How trust maps to authentication in AgentBridge:**

| Trust | Source | Authentication basis |
|-------|--------|---------------------|
| 3 (owner) | aksika via Telegram DM | `ALLOWED_USER_IDS` whitelist — cryptographically authenticated by Telegram |
| 2 (self) | KP's own extraction/observation | Agent's own process — trusted by definition |
| 1 (peer) | A2A agents (Molty, etc.) | B2B router — known agent, but autonomous |
| 0 (untrusted) | Open web, browse results | No authentication — anyone could have written it |

### Authorization — Who can access this memory?

**Question:** Given the requester's context, are they allowed to see/use this?

| Mechanism | What it controls | Status |
|-----------|-----------------|--------|
| `classification` filter | Recall results capped by context (DM=2, group=0, A2A=0) | ✅ Done |
| `ALLOWED_USER_IDS` | Only whitelisted users can interact at all | ✅ Done |
| Restricted hard cap | classification=3 never returned regardless of caller | ✅ Done |
| Trust-based action gating (NEW) | What KP can DO based on trust of triggering info | 📋 Planned |

**Action gating rules (to implement):**

| Trust | Allowed actions |
|-------|----------------|
| 3 (owner) | Full authority — any action |
| 2 (self) | Act freely — KP trusts own observations |
| 1 (peer) | Non-destructive only — destructive requires owner confirmation |
| 0 (untrusted) | Never act — only report to owner |

### Accountability — Can we trace what happened?

**Question:** If something goes wrong, can we reconstruct who did what and when?

| Mechanism | What it records | Status |
|-----------|----------------|--------|
| `source_message_ids` | Which original messages a memory came from | ✅ Done |
| `agentbridge-expand` | Look up original messages by ID | ✅ Done |
| `integrity` field (NEW) | How the content was derived (verbatim→compacted) | 📋 Spec ready |
| JSONL transcripts | Full raw conversation logs | ✅ Done |
| Sleep audit logs | What the sleep subagent did (GC, extraction, merge) | ✅ Done |
| `chat_backup` table | Immutable copy of messages (7-day retention) | ✅ Done |
| `recall_count` + `last_recalled_at` | When and how often a memory was used | ✅ Done |
| `created_at` + `source_timestamp` | When stored vs when the original event happened | ✅ Done |

---

## Implementation Status

| Property | Field/Mechanism | Status |
|----------|----------------|--------|
| **Confidentiality** | `classification` (0-3) | ✅ Done |
| **Integrity** | `integrity` (verbatim/translated/extracted/compacted) | 📋 Spec ready |
| **Availability** | Cascade + backup + transcripts | ✅ System-level done |
| **Authentication** | `trust` (0-3) + role + chat_id | 📋 Spec ready |
| **Authorization** | classification filter + action gating | ✅ Partial (gating planned) |
| **Accountability** | source_ids + expand + transcripts + audit | ✅ Done |

## Implementation Plan

### Stage 1 — Schema + Store (trust + integrity fields)
- [ ] Schema migration: `trust INTEGER DEFAULT 2`, `integrity TEXT DEFAULT 'extracted'`
- [ ] Types: add to `InstantStoreParams`
- [ ] Store CLI: `--trust 0-3`, `--integrity verbatim|translated|extracted|compacted`
- [ ] Build + targeted tests

### Stage 2 — Auto-assignment
- [ ] Store auto-defaults: infer trust from context (TG DM=3, A2A=1, web=0)
- [ ] `mergeMemories()` → integrity=compacted
- [ ] Sleep template: instruct subagent to pass integrity value

### Stage 3 — Recall integration
- [ ] trust + integrity in SELECT + JSON output
- [ ] Ranking boost: Darwinism score × trust factor
- [ ] Recall hints for KP to reason about reliability

### Stage 4 — Action gating skill
- [ ] `skills/trust-gating/SKILL.md` — rules per trust level

### Stage 5 — Docs + tests
- [ ] Memory.asbuilt phase table update
- [ ] Classification skill cross-reference
- [ ] Tests: schema, store, ranking, auto-defaults, merge
