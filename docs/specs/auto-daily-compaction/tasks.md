# Implementation Plan: Auto Daily Compaction

## Overview

Add automatic daily compaction to the heartbeat loop with three trigger paths: heartbeat-driven eligibility checks, startup catch-up for missed compactions, and shutdown compaction. Reuses existing `CompactionEngine.compact()` with a new optional `compactionDate` parameter. Introduces a per-chat lock map for concurrency safety.

## Tasks

- [x] 1. Add `dayBoundaryHours` configuration
  - [x] 1.1 Add `dayBoundaryHours` field to `MemoryConfig` type and `MEMORY_CONFIG_DEFAULTS` (default: 4)
    - In `src/components/memory-config.ts`, add `dayBoundaryHours: number` to the `MemoryConfig` type
    - Add `dayBoundaryHours: 4` to `MEMORY_CONFIG_DEFAULTS`
    - In `loadMemoryConfig()`, parse `MEMORY_DAY_BOUNDARY_HOURS` env var via `parseNumberEnvSafe`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Write property test for configuration parsing resilience (Property 1)
    - **Property 1: Configuration Parsing Resilience**
    - For any string value assigned to `MEMORY_DAY_BOUNDARY_HOURS`, `loadMemoryConfig().dayBoundaryHours` equals the parsed finite number if valid, otherwise defaults to 4
    - Use `fast-check` `fc.string()` and `fc.oneof(fc.float(), fc.constant("abc"), ...)` generators
    - **Validates: Requirements 1.2, 1.3**

- [x] 2. Add `compactionDate` parameter to `CompactionEngine.compact()`
  - [x] 2.1 Extend `compact()` to accept optional `compactionDate` override
    - In `src/components/compaction-engine.ts`, add `compactionDate?: Date` to the `compact()` params type
    - Use `params.compactionDate` for file naming date when provided, fall back to `new Date()` otherwise
    - Derive `dateStr` from `compactionDate.toISOString().slice(0, 10)` when override is present
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 2.2 Write property test for compaction file naming by message date (Property 3)
    - **Property 3: Compaction File Named by Message Date**
    - For any session with messages, when `compact()` is called with a `compactionDate` derived from the earliest message, the file path contains that date (YYYY-MM-DD), not the current date
    - **Validates: Requirements 3.1, 3.2, 3.3**

- [x] 3. Implement `isEligibleForCompaction` pure function and `DailyCompactionTask` module
  - [x] 3.1 Create `src/components/daily-compaction-task.ts` with the `isEligibleForCompaction` pure function
    - Export `isEligibleForCompaction({ lastMessageTimestamp, now, dayBoundaryHours })` returning boolean
    - Return `false` if last message and now are on the same calendar day
    - Return `false` if `now - lastMessageTimestamp < dayBoundaryHours * 3_600_000`
    - Return `true` otherwise
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.2 Write property test for eligibility equivalence (Property 2)
    - **Property 2: Eligibility Equivalence**
    - For any (now, lastMessageTimestamp, dayBoundaryHours) triple, `isEligibleForCompaction` returns true iff now is on a strictly later calendar day than lastMessageTimestamp AND `now - lastMessageTimestamp >= dayBoundaryHours * 3_600_000`
    - Generate timestamp pairs with controlled calendar-day relationships using `fast-check`
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [x] 3.3 Implement `getUncompactedSessions` query function
    - Export `getUncompactedSessions(db, chatId)` returning `Array<{ sessionId, lastMessageTimestamp }>`
    - Query sessions joined with messages, excluding sessions with existing daily-tier compaction records
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 3.4 Write property test for already-compacted sessions being skipped (Property 4)
    - **Property 4: Already-Compacted Sessions Are Skipped**
    - For any set of sessions where some have daily-tier compaction records and some don't, the task produces new compactions only for uncompacted eligible sessions
    - **Validates: Requirements 5.2, 5.3**

  - [x] 3.5 Implement `createDailyCompactionTask` factory function
    - Export `createDailyCompactionTask(deps: DailyCompactionDeps): HeartbeatTask`
    - The task iterates active chats, calls `getUncompactedSessions`, checks eligibility via `isEligibleForCompaction`, and invokes `CompactionEngine.compact()` with the derived `compactionDate`
    - On error for any session, log and continue to next session
    - Skip if LLM call is unavailable (null)
    - Use `acquireLock` to prevent concurrent compaction per chat
    - _Requirements: 4.1, 4.3, 4.4, 5.2, 5.3, 8.1_

  - [x] 3.6 Write property test for error resilience across sessions (Property 5)
    - **Property 5: Error Resilience Across Sessions**
    - For any list of sessions where the LLM call throws for a subset, the task still compacts all sessions where the LLM succeeds
    - **Validates: Requirements 4.4, 7.5**

- [x] 4. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Add per-chat lock map and `shutdownCompaction` to `MemoryManager`
  - [x] 5.1 Add `compactionLocks` map and `acquireCompactionLock` / `waitForCompaction` methods
    - In `src/components/memory-manager.ts`, add `private compactionLocks = new Map<number, Promise<void>>()`
    - Implement `acquireCompactionLock(chatId)`: returns release function or null if already locked
    - Implement `waitForCompaction(chatId)`: awaits any in-progress compaction promise
    - _Requirements: 8.1, 8.2_

  - [x] 5.2 Write property test for per-chat lock mechanism (Property 8)
    - **Property 8: Per-Chat Lock Prevents Concurrent Compaction**
    - For any chatId, if a lock is held, a second acquire returns null; after release, waitForCompaction resolves and a new lock is acquirable
    - **Validates: Requirements 8.1, 8.2**

  - [x] 5.3 Implement `shutdownCompaction()` async method on `MemoryManager`
    - Query all active sessions from the `sessions` table
    - For each session: wait for any in-progress compaction, skip if already compacted, derive `compactionDate` from earliest message, call `CompactionEngine.compact()`
    - If LLM call is null, log warning and return early
    - On error per session, log and continue to remaining sessions
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 5.4 Write property test for shutdown compaction bypassing all checks (Property 7)
    - **Property 7: Shutdown Compaction Bypasses All Checks**
    - For any active session regardless of time-of-day or inactivity gap, `shutdownCompaction()` compacts the session (when LLM is available and no prior daily record exists)
    - **Validates: Requirements 7.2**

- [x] 6. Implement startup catch-up
  - [x] 6.1 Implement `runStartupCatchUp` async function in `daily-compaction-task.ts`
    - Scan all chats for uncompacted sessions from previous calendar days
    - Skip inactivity gap check for sessions whose messages are entirely from previous days
    - Compact each eligible session with `compactionDate` derived from source messages
    - On error per session, log and continue
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 6.2 Write property test for startup catch-up ignoring inactivity gap (Property 6)
    - **Property 6: Startup Catch-Up Ignores Inactivity Gap**
    - For any set of sessions from previous calendar days, `runStartupCatchUp` compacts all of them regardless of inactivity gap, and does not compact current-day sessions
    - **Validates: Requirements 6.1, 6.3**

- [x] 7. Integrate into heartbeat and startup flow
  - [x] 7.1 Register `daily-compaction` task in `MemoryManager.startHeartbeat()`
    - Register the task between `memory-extraction` and `consolidation` tasks
    - Pass required dependencies: db, config, transcriptParser, memoryIndex, getLlmCall, acquireLock
    - _Requirements: 4.1, 4.2_

  - [x] 7.2 Call `runStartupCatchUp` before `heartbeat.start()` in `startHeartbeat()`
    - Invoke startup catch-up after task registration but before the first heartbeat tick
    - Wrap in try/catch to avoid blocking heartbeat start on failure
    - _Requirements: 6.4_

  - [x] 7.3 Make `shutdown()` in `main.ts` async and call `shutdownCompaction()`
    - Change `function shutdown(): void` to `async function shutdown(): Promise<void>`
    - Call `await memory?.shutdownCompaction()` before `memory?.close()`
    - Wrap in try/catch so shutdown proceeds even if compaction fails
    - Update signal handlers: `process.on("SIGINT", () => void shutdown())`
    - _Requirements: 7.1_

- [x] 8. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` with vitest, consistent with existing test patterns
- Test file: `src/components/daily-compaction-task.test.ts` for eligibility + task logic, extend `memory-manager.test.ts` for lock + shutdown tests
- The `isEligibleForCompaction` function is pure and deterministic — ideal for property-based testing
