# Backlog #119 — Smart Model Fallback Improvements

**Date:** 2026-04-10
**Status:** Ready to implement
**Priority:** HIGH

---

## Problem

Free tier models hit 429 constantly. Two 429s = model blacklisted for ~13 minutes. Too aggressive.

## Changes (minimal, no architecture change)

### 1. Progressive fill in leaky bucket

Add `consecutiveErrors` counter to `Bucket`. Fill amount scales with consecutive errors. Reset on success.

```
1st 429 → fill 0.1  (recovers in ~2 min)
2nd 429 → fill 0.2  (recovers in ~4 min)
3rd 429 → fill 0.4  (recovers in ~8 min)
4th+ 429 → fill 0.8 (backs off hard)
```

One field added to `Bucket`, one change in `recordError`. ~10 lines.

### 2. Treat 402 as temporary

Change `classifyError(402)` from `auth` (1.0 fill = permanent) to `rate_limit` (progressive fill). Free tier quota resets are temporary.

One line change in `classifyError`.

### 3. Structured failure summary

When all models fail, throw with per-candidate detail:

```
All models exhausted:
  - deepseek-chat: rate_limit (bucket: 45%)
  - qwen-2.5: auth (401)
  - gemini-flash: rate_limit (bucket: 30%)
```

~10 lines in the catch-all block of `direct-api-transport.ts`.

---

## What we're NOT doing

- No cooldown probing (adds background timer complexity)
- No same-provider sibling fallback (changes candidate selection logic)
- No fallback transition notifications (nice UX but not critical)
- No Retry-After header parsing (would need response header access in error path)

These are valid ideas from OpenClaw but overkill for now. The three changes above fix the main pain: too-aggressive blacklisting on free tiers.

---

## Implementation

| # | Task | Effort | File |
|---|---|---|---|
| 1 | Progressive fill: add `consecutiveErrors` to Bucket, scale fill, reset on success | 15min | `leaky-bucket.ts` |
| 2 | 402 as temporary: change `classifyError(402)` to `rate_limit` | 1min | `leaky-bucket.ts` |
| 3 | Structured failure summary: collect per-candidate errors, throw descriptive | 10min | `direct-api-transport.ts` |

**Total: ~30min**
