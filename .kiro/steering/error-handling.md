---
alwaysApply: true
---

# Error Handling Patterns

Four patterns. Each has one correct use case.

| Pattern | When | Example |
|---------|------|---------|
| `logAndSwallow(tag, op, err)` | Fire-and-forget side effects (reactions, notifications, analytics) | Telegram reaction failed — don't crash the response |
| `logError(tag, err); throw` | Recoverable errors the caller must handle | Transport returns 500 — caller triggers fallback |
| `catch { /* reason */ }` | Truly expected conditions (file not found, JSON parse of untrusted input) | Cache miss, malformed model output |
| `throw new Error(...)` | Unrecoverable — let it bubble | Missing required config, corrupt state |

## Rules

1. **Never bare `catch {}`** — always comment why it's safe to swallow, or use `logAndSwallow`
2. **Transport errors always propagate** — the fallback system needs to see them to trigger rotation
3. **Boot phase errors are fatal** — throw, don't swallow. Bridge must not start broken.
4. **`.catch(() => {})` requires a comment** — if fire-and-forget, bind to logAndSwallow: `.catch(logAndSwallow.bind(null, tag, "op"))`
