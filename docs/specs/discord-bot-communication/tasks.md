# Implementation Plan: Discord Bot Communication

## Overview

Extend AgentBridge to support Discord as a second messaging platform alongside Telegram, introduce a ChannelAdapter abstraction for platform-agnostic message routing, and add bot-to-bot (A2A) communication with Molty via a dedicated Discord channel. Implementation proceeds bottom-up: shared interfaces first, then Discord components, then A2A, then wiring in main.ts.

## Tasks

- [x] 1. Refactor IKiroTransport and transports from `chatId: number` to `sessionKey: string`
  - [x] 1.1 Update `IKiroTransport` interface in `src/components/kiro-transport.ts` — change `sendPrompt(chatId: number, ...)` to `sendPrompt(sessionKey: string, ...)` and `resetSession(chatId: number)` to `resetSession(sessionKey: string)`
    - _Requirements: 5.4, 10.2, 10.5_
  - [x] 1.2 Update `AcpTransport` in `src/components/acp-transport.ts` — change internal `sessions` map from `Map<number, string>` to `Map<string, string>`, update `sendPrompt` and `resetSession` signatures to use `sessionKey: string`
    - _Requirements: 5.4, 10.5_
  - [x] 1.3 Update `TmuxClient` in `src/components/tmux-client.ts` — change `sendPrompt(_chatId: number, ...)` and `resetSession(_chatId: number)` to accept `sessionKey: string`
    - _Requirements: 5.4, 10.5_
  - [x] 1.4 Update `SessionState` type in `src/types/session.ts` — rename `telegramChatId: number` to `channelKey: string` to support platform-prefixed keys
    - _Requirements: 5.4, 10.2_
  - [x] 1.5 Update `SessionManager` in `src/components/session-manager.ts` — change internal `sessions` map from `Map<number, SessionState>` to `Map<string, SessionState>`, update all methods (`getOrCreateSession`, `resetSession`, `isSessionBusy`, `setProcessing`, etc.) from `chatId: number` to `sessionKey: string`
    - _Requirements: 5.4, 8.1, 10.2_
  - [x] 1.6 Update `main.ts` — change `busyChats` from `Set<number>` to `Set<string>`, update all `chatId` references in `handleUpdate` to use string session keys (e.g., `telegram:${chatId}`), update transport calls accordingly
    - _Requirements: 5.4, 10.2, 10.5_
  - [ ]* 1.7 Update existing tests (`session-manager.test.ts`, `tmux-client.test.ts`, `config.test.ts`) to use string session keys
    - _Requirements: 5.4_

- [x] 2. Checkpoint — Ensure refactored transport compiles and existing tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Extend Config for Discord environment variables
  - [x] 3.1 Add Discord fields to `Config` type in `src/types/config.ts` — add `discordBotToken?`, `discordAllowedUserIds?: Set<string>`, `discordAllowedChannelIds?: Set<string>`, `discordA2aChannelId?`, `discordA2aPeerBotId?`, `discordA2aRateLimitMs: number`, `discordEnabled: boolean`, `discordA2aEnabled: boolean` and update `CONFIG_DEFAULTS`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  - [x] 3.2 Add Discord config loading and validation to `loadAndValidateConfig()` in `src/components/config.ts` — parse `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USER_IDS` (comma-separated snowflakes), `DISCORD_ALLOWED_CHANNEL_IDS`, `DISCORD_A2A_CHANNEL_ID`, `DISCORD_A2A_PEER_BOT_ID`, `DISCORD_A2A_RATE_LIMIT_MS`; validate snowflake format with `/^\d{17,20}$/`; enforce that `DISCORD_ALLOWED_USER_IDS` is non-empty when token is set; enforce `DISCORD_A2A_PEER_BOT_ID` is set when `DISCORD_A2A_CHANNEL_ID` is set; derive `discordEnabled` and `discordA2aEnabled` booleans
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  - [ ]* 3.3 Write property test for Discord snowflake validation (Property 11)
    - **Property 11: Discord snowflake validation**
    - For any string, the snowflake validator returns true iff the string matches `/^\d{17,20}$/`
    - Create `src/components/config.property.test.ts`
    - **Validates: Requirements 9.2, 9.3**
  - [ ]* 3.4 Write unit tests for Discord config validation in `src/components/config.test.ts`
    - Test: Discord disabled when `DISCORD_BOT_TOKEN` absent
    - Test: Startup fails when token present but `DISCORD_ALLOWED_USER_IDS` empty
    - Test: Startup fails when `DISCORD_A2A_CHANNEL_ID` set without `DISCORD_A2A_PEER_BOT_ID`
    - Test: Invalid snowflake format causes startup failure
    - Test: Valid full Discord config parses correctly
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 4. Implement ChannelAdapter and BridgeMessage types
  - [x] 4.1 Create `BridgeMessage` type and `DiscordInboundMessage` type in `src/types/discord.ts` — define `Platform`, `BridgeMessage`, `DiscordInboundMessage` types as specified in the design; export from `src/types/index.ts`
    - _Requirements: 5.1, 5.2_
  - [x] 4.2 Create `ChannelAdapter` class in `src/components/channel-adapter.ts` — implement `fromTelegram(message): BridgeMessage`, `fromDiscord(message): BridgeMessage`, `sessionKey(platform, channelId): string` methods; the adapter is stateless and pure
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [ ]* 4.3 Write property test for platform-prefixed session key uniqueness (Property 2)
    - **Property 2: Platform-prefixed session key uniqueness**
    - For any two messages from different platforms sharing the same numeric ID, `sessionKey()` produces distinct keys; same platform + same channel produces identical keys
    - Create `src/components/channel-adapter.property.test.ts`
    - **Validates: Requirements 3.1, 5.4, 8.1, 10.2**
  - [ ]* 4.4 Write property test for channel adapter normalization completeness (Property 6)
    - **Property 6: Channel adapter normalization completeness**
    - For any valid Telegram or Discord message, the output BridgeMessage contains all required fields non-empty
    - Add to `src/components/channel-adapter.property.test.ts`
    - **Validates: Requirements 5.1**
  - [ ]* 4.5 Write unit tests for ChannelAdapter in `src/components/channel-adapter.test.ts`
    - Test: `fromTelegram` normalizes a Telegram message correctly
    - Test: `fromDiscord` normalizes a Discord message correctly
    - Test: `sessionKey` produces correct prefixed keys
    - Test: Edge cases (missing display name falls back to ID)
    - _Requirements: 5.1, 5.2, 5.4_

- [x] 5. Implement DiscordSecurityGate
  - [x] 5.1 Create `DiscordSecurityGate` class in `src/components/discord-security-gate.ts` — constructor takes `allowedUserIds: Set<string>` and `allowedChannelIds: Set<string>`; throws if either set is empty; `authorize(authorId, channelId): boolean` returns true iff both IDs are in their respective whitelists
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [ ]* 5.2 Write property test for dual-whitelist authorization (Property 1)
    - **Property 1: Dual-whitelist authorization**
    - For any user ID and channel ID, `authorize()` returns true iff user is in user set AND channel is in channel set
    - Create `src/components/discord-security-gate.property.test.ts`
    - **Validates: Requirements 2.2, 2.3, 2.4**
  - [ ]* 5.3 Write unit tests for DiscordSecurityGate in `src/components/discord-security-gate.test.ts`
    - Test: Constructor throws on empty user whitelist
    - Test: Constructor throws on empty channel whitelist
    - Test: Authorized user in authorized channel passes
    - Test: Unauthorized user is rejected
    - Test: Authorized user in unauthorized channel is rejected
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 6. Implement DiscordApi
  - [x] 6.1 Install `discord.js` dependency — run `npm install discord.js`
    - _Requirements: 1.1_
  - [x] 6.2 Create `DiscordApi` class in `src/components/discord-api.ts` — thin wrapper around `discord.js` `Client`; implement `connect()`, `onMessage(handler)`, `sendMessage(channelId, text): Promise<string>`, `disconnect()`, `get isReady()`, `get botUserId()` as specified in the design; configure `GatewayIntentBits.Guilds`, `GatewayIntentBits.GuildMessages`, `GatewayIntentBits.MessageContent`
    - _Requirements: 1.1, 1.2, 1.4, 3.2_

- [x] 7. Implement DiscordPoller
  - [x] 7.1 Create `DiscordPoller` class in `src/components/discord-poller.ts` — constructor takes `DiscordApi` and an `onMessage` callback; `start()` connects to Gateway and registers the message handler; `stop()` disconnects cleanly; converts raw `discord.js` `Message` objects to `DiscordInboundMessage` before dispatching; filters out self-messages using `botUserId`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 8. Extend ResponseFormatter for Discord
  - [x] 8.1 Add `chunkTextForDiscord(text): string[]` method to `ResponseFormatter` — splits at 2000-char limit, respecting paragraph and code block boundaries; add `chunkForPlatform(text, platform): string[]` that delegates to existing `chunkText` for Telegram or `chunkTextForDiscord` for Discord; add `toDiscordMarkdown(text): string` (mostly passthrough since Discord uses standard Markdown)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [ ]* 8.2 Write property test for platform-aware response chunking (Property 4)
    - **Property 4: Platform-aware response chunking**
    - For any response string and platform, all chunks fit within the platform's limit (4096 Telegram, 2000 Discord) and concatenating chunks reproduces the original content
    - Create `src/components/response-formatter.property.test.ts`
    - **Validates: Requirements 4.1, 4.4**
  - [ ]* 8.3 Write property test for code block preservation (Property 5)
    - **Property 5: Response splitting preserves code blocks**
    - For any response containing fenced code blocks, every Discord chunk has balanced triple-backtick delimiters
    - Add to `src/components/response-formatter.property.test.ts`
    - **Validates: Requirements 4.2**
  - [ ]* 8.4 Write unit tests for Discord chunking in `src/components/response-formatter.test.ts`
    - Test: Short text returns single chunk
    - Test: Text over 2000 chars splits correctly
    - Test: Code blocks are not split mid-block
    - Test: `chunkForPlatform` delegates correctly per platform
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 9. Checkpoint — Ensure all new components compile and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement A2ARouter
  - [x] 10.1 Create `A2ARouter` class in `src/components/a2a-router.ts` — constructor takes `{ discordApi, a2aChannelId, peerBotId, rateLimitMs, onPrompt }`; implement `handleMessage(message)` that validates author is the peer bot, parses tag, routes `[REQUEST]` to transport, sends `[RESPONSE]` back; implement `parseTag(text)` returning `{ tag, content }` with `REQUEST` as default; implement `formatOutbound(tag, content)` returning `[TAG] content`; implement `sendToA2A(text)` with rate limiting (tracks last send time, delays if needed); implement sequential message queue (no two prompts in-flight simultaneously); send `[STATUS] error: <description>` on transport errors
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 8.4, 8.5_
  - [ ]* 10.2 Write property test for A2A peer bot identification (Property 7)
    - **Property 7: A2A peer bot identification**
    - For any message in the A2A channel, the router processes it iff the author's bot user ID matches `peerBotId`
    - Create `src/components/a2a-router.property.test.ts`
    - **Validates: Requirements 6.2, 6.5**
  - [ ]* 10.3 Write property test for A2A tag protocol round-trip (Property 8)
    - **Property 8: A2A tag protocol round-trip**
    - For any tag and content, `formatOutbound` then `parseTag` returns the original tag and content; untagged messages default to `REQUEST`
    - Add to `src/components/a2a-router.property.test.ts`
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.5**
  - [ ]* 10.4 Write property test for A2A outbound rate limiting (Property 10)
    - **Property 10: A2A outbound rate limiting**
    - For any sequence of outbound messages, elapsed time between consecutive `sendToA2A()` calls is >= `rateLimitMs`
    - Add to `src/components/a2a-router.property.test.ts`
    - **Validates: Requirements 8.5**
  - [ ]* 10.5 Write unit tests for A2ARouter in `src/components/a2a-router.test.ts`
    - Test: Ignores messages from non-peer bots
    - Test: Routes `[REQUEST]` to transport and sends `[RESPONSE]` back
    - Test: Untagged messages treated as `[REQUEST]`
    - Test: Sends `[STATUS] error:` on transport failure
    - Test: Queues messages when a prompt is in-flight
    - _Requirements: 6.2, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 8.4_

- [x] 11. Wire Discord components into main.ts
  - [x] 11.1 Update `main.ts` to conditionally create Discord components — when `config.discordEnabled`, instantiate `DiscordApi`, `DiscordSecurityGate`, `DiscordPoller`, and `ChannelAdapter`; when `config.discordA2aEnabled`, instantiate `A2ARouter`; wire Discord message handler: DiscordPoller → DiscordSecurityGate → ChannelAdapter → shared message handler (using `BridgeMessage`); wire A2A: DiscordPoller dispatches A2A channel messages to `A2ARouter.handleMessage`; support `/new`, `/reset`, `/status`, `/a2a-reset` commands from Discord; use `ResponseFormatter.chunkForPlatform` for Discord responses; update `busyChats` to use platform-prefixed session keys
    - _Requirements: 1.1, 1.2, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 6.1, 8.3, 10.1, 10.3_
  - [x] 11.2 Update shutdown handler in `main.ts` — on SIGINT/SIGTERM, stop both `TelegramPoller` and `DiscordPoller` (if active), then destroy transport
    - _Requirements: 1.4, 10.3_
  - [x] 11.3 Add platform isolation error handling in `main.ts` — wrap Discord poller start in try/catch so Telegram continues if Discord fails; wrap Telegram poller similarly so Discord continues if Telegram fails
    - _Requirements: 10.1, 10.4_

- [x] 12. Checkpoint — Ensure full integration compiles and all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Update .env.example and documentation
  - [x] 13.1 Add Discord environment variables to `.env.example` — add `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_CHANNEL_IDS`, `DISCORD_A2A_CHANNEL_ID`, `DISCORD_A2A_PEER_BOT_ID`, `DISCORD_A2A_RATE_LIMIT_MS` with descriptive comments
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 14. Final checkpoint — Ensure all tests pass and project compiles cleanly
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Task 1 is a refactor of existing code — must be done first since all subsequent work depends on string session keys
- `discord.js` handles Gateway reconnection, heartbeat, and rate limiting internally — no custom reconnection logic needed
