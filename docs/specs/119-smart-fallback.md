# Backlog #119 — Smart Model Fallback Improvements

**Date:** 2026-04-10
**Status:** Ready to implement
**Priority:** HIGH

---

## Problem

Free tier models (OpenRouter, Together) hit 429 constantly. Current leaky bucket:
- 429 fills 40% fixed → two 429s = 80% = model skipped for ~13 minutes
- Drain is 3%/min — too slow for free tiers with 2 RPM limits
- 402 (quota exceeded) treated as permanent auth error — should be temporary on free tiers
- "All models exhausted" gives no detail

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

### 4. Retry-After header

If 429 response includes `Retry-After` or `x-ratelimit-reset`, use as exact cooldown timestamp on bucket. If absent, fall back to progressive fill. Most free tiers won't send it — but when they do, it's exact.

~15 lines in `leaky-bucket.ts` + `direct-api-transport.ts`.

---

## What we're NOT doing

<<<<<<< Updated upstream
- No fallback transition notifications (nice UX but not critical)

## Borrowed from 9Router

9Router uses per-model locks with expiry timestamps instead of percentage-based buckets:
- `modelLock_<model>` = ISO timestamp when lock expires
- Check: `is lock expired? → try it` (simpler than bucket percentage + drain rate)
- Exponential backoff: 1s → 2s → 4s → ... → max 2min (with `backoffLevel` counter)
- On success: clear that model's lock + lazy-clean expired locks
- Account rotation: multiple accounts per provider, skip locked ones

**Consider for future:** Replace leaky bucket with timestamp-based locks. Simpler mental model, no drain rate tuning. But current bucket system works — this is a "nice to have" refactor, not blocking.
=======
- No cooldown probing (adds background timer complexity)
- No fallback transition notifications (nice UX but not critical)

These are valid ideas from OpenClaw but overkill for now.

---

## Future: Transport Supplier concept

**Status:** Design phase — implement after tasks 1-4 are validated.

Replace the generic `API` transport profile with named suppliers:

```env
# Instead of:
AGENT_TRANSPORT_PROFILE=api
API_ENDPOINT=http://localhost:11434/v1
API_MODEL=deepseek-r1

# Use:
AGENT_TRANSPORT_SUPPLIERS=openrouter,together,ollama
OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODELS=deepseek/deepseek-chat,moonshotai/kimi-k2,google/gemini-flash
TOGETHER_ENDPOINT=https://api.together.xyz/v1
TOGETHER_API_KEY=...
TOGETHER_MODELS=deepseek-ai/DeepSeek-V3,Qwen/Qwen2.5-72B
OLLAMA_ENDPOINT=https://your-ollama-cloud.example/v1
OLLAMA_API_KEY=...
OLLAMA_MODELS=deepseek-r1,qwen2.5
```

**Fallback chain:**
```
User prompt
  → try openrouter/deepseek-chat
  → 429 → try openrouter/kimi-k2
  → 429 → try openrouter/gemini-flash
  → all openrouter exhausted → SWITCH SUPPLIER
  → try together/DeepSeek-V3
  → 429 → try together/Qwen2.5-72B
  → all together exhausted → SWITCH SUPPLIER
  → try ollama/deepseek-r1
  → success
```

**Each supplier has:**
- Own endpoint + API key
- Own model list (ordered by preference)
- Own bucket state (per-model within supplier)
- Supplier-level health (if all models in a supplier are bucketed → skip supplier)

**Implementation approach:**
- `TransportSupplier` type: `{ name, endpoint, apiKey, models[], buckets }`
- `DirectApiTransport` takes `suppliers[]` instead of flat `fallbacks[]`
- Candidate iteration: outer loop = suppliers, inner loop = models within supplier
- Existing leaky bucket works per-model within each supplier

**Effort:** ~2hr (refactor DirectApiTransport config + candidate iteration)
>>>>>>> Stashed changes

---

## Future: Transport Supplier concept

**Status:** Design phase — implement after tasks 1-4 are validated.

Replace the generic `API` transport profile with named suppliers:

```env
# Instead of:
AGENT_TRANSPORT_PROFILE=api
API_ENDPOINT=http://localhost:11434/v1
API_MODEL=deepseek-r1

# Use:
AGENT_TRANSPORT_SUPPLIERS=openrouter,together,ollama
OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODELS=deepseek/deepseek-chat,moonshotai/kimi-k2,google/gemini-flash
TOGETHER_ENDPOINT=https://api.together.xyz/v1
TOGETHER_API_KEY=...
TOGETHER_MODELS=deepseek-ai/DeepSeek-V3,Qwen/Qwen2.5-72B
OLLAMA_ENDPOINT=https://your-ollama-cloud.example/v1
OLLAMA_API_KEY=...
OLLAMA_MODELS=deepseek-r1,qwen2.5
```

**Fallback chain:**
```
User prompt
  → try openrouter/deepseek-chat
  → 429 → try openrouter/kimi-k2
  → 429 → try openrouter/gemini-flash
  → all openrouter exhausted → SWITCH SUPPLIER
  → try together/DeepSeek-V3
  → 429 → try together/Qwen2.5-72B
  → all together exhausted → SWITCH SUPPLIER
  → try ollama/deepseek-r1
  → success
```

**Each supplier has:**
- Own endpoint + API key
- Own model list (ordered by preference)
- Own bucket state (per-model within supplier)
- Supplier-level health (if all models in a supplier are bucketed → skip supplier)

**Implementation approach:**
- `TransportSupplier` type: `{ name, endpoint, apiKey, models[], buckets }`
- `DirectApiTransport` takes `suppliers[]` instead of flat `fallbacks[]`
- Candidate iteration: outer loop = suppliers, inner loop = models within supplier
- Existing leaky bucket works per-model within each supplier

**Effort:** ~2hr (refactor DirectApiTransport config + candidate iteration)

---

## Implementation (immediate)

| # | Task | Effort | File |
|---|---|---|---|
| 1 | Progressive fill: add `consecutiveErrors` to Bucket, scale fill, reset on success. Add `recordSuccess(key)` to reset counter — call after successful `agentLoop()`. | 15min | `leaky-bucket.ts` + `direct-api-transport.ts` |
| 2 | 402 as temporary: change `classifyError(402)` to `rate_limit` | 1min | `leaky-bucket.ts` |
| 3 | Structured failure summary: collect per-candidate errors, throw descriptive | 10min | `direct-api-transport.ts` |
<<<<<<< Updated upstream
| 4 | Retry-After header: if present in 429 response, use as exact cooldown | 15min | `leaky-bucket.ts` + `direct-api-transport.ts` |
=======
| 4 | Retry-After header: if 429 response includes `Retry-After` or `x-ratelimit-reset`, use as exact cooldown timestamp on bucket. If absent, fall back to progressive fill. Most free tiers won't send it — but when they do, it's exact. | 15min | `leaky-bucket.ts` + `direct-api-transport.ts` |
>>>>>>> Stashed changes

**Total: ~40min**
