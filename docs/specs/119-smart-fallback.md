# Backlog #119 — Smart Model Fallback for Free Tiers

**Date:** 2026-04-10
**Status:** Ready to implement
**Priority:** HIGH

---

## Problem

Free tier models (OpenRouter, Together, DeepSeek) hit 429 constantly. Current leaky bucket:
- 429 fills 40% → two 429s = 80% = model skipped for ~13 minutes
- Drain is 3%/min — too slow for free tiers with 2 RPM limits
- No `Retry-After` header parsing — ignores the server telling us when to retry
- 402 (quota exceeded) treated as permanent auth error — should be temporary on free tiers
- "All models exhausted" gives no detail

## Solution

### 1. Error classification refinement

| Status | Current | After |
|---|---|---|
| 429 | `rate_limit` (0.4 fill) | `rate_limit` — parse `Retry-After` header, use as cooldown |
| 401 | `auth` (1.0 fill) | `auth_permanent` — skip permanently, never retry |
| 402 | `auth` (1.0 fill) | `quota_exceeded` — treat like rate_limit (temporary on free tiers) |
| 403 | `auth` (1.0 fill) | `auth_permanent` — skip permanently |
| 404 | `transient` (0.15) | `not_found` — skip permanently (model doesn't exist) |
| 500/502/503 | `transient` (0.15) | `transient` — light fill, fast drain |
| timeout | `transient` (0.15) | `transient` — same |

### 2. Retry-After aware cooldown

When 429 includes `Retry-After: 30` header:
- Don't fill the bucket — set a cooldown timer instead
- Skip the model until cooldown expires
- Probe once after cooldown to verify recovery
- If no `Retry-After` header, fall back to bucket fill (current behavior)

### 3. Faster drain for rate limits

Current: 3%/min (13 min to recover from 80%)
After: 10%/min for rate_limit errors (4 min recovery). Keep 3%/min for transient.

### 4. Structured failure summary

```
All models exhausted:
  - deepseek-chat: rate_limit (bucket: 85%, retry in 30s)
  - qwen-2.5: auth_permanent (401 — key revoked)
  - gemini-flash: quota_exceeded (bucket: 60%, draining)
```

### 5. Probe on cooldown expiry

When a rate-limited model's cooldown expires, send a lightweight probe (empty completion with max_tokens=1) before routing real traffic. If probe fails → extend cooldown. If probe succeeds → model is back.

---

## Implementation Tasks

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | Refine `classifyError()` — add `quota_exceeded`, `auth_permanent`, `not_found`. Parse 402 as temporary. | 15min | — |
| 2 | Add `Retry-After` header parsing in `direct-api-transport.ts` — extract from error response, pass to `recordError()` | 20min | — |
| 3 | Update `leaky-bucket.ts` — cooldown timer per bucket (from Retry-After), faster drain for rate_limit (10%/min), permanent skip for auth/not_found | 30min | 1, 2 |
| 4 | Structured failure summary — collect per-candidate error + bucket state, throw descriptive error | 15min | 3 |
| 5 | Probe on cooldown expiry — lightweight completion check before routing real traffic | 30min | 3 |
| 6 | Tests | 30min | 1-5 |

**Total: ~2.5hr**

Branch: `fix/smart-fallback`
