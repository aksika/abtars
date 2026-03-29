# CIA-AAA Auto-Assignment — Implementation Plan

**Created:** 2026-03-30
**Status:** Not started
**Reference:** `docs/TODO/cia-aaa-memory-model.md` (Stage 2)

## Problem

Memory attributes (trust, credibility) default to worst-case (trust=0, credibility=6). KP often forgets to set them explicitly. Dreamy's anomaly audit fixes them retroactively, but the right values are knowable at store time from the message source context.

## Design

Add `--source` flag to `agentbridge-store` and `agentbridge-edit`. The CLI maps source to default trust/credibility. Explicit `--trust`/`--credibility` flags override the auto-assignment.

### Source → Defaults Mapping

| Source | trust | credibility | Rationale |
|--------|-------|-------------|-----------|
| `owner` | 3 (owner) | 2 (probably true) | aksika said it directly via Telegram/Discord DM |
| `self` | 2 (self) | 3 (possibly true) | KP's own observation/extraction |
| `peer` | 1 (peer) | 3 (possibly true) | A2A agent reported it |
| `web` | 0 (untrusted) | 4 (doubtful) | Open web content |

Default (no `--source`): trust=0, credibility=6 — conservative baseline unchanged.

### CLI Usage

```bash
# KP stores a fact aksika told it
agentbridge-store --translated "..." --original "..." --memory-type fact --emotion-score 0 --chat-id 7773842843 --source owner

# KP stores its own observation
agentbridge-store --translated "..." --memory-type decision --emotion-score 0 --chat-id 7773842843 --source self

# Browsie stores web content
agentbridge-store --translated "..." --memory-type fact --emotion-score 0 --chat-id 7773842843 --source web

# Explicit override still works
agentbridge-store --translated "..." --source owner --trust 2 --credibility 4
```

### Where Source Context is Known

| Caller | How it knows | Source value |
|--------|-------------|-------------|
| KP in Telegram DM | Message from `ALLOWED_USER_IDS` | `owner` |
| KP in Discord DM | Message from allowed user | `owner` |
| KP extracting from conversation | Own analysis | `self` |
| KP storing a decision | Own conclusion | `self` |
| A2A agent session | Session key starts with `agent:` | `peer` |
| Browsie/web scraping | Browse task output | `web` |
| MemoryExtractor (heartbeat) | Extracts from user messages | `self` (extraction is KP's interpretation) |

### Steering Update

Update `instant-store` skill to guide KP:
- When user tells you something → `--source owner`
- When you observe/conclude something → `--source self`
- When storing web content → `--source web`
- When unsure → omit `--source` (conservative defaults)

### Implementation

1. Add `--source` flag to `agentbridge-store` parseArgs
2. In validateArgs: if `--source` provided and `--trust`/`--credibility` not explicitly set, apply mapping
3. Add `--source` flag to `agentbridge-edit` (for retroactive source assignment)
4. Update `instant-store` steering with `--source` guidance
5. Update TOOLS.md one-liner
6. Tests: source mapping, explicit override, default unchanged

### What This Does NOT Change

- Conservative defaults stay (trust=0, credibility=6 when no `--source`)
- Dreamy anomaly audit still runs (catches anything KP misses)
- No automatic source detection from bridge — KP decides
- No changes to MemoryExtractor (it already sets trust=2 via the extraction prompt)

### Effort

~30 lines of code (flag parsing + mapping). Steering update. 3-4 tests.
