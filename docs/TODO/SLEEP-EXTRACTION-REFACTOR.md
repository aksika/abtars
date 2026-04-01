# Sleep Extraction Refactor Plan

> Research: OpenClaw (compaction.ts), Hermes-agent (trajectory_compressor.py), Lossless-claw (compaction.ts)

## Overview

Replace unreliable LLM-does-SQL extraction with code-driven batched summarization + extraction from daily summary.

## New sleep step order

```
00 - identity
01 - retrospective
02 - feedback
03 - reminders
04a - daily-summary        ← NEW (code-driven, accumulating batches)
04b - extract-from-daily   ← NEW (code-driven, reads daily file)
04c - gc-noise-from-daily  ← REWORKED (daily summary as truth filter)
06  - cron-verify
08a - darwinism
08b - core-knowledge
08c - translation-check
09  - anomaly-audit
10  - retro-extract
11  - merge
12  - consolidation         ← SIMPLIFIED (weekly/quarterly rollups only)
13  - media-cleanup
14  - report
```

## Transport profile config

```env
AGENT_SLEEP_MODEL=minimax-m2.5
AGENT_SLEEP_CTX_WINDOW=128000
```

Batch budget derived: `ctx_window * 0.4` (OpenClaw's BASE_CHUNK_RATIO).

## Step 04a: daily-summary (code-driven)

### Token estimation (universal across OpenClaw/Hermes/Lossless-claw)
- `estimateTokens(text) = Math.ceil(text.length / 4)`
- Safety margin: 1.2x (20% buffer for estimation inaccuracy)
- Summarization overhead: 4096 tokens reserved for prompt + response
- Effective batch budget: `(ctx_window * 0.4) - 4096`

### Pre-processing: strip media payloads (from Lossless-claw)
Before summarization, strip binary/media content from messages:
- Remove base64 data URLs: `data:[type];base64,...` → `[embedded media omitted]`
- Remove `MEDIA:/...` file path references → skip
- Detect binary payloads (long base64-like strings with no prose) → skip
- Annotate media-only messages: `[Media attachment]`
- Annotate mixed messages: `original text [with media attachment]`

Prevents images/files from consuming the summary token budget.

### Dynamic batch sizing
```
total_tokens = estimate(all stripped messages) * 1.2
effective_budget = (AGENT_SLEEP_CTX_WINDOW * 0.4) - 4096

if total_tokens < AGENT_SLEEP_CTX_WINDOW * 0.7:
    → single shot, no batching
else:
    → chunk messages until estimated tokens > effective_budget
    → accumulating summary approach
```

### Accumulating summary flow (confirmed by Lossless-claw's `previousSummary` pattern)
```
Code reads all messages from DB (since last watermark)
Strip media payloads from each message

Batch 1: first N messages (fit in budget) → model writes Summary A
Batch 2: Summary A + next N messages → model writes Summary B
Batch 3: Summary B + next N messages → Summary C
...
Final summary → write daily/daily_YYYYMMDD.md
```

Each batch gets a fresh ACP session (no context buildup from previous batches).

### Summary capping (from Lossless-claw)
If model produces a summary exceeding `targetTokens * 3` (summaryMaxOverageFactor), hard-cap by truncation with `[Capped from N tokens to ~M]` suffix. Prevents runaway summaries from growing the accumulator unboundedly.

### Three-level escalation (from Lossless-claw)
If normal summarization produces output >= input tokens:
1. **Normal**: standard prompt
2. **Aggressive**: add "be more concise, focus on key facts only"
3. **Fallback**: deterministic truncation (first 2048 chars + `[Truncated from N tokens]`)

Never fails — always produces a summary.

### Batch prompt template
```
Here is the running summary of today's conversations:
---
<previous summary or "No previous summary — this is the first batch.">
---

Here are the next messages (chronological):
---
<[user] message text
[assistant] response text
...>
---

Update the summary incorporating these new messages.

MUST PRESERVE:
- Topics discussed and their outcomes
- Decisions made and rationale
- User preferences expressed (explicit or implicit)
- How the user wants things done (workflows, habits)
- Events and milestones
- Emotional moments (frustration, excitement, humor)
- Technical details worth remembering
- Active tasks and their status
- Open questions and follow-ups
- All identifiers exactly (UUIDs, IPs, paths, names)

SKIP:
- Greetings, filler, small talk
- Debugging noise, tool execution details
- Transient errors and temporary states
```

## Step 04b: extract-from-daily (code-driven)

```
Code reads daily/daily_YYYYMMDD.md
New ACP session → send extraction prompt → model calls agentbridge-store → destroy session
```

### Extraction prompt
```
Here is today's conversation summary:
---
<daily file content>
---

For EVERY meaningful point, store a memory using agentbridge-store:

agentbridge-store --translated "English" --original "original if known"
  --memory-type <fact|decision|preference|event>
  --emotion-score <-5 to +5> --chat-id 7773842843

Store:
- Facts about the user, their setup, people, life
- Decisions made (technical choices, configs, plans)
- Preferences ("I prefer X", "don't do Z")
- How the user wants things done
- Events and milestones
- Lessons learned

When in doubt, store it — dedup happens later.
```

## Step 04c: gc-noise-from-daily (code-driven)

```
Code reads daily summary + raw message IDs with first 80 chars
New ACP session → model identifies messages NOT represented in summary → mark as garbage
```

Garbage-marked messages flushed after 12h (next sleep cycle).

## Message retention

- Garbage: flush after 12h
- Age: 7 days
- Hard cap: 500 messages

## Code changes

1. **New:** `src/components/sleep-daily-summary.ts`
   - `buildDailySummary(db, transport, config)` → writes daily file
   - Token estimation: `Math.ceil(chars / 4) * 1.2`
   - Dynamic batching based on `AGENT_SLEEP_CTX_WINDOW`
   - Fresh ACP session per batch
   - Media payload stripping before summarization
   - Summary capping at `targetTokens * 3`
   - Three-level escalation (normal → aggressive → fallback)

2. **New:** `src/components/sleep-extract-daily.ts`
   - `extractFromDaily(dailyPath, transport)` → calls agentbridge-store
   - Fresh ACP session

3. **New:** `src/components/media-sanitizer.ts`
   - `stripMediaPayloads(content)` → clean text for summarization
   - Base64 removal, binary detection, media annotation
   - Reusable across sleep + any future summarization

4. **Update:** `agentbridge-sleep.ts`
   - Register 04a + 04b + 04c as code-driven steps
   - Remove old 04c-gc-extract.md prompt
   - Update garbage flush: 12h for marked, 7d age, 500 cap

5. **Update:** `12-consolidation.md`
   - Remove daily file writing (done in 04a)
   - Keep weekly/quarterly rollups only

6. **Update:** transport profiles
   - Add `AGENT_SLEEP_CTX_WINDOW` to kiro.env (128000) and gemini.env (1000000)

## What stays unchanged

- 00-identity, 01-retrospective, 02-feedback, 03-reminders
- 06-cron-verify, 08a-darwinism, 08b-core-knowledge, 08c-translation-check
- 09-anomaly-audit, 10-retro-extract, 11-merge
- 13-media-cleanup, 14-report
- Watermark advance (end of sleep)
- Sleep resume logic (lock file state)

## Design references

| Feature | Source | Adopted |
|---------|--------|---------|
| Token estimation `chars/4` | All three | ✅ |
| Safety margin 1.2x | OpenClaw | ✅ |
| BASE_CHUNK_RATIO 0.4 | OpenClaw | ✅ |
| Overhead budget 4096 | OpenClaw | ✅ |
| Previous summary context | Lossless-claw | ✅ (accumulating) |
| Three-level escalation | Lossless-claw | ✅ |
| Summary capping | Lossless-claw | ✅ |
| Media payload stripping | Lossless-claw | ✅ |
| Protected fresh tail | Hermes + Lossless-claw | Not needed (sleep processes all) |
| Parallel compression | Hermes | Not needed (sequential batches) |
| Hierarchical summary DAG | Lossless-claw | Not needed (flat daily file) |
| Compress-only-as-needed | Hermes | ✅ (single shot if fits) |
