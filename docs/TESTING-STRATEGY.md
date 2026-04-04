# Testing Strategy

## Overview

750 tests across 78 files. All tests run via `npx vitest run --silent`.

## Test Layers

### Unit Tests (~710 tests)
Isolated component tests with mocked dependencies. Cover individual functions, classes, and modules.

Location: alongside source files (`*.test.ts`)

Examples:
- `message-pipeline.test.ts` — pipeline message handling with mock transport/adapter
- `command-handlers.test.ts` — command parsing and dispatch
- `memory-manager.test.ts` — memory CRUD operations
- `cron-queue.test.ts` — task queue priority and execution

### Property-Based Tests (~15 tests)
Fuzz testing with `fast-check`. Generate random inputs to find edge cases.

Examples:
- `emotion-boost.test.ts` — emotion score calculations across random inputs
- `instant-store.test.ts` — watermark behavior with random chat IDs
- `browser-tool.property.test.ts` — browser tool input validation
- `domain-allowlist.property.test.ts` — URL matching edge cases

### E2E Tests (3 tests)
Real components with real SQLite DB, no mocks.

- `memory-e2e.test.ts` — full memory lifecycle: record → search → edit → delete

### Smoke Tests (5 tests)
Bridge lifecycle verification with real pipeline + real memory, mock transport.

Location: `src/tests/smoke.test.ts`

Tests:
1. `startSession` injects SOUL bundle into prompt
2. First message triggers SOUL injection via `pendingSessionStart`
3. Second message does NOT re-inject SOUL
4. `resetAndPrepare` triggers SOUL re-injection on next message
5. Session-start prompt bypasses interceptor (not truncated)

**Why this matters:** The SOUL truncation bug (#5 in pain-points.md) went undetected for 2 weeks because unit tests mocked the transport. These smoke tests use the real pipeline path.

### Integration Tests (9 tests)
Real component combinations, minimal mocking.

Location: `src/tests/heartbeat-integration.test.ts`, `src/tests/sleep-integration.test.ts`

Heartbeat (5 tests):
1. Age-check skips before SLEEP_TIME
2. Age-check skips when bridge started after today's SLEEP_TIME
3. Age-check triggers restart when past SLEEP_TIME + bridge started before
4. Age-check skips when busy chats exist
5. Age-check skips when sleep is active

Sleep (4 tests):
1. `hasSleepAuditToday` returns false when no audit exists
2. `hasSleepAuditToday` returns true when today's audit exists
3. SLEEP_TIME guard blocks early runs
4. Yesterday daily summary detection

### Contract Tests (5 tests)
Verify ACP protocol handling matches expected behavior.

Location: `src/tests/acp-contract.test.ts`

Permission handling (3 tests):
1. Auto-approves when `allow_once` option exists
2. Cancels when no allow option exists
3. Prefers first allow option found

Session updates (2 tests):
1. Collects text chunks into response
2. Tracks tool calls in flight (start → complete)

## What's NOT Tested

- **Full bridge startup** — `startBridge()` is too coupled to OS/network for automated testing. Verified manually on deploy.
- **Watchdog recovery** — requires simulating hung processes. Verified by overnight monitoring.
- **Sleep cycle end-to-end** — requires real LLM calls. Verified by daily sleep audit files.
- **Gemini ACP compatibility** — needs live Gemini CLI. Planned for contract test expansion.
- **Multi-platform** — no tests for Telegram+Discord simultaneously.

## Running Tests

```bash
npx vitest run --silent              # Full suite
npx vitest run src/tests/            # Smoke + integration + contract only
npx vitest run --silent src/tests/smoke.test.ts  # Smoke only
npx vitest run --watch               # Watch mode during development
```

## When to Add Tests

- **Every behavior change** — update or add unit tests
- **Every new component** — unit tests required
- **Every bug fix** — add a test that would have caught it
- **Every refactor** — run full suite before and after, smoke tests catch wiring bugs
