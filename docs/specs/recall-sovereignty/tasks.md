# Recall Sovereignty — Tasks

## Task 1: Create `agentbridge-recall` CLI ✅

- [x] Created `src/cli/agentbridge-recall.ts` — standalone entry point
- [x] Opens `~/.agentbridge/memory/memory.db` read-only
- [x] Accepts `--keywords`, `--original`, `--time-start`, `--time-end`, `--chat-id`
- [x] Searches extracted memories (FTS5), compactions (LIKE), original-language (LIKE)
- [x] Applies temporal decay (14-day half-life)
- [x] Outputs JSON array to stdout
- [x] Added `bin` entry in `package.json`

**Files:** `src/cli/agentbridge-recall.ts` (new), `package.json`

## Task 2: Update SKILL.md ✅

- [x] Replaced fictional `memory_search` tool with shell command instructions
- [x] Example: `agentbridge-recall --keywords "puppy,kiskutya" --original "kiskutya" --chat-id 7773842843`
- [x] Clear "when to use" and "when NOT to use" guidance
- [x] Explicit: never on short confirmations like "yes", "ok", "do it", "approved"

**Files:** `skills/memory-search/SKILL.md`

## Task 3: Remove auto-injection of `[RECALLED MEMORIES]` ✅

- [x] Removed `buildRecalledSection()` call from `ContextAssembler.assemble()`
- [x] Set `usage.recalled = 0` by default (only populated at session start)
- [x] Retained `buildRecalledSection()` method with `@ts-expect-error` for future use
- [x] Updated 4 tests in `context-assembler.test.ts` to expect no recalled section

**Files:** `src/components/context-assembler.ts`, `src/components/context-assembler.test.ts`

## Task 4: Add timestamped session-start summary + session marker ✅

- [x] Added `buildLastSessionSummary()` to `ContextAssembler`
  - Fetches latest daily compaction via `memoryManager.getLatestCompaction(chatId)`
  - Formats as `[LAST SESSION SUMMARY — ended <ISO timestamp>]`
- [x] Added `[SESSION START — <current ISO timestamp>]` marker before `[CONVERSATION]` block
- [x] Added `getLatestCompaction(chatId)` method to `MemoryManager`
  - Queries `compactions` table: `WHERE chat_id = ? AND tier = 'daily' ORDER BY timestamp DESC LIMIT 1`

**Files:** `src/components/context-assembler.ts`, `src/components/memory-manager.ts`

## Task 5: Wire `isSessionStart` in main.ts ✅

- [x] Added `pendingSessionStart: Set<string>` alongside `busyChats`
- [x] After `/new` or `/reset` in Telegram handler: `pendingSessionStart.add(sessionKey)`
- [x] After `/new` or `/reset` in Discord handler: `pendingSessionStart.add(sessionKey)`
- [x] Before `assembleContext()` in both handlers: check set, pass flag, clear

**Files:** `src/main.ts`

## Task 6: Update deploy.sh ✅

- [x] Added `agentbridge-recall` wrapper script generation in deploy.sh
- [x] Wrapper points to `$PROJECT_DIR/dist/cli/agentbridge-recall.js`
- [x] Deployed to `~/.agentbridge/agentbridge-recall` with execute permission

**Files:** `scripts/deploy.sh`

## Verification ✅

- [x] `npx tsc --noEmit` — zero errors
- [x] `npm test` — 294/294 tests pass (26 test files)
- [x] 4 tests updated to reflect new behavior (no recalled memories injection)
