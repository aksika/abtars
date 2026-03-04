# Implementation Plan: Telegram–Kiro CLI Bridge

## Overview

Standalone Node.js intermediary agent bridging Telegram to Kiro CLI via ACP (JSON-RPC 2.0 over stdio). TypeScript, ES modules, Node.js 22+. Zero external dependencies beyond `dotenv` (optional). Each task builds incrementally — core types and config first, then components bottom-up, then wiring and integration.

## Tasks

- [x] 1. Set up project structure, tooling, and core types
  - [x] 1.1 Initialize project with `package.json` (type: module), `tsconfig.json` (ESM, Node 22+, strict), and directory structure (`src/`, `src/types/`, `src/components/`)
    - Install dev dependencies: `typescript`, `vitest`, `fast-check`, `@types/node`
    - Add `dotenv` as the sole runtime dependency (or document `--env-file` alternative)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [x] 1.2 Define core TypeScript interfaces and types
    - `Config` type with all `.env` fields and defaults
    - `SessionState` type (chatId, acpSessionId, isProcessing, pendingRequestId, timestamps)
    - `AcpRequest`, `AcpResponse`, `AcpNotification` types (JSON-RPC 2.0 envelope)
    - `PendingPermission` type (acpRequestId, action, telegramMessageId, timeoutHandle)
    - Telegram `Update`, `Message`, `InlineKeyboardMarkup` types (minimal, only what we use)
    - _Requirements: 3.5, 4.4, 4.6, 5.5_

- [x] 2. Implement configuration validation
  - [x] 2.1 Create `src/components/config.ts` with `loadAndValidateConfig()` function
    - Validate `TELEGRAM_BOT_TOKEN` matches `\d+:[A-Za-z0-9_-]+`
    - Validate `ALLOWED_USER_IDS` has at least one valid numeric ID after comma-split and trim
    - Validate `KIRO_CLI_PATH` resolves to an executable (use `fs.access` with `X_OK`)
    - Validate `WORKING_DIR` is an existing directory
    - Return typed `Config` object or throw with descriptive error identifying the invalid field
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 2.5_
  - [ ]* 2.2 Write property test: bot token validation (Property 13)
    - **Property 13: Bot token validation**
    - Generate arbitrary strings with fast-check; assert validator accepts iff string matches `\d+:[A-Za-z0-9_-]+`
    - **Validates: Requirement 7.1**
  - [ ]* 2.3 Write property test: user ID list validation (Property 14)
    - **Property 14: User ID list validation**
    - Generate arbitrary comma-separated strings; assert validator accepts iff at least one numeric value after split/trim
    - **Validates: Requirement 7.2**
  - [ ]* 2.4 Write property test: invalid config prevents startup (Property 15)
    - **Property 15: Invalid configuration prevents startup**
    - Generate config objects with at least one required field missing/invalid; assert `loadAndValidateConfig` throws with error identifying the bad field
    - **Validates: Requirement 7.5**

- [x] 3. Implement Security Gate
  - [x] 3.1 Create `src/components/security-gate.ts` with `SecurityGate` class
    - Constructor takes `allowedUserIds: Set<number>` (loaded from config)
    - `authorize(message)` method: returns `true` iff `message.from.id` is in the whitelist
    - Unauthorized messages produce no output, no side effects — silent drop
    - Refuse to construct with empty whitelist (throw)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 9.4_
  - [ ]* 3.2 Write property test: whitelist enforcement (Property 3)
    - **Property 3: Security gate whitelist enforcement**
    - Generate arbitrary user IDs and non-empty whitelists; assert authorization iff user ID is in whitelist
    - **Validates: Requirements 2.2, 2.3, 2.4, 9.4**

- [x] 4. Implement JSON-RPC framing and ACP Client
  - [x] 4.1 Create `src/components/jsonrpc.ts` with serialization/parsing utilities
    - `serialize(message: AcpRequest | AcpResponse): string` — JSON + newline delimiter
    - `parse(line: string): AcpResponse | AcpNotification` — parse newline-delimited JSON-RPC
    - Request ID generator (monotonically increasing integer)
    - _Requirements: 4.4, 4.6_
  - [ ]* 4.2 Write property test: JSON-RPC round-trip (Property 8)
    - **Property 8: JSON-RPC message round-trip**
    - Generate arbitrary valid JSON-RPC messages; assert serialize then parse yields equivalent object
    - **Validates: Requirement 4.4**
  - [x] 4.3 Create `src/components/acp-client.ts` with `AcpClient` class
    - `spawn()`: spawn `kiro-cli acp` child process, set up stdin/stdout/stderr pipes
    - `initialize()`: send `initialize` JSON-RPC request with protocol version and client capabilities
    - `createSession(cwd: string): Promise<string>` — send `session/new`, return session ID
    - `sendPrompt(sessionId: string, message: string): Promise<void>` — send `session/prompt`
    - `cancelSession(sessionId: string): Promise<void>` — send `session/cancel`
    - Parse stdout via `readline` interface for newline-delimited JSON-RPC
    - Route `session/update` notifications to registered session handlers via callback
    - Route `session/request_permission` notifications to permission handler
    - Track request IDs to correlate responses with originating requests
    - Handle process exit: emit crash event for Session Manager to handle
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [ ]* 4.4 Write property test: request ID correlation (Property 7)
    - **Property 7: JSON-RPC request ID correlation**
    - Generate sequences of requests; assert each response is correlated to the correct request by ID
    - **Validates: Requirement 4.6**

- [x] 5. Checkpoint — Core components
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement Session Manager
  - [x] 6.1 Create `src/components/session-manager.ts` with `SessionManager` class
    - Maintain `Map<number, SessionState>` for chat ID → session mapping
    - `getOrCreateSession(chatId)`: return existing session or create new one via ACP_Client
    - `resetSession(chatId)`: destroy current session, create fresh one, update mapping
    - `handleNewCommand(chatId)`: alias for creating a fresh session
    - `handleCrash(chatId)`: recreate session, return notification message for user
    - Track `isProcessing` flag per session; expose `isSessionBusy(chatId)` check
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - [ ]* 6.2 Write property test: session routing correctness (Property 4)
    - **Property 4: Session routing correctness**
    - Generate sequences of messages from distinct chat IDs; assert new session on first message, reuse on subsequent
    - **Validates: Requirements 3.1, 3.2**
  - [ ]* 6.3 Write property test: session uniqueness invariant (Property 5)
    - **Property 5: Session uniqueness invariant**
    - Generate sequences of create/reset operations across multiple chat IDs; assert no two chat IDs share the same session ID simultaneously
    - **Validates: Requirement 3.5**
  - [ ]* 6.4 Write property test: reset produces new session (Property 6)
    - **Property 6: Reset produces a new session**
    - For any chat ID with existing session, assert `/reset` maps to a different session ID
    - **Validates: Requirement 3.3**

- [x] 7. Implement Permission Handler
  - [x] 7.1 Create `src/components/permission-handler.ts` with `PermissionHandler` class
    - Constructor takes trust mode flag and timeout config
    - `handlePermissionRequest(acpRequestId, action, chatId)`: returns `Promise<boolean>`
    - Trust mode: resolve immediately with `true`
    - Interactive mode: send inline keyboard to Telegram user (Approve / Deny buttons), start timeout timer
    - `handleCallbackQuery(callbackData, messageId)`: resolve pending permission promise with user's decision
    - On timeout: auto-deny, notify user, clean up pending state
    - Track pending permissions: `Map<string, PendingPermission>` keyed by ACP request ID
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - [ ]* 7.2 Write property test: trust mode always approves (Property 9)
    - **Property 9: Trust mode always approves**
    - Generate arbitrary permission requests; assert trust mode always returns approval
    - **Validates: Requirement 5.1**

- [x] 8. Implement Response Formatter
  - [x] 8.1 Create `src/components/response-formatter.ts` with `ResponseFormatter` class
    - `collectChunk(sessionId, chunk)`: aggregate `agent_message_chunk` notifications
    - `flush(sessionId): string[]` — return array of Telegram-ready message chunks
    - `chunkText(text: string): string[]` — split at paragraph/code block boundaries, each ≤ 4096 chars
    - `toTelegramMarkdown(markdown: string): string` — convert standard Markdown to Telegram MarkdownV2 (escape special chars)
    - `formatToolStatus(toolName, status): string` — format tool call updates (e.g., "🔧 Reading auth.ts..." → "✅ Done")
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [ ]* 8.2 Write property test: chunk size limit (Property 10)
    - **Property 10: Response chunk size limit**
    - Generate arbitrary strings; assert all chunks ≤ 4096 characters
    - **Validates: Requirement 6.2**
  - [ ]* 8.3 Write property test: chunking preserves content (Property 11)
    - **Property 11: Response chunking preserves content**
    - Generate arbitrary strings; assert concatenation of chunks equals original input
    - **Validates: Requirements 6.1, 6.2**
  - [ ]* 8.4 Write property test: code block integrity (Property 12)
    - **Property 12: Code block integrity in chunks**
    - Generate inputs with fenced code blocks; assert no chunk has unmatched code fences
    - **Validates: Requirement 6.3**

- [x] 9. Checkpoint — All components implemented
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement Telegram Poller
  - [x] 10.1 Create `src/components/telegram-poller.ts` with `TelegramPoller` class
    - Constructor takes bot token, poll timeout, and message callback
    - `start()`: begin long-poll loop calling `getUpdates` with offset tracking via native `fetch`
    - `stop()`: cancel in-flight request via `AbortController`, set running flag to false
    - Offset tracking: after processing updates, set offset to `max(update_id) + 1`
    - Exponential backoff with jitter on errors: `min(2^N * 1000, 60000)` ms, jitter in `[0, base_delay]`
    - Never self-terminates — always retries on transient errors
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - [ ]* 10.2 Write property test: offset tracking (Property 1)
    - **Property 1: Offset tracking after updates**
    - Generate sequences of updates with arbitrary `update_id` values; assert next offset = `max(update_id) + 1`
    - **Validates: Requirement 1.1**
  - [ ]* 10.3 Write property test: exponential backoff bounds (Property 2)
    - **Property 2: Exponential backoff bounds**
    - Generate arbitrary failure counts N; assert backoff ≤ `min(2^N * 1000, 60000)` and jitter in `[0, base_delay]`
    - **Validates: Requirement 1.3**

- [x] 11. Implement Telegram API helper
  - [x] 11.1 Create `src/components/telegram-api.ts` with `TelegramApi` class
    - Thin wrapper around Telegram Bot API HTTP calls using native `fetch`
    - `sendMessage(chatId, text, options?)`: send text message with optional parse mode and reply markup
    - `answerCallbackQuery(callbackQueryId)`: acknowledge inline keyboard press
    - `getUpdates(offset, timeout, signal?)`: long-poll for updates
    - All methods handle HTTP errors and return typed responses
    - _Requirements: 1.1, 6.4, 5.2, 9.1, 9.2_

- [x] 12. Wire components together in main entry point
  - [x] 12.1 Create `src/main.ts` as the bridge entry point
    - Load and validate config via `loadAndValidateConfig()`
    - Instantiate all components: `TelegramApi`, `SecurityGate`, `AcpClient`, `SessionManager`, `PermissionHandler`, `ResponseFormatter`, `TelegramPoller`
    - Wire the message flow: Poller → Security Gate → Session Manager → ACP Client → Response Formatter → Telegram API
    - Wire permission flow: ACP Client → Permission Handler → Telegram API (inline keyboard) → Permission Handler → ACP Client
    - Wire error recovery: ACP Client crash → Session Manager recreate → Telegram API notify user
    - Handle message queueing: if session is busy, notify user that previous request is in progress
    - Register graceful shutdown handlers (`SIGINT`, `SIGTERM`): stop poller, cancel pending permissions, kill kiro-cli processes
    - _Requirements: 1.4, 4.5, 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.5_
  - [x] 12.2 Add `bin` entry or start script in `package.json`
    - Add `"start"` script: `node --env-file=.env dist/main.js` (or with dotenv)
    - Add `"build"` script: `tsc`
    - Add `"dev"` script: `tsx src/main.ts` (or `node --loader tsx`)
    - _Requirements: 7.3, 7.4_

- [x] 13. Implement error recovery flows
  - [x] 13.1 Add error recovery logic across components
    - ACP Client: on process crash, emit event; Session Manager listens and recreates sessions, notifies users via Telegram API
    - ACP Client: on JSON-RPC session error, attempt new session; on protocol error, restart kiro-cli process
    - Telegram Poller: sustained API errors trigger exponential backoff, never self-terminate
    - Session Manager: detect stale sessions (e.g., kiro-cli exited), recreate on next message
    - Message queueing: if `isProcessing` is true for a session, reply with "Previous request still in progress" or queue
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 14. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The bridge exposes zero network surface — outbound-only to Telegram API + local stdio to kiro-cli (Requirements 9.1, 9.2, 9.5)
- No MCP anywhere in the implementation (Requirement 9.5)
