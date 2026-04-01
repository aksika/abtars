# Sleep Extraction Refactor Plan

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

### Token estimation (from OpenClaw)
- `estimateTokens(text) = Math.ceil(text.length / 4)`
- Safety margin: 1.2x (20% buffer for estimation inaccuracy)
- Summarization overhead: 4096 tokens reserved for prompt template + model response
- Effective batch budget: `(ctx_window * 0.4) - overhead - safety_margin`

### Dynamic batch sizing
```
total_tokens = estimate(all messages) * 1.2
effective_budget = (AGENT_SLEEP_CTX_WINDOW * 0.4) - 4096

if total_tokens < AGENT_SLEEP_CTX_WINDOW * 0.7:
    → single shot, no batching
else:
    → chunk messages until estimated tokens > effective_budget
    → accumulating summary approach
```

### Accumulating summary flow
```
Code reads all messages from DB (since last watermark)

Batch 1: first N messages (fit in budget) → model writes Summary A
Batch 2: Summary A + next N messages → model writes Summary B
Batch 3: Summary B + next N messages → Summary C
...
Final summary → write daily/daily_YYYYMMDD.md
```

Each batch gets a fresh ACP session (no context buildup from previous batches).

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

SKIP:
- Greetings, filler, small talk
- Debugging noise, tool execution details
- Transient errors and temporary states

Write concise English bullet points, chronological order.
Preserve all identifiers exactly (UUIDs, IPs, paths, names).
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
- S4/S5 recall searches messages — lean buffer = less noise

## Code changes

1. **New:** `src/components/sleep-daily-summary.ts`
   - `buildDailySummary(db, transport, config)` → writes daily file
   - Token estimation: `Math.ceil(chars / 4) * 1.2`
   - Dynamic batching based on `AGENT_SLEEP_CTX_WINDOW`
   - Fresh ACP session per batch

2. **New:** `src/components/sleep-extract-daily.ts`
   - `extractFromDaily(dailyPath, transport)` → calls agentbridge-store
   - Fresh ACP session

3. **Update:** `agentbridge-sleep.ts`
   - Register 04a + 04b as code-driven steps
   - Remove old 04c-gc-extract.md prompt
   - Update 04c to use daily summary as filter

4. **Update:** `12-consolidation.md`
   - Remove daily file writing (done in 04a)
   - Keep weekly/quarterly rollups only

5. **Update:** transport profiles
   - Add `AGENT_SLEEP_CTX_WINDOW` to kiro.env (128000) and gemini.env (1000000)

## What stays unchanged

- 00-identity, 01-retrospective, 02-feedback, 03-reminders
- 06-cron-verify, 08a-darwinism, 08b-core-knowledge, 08c-translation-check
- 09-anomaly-audit, 10-retro-extract, 11-merge
- 13-media-cleanup, 14-report
- Watermark advance (end of sleep)
- Sleep resume logic (lock file state)
