# CIA + AAA Memory Security Model — AgentBridge

Created: 2026-03-20
Status: Mapping complete, implementation in progress
Framework: NATO Admiralty Code + NATO Classification + CIA Triad + AAA

---

## Theoretical Foundation

### NATO Admiralty Code (two-axis intelligence evaluation)

The Admiralty System (NATO System) evaluates intelligence on two independent axes:
- **Source Reliability** (A-F): How trustworthy is the source? (history, competency, authenticity)
- **Information Credibility** (1-6): How accurate is the information? (corroboration, logic, consistency)

Key principle: axes are evaluated independently — a reliable source can deliver doubtful info, an unreliable source can accidentally provide confirmed facts.

### Our adaptation: four per-memory fields

| Dimension | NATO/Military equivalent | KP field | Values |
|-----------|--------------------------|----------|--------|
| **Confidentiality** | NATO classification marking | `classification` | 0-3 (UNCLASSIFIED→SECRET) |
| **Source reliability** | Admiralty A-F | `trust` | 0-3 (untrusted→owner) |
| **Information credibility** | Admiralty 1-6 | `credibility` | 1-6 (confirmed→unknown) |
| **Provenance** | Intelligence cycle stage | `integrity` | verbatim→compacted |

---

## CIA Triad

### C — Confidentiality ✅ DONE (cb2296e)

**Question:** Who can see this memory?

| Field | `classification` |
|-------|-----------------|
| Type | INTEGER 0-3 |
| Default | 1 (RESTRICTED) |

| Level | NATO Label | Meaning |
|-------|-----------|---------|
| 0 | UNCLASSIFIED | Safe to share anywhere — general facts, common preferences |
| 1 | RESTRICTED | Default — operational memories, limited distribution |
| 2 | CONFIDENTIAL | Personal/sensitive — health, finances, relationships |
| 3 | SECRET | Tokens, credentials — NEVER disclosed |

**How it works in AgentBridge:**
- Per-memory field on `extracted_memories`
- Enforced at recall time: `COALESCE(classification, 1) <= maxClassification`
- SECRET (3) ALWAYS excluded — `Math.min(maxClassification, 2)` hard cap
- Context-based: DM=up to CONFIDENTIAL, group chat=UNCLASSIFIED only, A2A=UNCLASSIFIED only
- Reclassify with guard: SECRET cannot be lowered without `--user-override`
- Open web content forced to UNCLASSIFIED (R5)

### I — Integrity 📋 SPEC READY

**Question:** How far is this content from ground truth?

Two sub-dimensions (matching the Admiralty Code's separation of source vs information):

#### I.1 — Provenance (`integrity` field)

| Field | `integrity` |
|-------|------------|
| Type | TEXT enum |
| Default | 'extracted' |

| Value | Meaning | Reliability implication |
|-------|---------|----------------------|
| `verbatim` | User's exact words, unmodified | Highest — ground truth |
| `translated` | KP translated from original language | High — check `content_original` if ambiguous |
| `extracted` | KP summarized from conversation | Medium — agent interpretation, may lose nuance |
| `compacted` | KP merged multiple memories | Lowest — derived, furthest from source |

Language precedence: `content_original` > `content_en` (original is ground truth)

#### I.2 — Information Credibility (`credibility` field) — NEW

Adapted from NATO Admiralty Code information rating (1-6):

| Field | `credibility` |
|-------|--------------|
| Type | INTEGER 1-6 |
| Default | 6 (unknown) |

| Value | NATO equivalent | Meaning | KP example |
|-------|----------------|---------|------------|
| 1 | Confirmed | Corroborated by multiple sources | aksika said it + KP verified + matches other memories |
| 2 | Probably true | Logical, consistent, not confirmed | aksika said it, makes sense |
| 3 | Possibly true | Reasonable, single source | A2A agent reported it, plausible |
| 4 | Doubtful | Possible but no corroboration | Web article claims something unusual |
| 5 | Improbable | Contradicted by other memories | Conflicts with known facts |
| 6 | Unknown | No basis to evaluate | First mention, no context |

### A — Availability ⚙️ SYSTEM-LEVEL (no per-memory field)

**Question:** Can this memory be found when needed?

| Mechanism | What it ensures | Status |
|-----------|----------------|--------|
| 8-stage recall cascade | Memories found via multiple search strategies | ✅ Done |
| FTS5 dual-column (EN + original) | Bilingual search coverage | ✅ Done |
| `chat_backup` table | Immutable safety copy of raw messages | ✅ Done |
| JSONL transcripts | Append-only session logs | ✅ Done |
| `daily-backup.sh` | Nightly zip + git push | ✅ Done |
| Recall cascade refactor | Flip to extracted-first | 📋 Planned |
| Archive DB | Cold storage for zero-recall old memories | 📋 Future |

---

## AAA Framework

### Authentication — Who created this memory?

**Question:** Which entity wrote this, and can we verify it?

Adapted from NATO Admiralty Code source reliability (A-F):

| Field | `trust` |
|-------|--------|
| Type | INTEGER 0-3 |
| Default | 2 (self) |

| Trust | Label | NATO equivalent | Authentication basis |
|-------|-------|----------------|---------------------|
| 3 | owner | A (completely reliable) | aksika via Telegram DM — `ALLOWED_USER_IDS` whitelist |
| 2 | self | B (usually reliable) | KP's own extraction/observation |
| 1 | peer | C (fairly reliable) | A2A agents — known but autonomous |
| 0 | untrusted | E (unreliable) | Open web — no authentication |

### Authorization — Who can access this memory?

**Question:** Given the requester's context, are they allowed to see/use this?

| Mechanism | What it controls | Status |
|-----------|-----------------|--------|
| `classification` filter | Recall capped by context | ✅ Done |
| `ALLOWED_USER_IDS` | Only whitelisted users interact | ✅ Done |
| SECRET hard cap | classification=3 never returned | ✅ Done |
| Trust-based action gating | What KP can DO based on trust | 📋 Planned |

**Action gating rules:**

| Trust | Allowed actions |
|-------|----------------|
| 3 (owner) | Full authority — any action |
| 2 (self) | Act freely — KP trusts own observations |
| 1 (peer) | Non-destructive only — destructive requires owner confirmation |
| 0 (untrusted) | Never act — only report to owner |

### Accountability — Can we trace what happened?

**Question:** If something goes wrong, can we reconstruct who did what?

| Mechanism | What it records | Status |
|-----------|----------------|--------|
| `source_message_ids` | Which original messages a memory came from | ✅ Done |
| `agentbridge-expand` | Look up original messages by ID | ✅ Done |
| `integrity` field | How the content was derived | 📋 Spec ready |
| `credibility` field | How accurate the information is assessed to be | 📋 NEW |
| JSONL transcripts | Full raw conversation logs | ✅ Done |
| Sleep audit logs | What sleep subagent did | ✅ Done |
| `chat_backup` table | Immutable message copy (7-day) | ✅ Done |
| `recall_count` + `last_recalled_at` | Usage tracking | ✅ Done |

---

## Interaction Rules

- R1: trust=0 content NEVER triggers autonomous actions (prompt injection defense)
- R2: trust=1 content cannot trigger destructive actions without owner confirmation
- R3: trust can be escalated by owner only, never by content itself
- R4: trust NEVER overrides classification — owner trust (3) cannot bypass SECRET (3)
- R5: open web content = UNCLASSIFIED (0) + trust=0 + credibility≥4
- R6: conflicting memories — higher trust wins; if equal trust, higher credibility wins
- R7: original language (`content_original`) takes precedence over English translation
- R8: credibility can improve over time (corroboration) or degrade (contradiction found)

---

## Implementation Status

| Property | Field | Type | Status |
|----------|-------|------|--------|
| **Confidentiality** | `classification` | INTEGER 0-3 | ✅ Done |
| **Source reliability** | `trust` | INTEGER 0-3 | 📋 Spec ready |
| **Info credibility** | `credibility` | INTEGER 1-6 | 📋 NEW |
| **Provenance** | `integrity` | TEXT enum | 📋 Spec ready |
| **Availability** | system-level | — | ✅ Done |
| **Authentication** | trust + role + chat_id | — | 📋 Partial |
| **Authorization** | classification filter + gating | — | ✅ Partial |
| **Accountability** | source_ids + expand + logs | — | ✅ Done |

## Implementation Plan

### Stage 1 — Schema + Store (all 3 new fields)
- [ ] Schema: `trust INTEGER DEFAULT 2`, `integrity TEXT DEFAULT 'extracted'`, `credibility INTEGER DEFAULT 6`
- [ ] Types: add to `InstantStoreParams`
- [ ] Store CLI: `--trust 0-3`, `--integrity verbatim|translated|extracted|compacted`, `--credibility 1-6`
- [ ] Build + targeted tests

### Stage 2 — Auto-assignment
- [ ] Trust auto-defaults from context (TG DM=3, A2A=1, web=0)
- [ ] Integrity auto-defaults: `mergeMemories()` → compacted, sleep extraction → extracted/translated
- [ ] Credibility auto-defaults: owner-stated=2, extracted=3, web=4, first-mention=6
- [ ] Credibility upgrade: when a memory is corroborated by a new source, improve toward 1

### Stage 3 — Recall integration
- [ ] All 3 fields in SELECT + JSON output
- [ ] Ranking boost: Darwinism score × trust factor × credibility factor
- [ ] Recall hints for KP to reason about reliability

### Stage 4 — Action gating skill
- [ ] `skills/trust-gating/SKILL.md` — rules per trust level

### Stage 5 — Docs + tests
- [ ] Memory.asbuilt phase table + SPINUP update
- [ ] Classification skill cross-reference (NATO terms)
- [ ] Tests: schema, store, ranking, auto-defaults, merge, credibility upgrade
