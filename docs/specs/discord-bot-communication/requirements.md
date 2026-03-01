# Requirements Document

## Introduction

This document defines the requirements for adding Discord as a communication channel to AgentBridge, alongside the existing Telegram integration. The feature introduces a Discord bot that receives messages from Discord channels and routes them to Kiro CLI via the existing transport layer (tmux or ACP). Additionally, it enables bot-to-bot (B2B) communication so that this AgentBridge instance can exchange messages with "Molty" — another AgentBridge/openclaw instance running on a separate machine (Mac). Bot-to-bot communication uses a dedicated Discord channel where both bots can read and write, enabling collaborative agent workflows.

## Glossary

- **Bridge**: The standalone Node.js AgentBridge process that connects messaging platforms to Kiro CLI
- **Discord_API**: The component that wraps the Discord Bot API (via discord.js or raw REST/Gateway) for sending and receiving messages
- **Discord_Poller**: The component that listens for Discord messages via the Gateway WebSocket connection and dispatches them to the message handler
- **Discord_Security_Gate**: The component that enforces an allowed-user and allowed-channel whitelist for Discord messages
- **Session_Manager**: The existing component that maps channel-specific chat identifiers to ACP sessions and manages session lifecycle
- **B2B_Channel**: A dedicated Discord text channel where two bot instances (this Bridge and Molty) exchange messages for collaborative agent workflows
- **B2B_Router**: The component that detects inbound bot messages on the B2B_Channel, determines if they require a response, and routes them to the transport layer
- **Molty**: A remote AgentBridge/openclaw agent instance running on a Mac, identified by its Discord bot user ID
- **Channel_Adapter**: An abstraction layer that normalizes messages from different platforms (Telegram, Discord) into a common internal format before routing to the transport layer
- **Response_Formatter**: The existing component that formats Kiro responses for delivery, extended to support Discord's 2000-character message limit and Discord Markdown
- **ACP**: Agent Client Protocol — JSON-RPC 2.0 over stdio used by `kiro-cli acp`
- **Transport**: The existing IKiroTransport interface (tmux or ACP) used to communicate with Kiro CLI

## Requirements

### Requirement 1: Discord Gateway Connection

**User Story:** As a developer, I want the Bridge to connect to Discord via the Gateway WebSocket, so that it can receive messages from Discord channels in real time.

#### Acceptance Criteria

1. WHEN the Bridge starts and a `DISCORD_BOT_TOKEN` is configured, THE Discord_Poller SHALL connect to the Discord Gateway using the Bot token and establish a WebSocket session
2. WHEN the Discord Gateway connection is established, THE Discord_Poller SHALL listen for `MESSAGE_CREATE` events and dispatch them to the message handler
3. WHEN the Discord Gateway connection drops, THE Discord_Poller SHALL reconnect with exponential backoff and jitter, starting at 1 second and capping at 60 seconds
4. WHEN a graceful shutdown signal is received, THE Discord_Poller SHALL close the Gateway connection cleanly
5. WHILE the Bridge is running and Discord is configured, THE Discord_Poller SHALL maintain the Gateway heartbeat and never self-terminate due to transient errors

### Requirement 2: Discord Security Gate

**User Story:** As a developer, I want Discord messages validated against user and channel whitelists, so that only authorized users in approved channels can interact with Kiro.

#### Acceptance Criteria

1. WHEN the Bridge starts with Discord enabled, THE Discord_Security_Gate SHALL load allowed Discord user IDs from `DISCORD_ALLOWED_USER_IDS` and allowed channel IDs from `DISCORD_ALLOWED_CHANNEL_IDS`
2. WHEN a Discord message is received, THE Discord_Security_Gate SHALL validate both the author ID against the user whitelist and the channel ID against the channel whitelist before further processing
3. WHEN an authorized user sends a message in an allowed channel, THE Discord_Security_Gate SHALL pass the message to the Channel_Adapter
4. WHEN a message fails either the user or channel whitelist check, THE Discord_Security_Gate SHALL silently drop the message without sending any response
5. IF `DISCORD_ALLOWED_USER_IDS` is configured but empty, THEN THE Bridge SHALL refuse to start and log a descriptive error

### Requirement 3: Discord Message Handling

**User Story:** As a developer, I want Discord messages routed to Kiro through the existing transport layer, so that Discord users get the same Kiro experience as Telegram users.

#### Acceptance Criteria

1. WHEN an authorized Discord user sends a text message, THE Bridge SHALL route the message content to the transport layer using the Discord channel ID as the session key
2. WHEN the transport layer returns a response, THE Bridge SHALL send the response back to the originating Discord channel
3. WHEN a Discord user sends the `/new` or `/reset` command, THE Bridge SHALL reset the Kiro session for that Discord channel
4. WHEN a Discord user sends the `/status` command, THE Bridge SHALL reply with the current transport connection status
5. WHEN a Discord user sends a message while a previous prompt is still being processed for that channel, THE Bridge SHALL notify the user that the previous request is still in progress

### Requirement 4: Discord Response Formatting

**User Story:** As a developer, I want Kiro responses formatted for Discord's message limits and Markdown dialect, so that responses are readable in Discord.

#### Acceptance Criteria

1. WHEN a Kiro response exceeds 2000 characters, THE Response_Formatter SHALL split the response into chunks that each fit within Discord's 2000-character message limit
2. WHEN splitting responses for Discord, THE Response_Formatter SHALL split at paragraph or code block boundaries to preserve readability
3. WHEN formatting responses for Discord, THE Response_Formatter SHALL use Discord-compatible Markdown (triple backticks for code blocks, standard Markdown for emphasis)
4. THE Response_Formatter SHALL detect the target platform (Telegram or Discord) and apply the appropriate formatting rules


### Requirement 5: Channel Adapter Abstraction

**User Story:** As a developer, I want a common message abstraction across Telegram and Discord, so that the transport layer and session management remain platform-agnostic.

#### Acceptance Criteria

1. THE Channel_Adapter SHALL normalize inbound messages from Telegram and Discord into a common internal message format containing: source platform, channel identifier, sender identifier, sender display name, message text, and timestamp
2. THE Channel_Adapter SHALL normalize outbound responses into platform-specific API calls based on the originating platform
3. WHEN a new messaging platform is added, THE Channel_Adapter SHALL require only a new platform-specific adapter without changes to the transport or session management layers
4. THE Session_Manager SHALL use the normalized channel identifier (prefixed by platform, e.g., `discord:123` or `telegram:456`) to maintain unique session mappings across platforms

### Requirement 6: Bot-to-Bot Communication Channel

**User Story:** As a developer, I want a dedicated Discord channel where my Bridge and Molty can exchange messages, so that the two agents can collaborate on tasks.

#### Acceptance Criteria

1. WHEN the Bridge starts and `DISCORD_B2B_CHANNEL_ID` is configured, THE B2B_Router SHALL monitor the specified Discord channel for inbound messages from Molty
2. WHEN Molty sends a message in the B2B_Channel, THE B2B_Router SHALL identify the message as a bot-to-bot message by matching the author's bot user ID against `DISCORD_B2B_PEER_BOT_ID`
3. WHEN a bot-to-bot message is received from Molty, THE B2B_Router SHALL route the message content to the transport layer using a dedicated B2B session key
4. WHEN the transport layer returns a response to a B2B prompt, THE B2B_Router SHALL send the response back to the B2B_Channel as a Discord message
5. THE B2B_Router SHALL ignore messages from bots other than the configured peer bot ID in the B2B_Channel

### Requirement 7: Bot-to-Bot Message Protocol

**User Story:** As a developer, I want a structured message format for bot-to-bot exchanges, so that agents can distinguish task requests, responses, and status updates.

#### Acceptance Criteria

1. THE B2B_Router SHALL use a simple text-based message protocol where messages are prefixed with a tag: `[REQUEST]`, `[RESPONSE]`, or `[STATUS]`
2. WHEN a `[REQUEST]` message is received from Molty, THE B2B_Router SHALL extract the request content and route it to the transport layer as a prompt
3. WHEN the transport layer completes a B2B prompt, THE B2B_Router SHALL prefix the response with `[RESPONSE]` before sending it to the B2B_Channel
4. WHEN the B2B session encounters an error, THE B2B_Router SHALL send a `[STATUS] error: <description>` message to the B2B_Channel
5. IF a B2B message does not contain a recognized tag prefix, THEN THE B2B_Router SHALL treat the message as a `[REQUEST]` by default

### Requirement 8: Bot-to-Bot Session Management

**User Story:** As a developer, I want B2B conversations to have their own Kiro session, so that bot-to-bot work does not interfere with human user sessions.

#### Acceptance Criteria

1. THE Session_Manager SHALL maintain a separate Kiro session for the B2B_Channel, isolated from human user sessions
2. WHEN the first B2B message is received, THE Session_Manager SHALL create a dedicated ACP session for bot-to-bot communication
3. WHEN a human user sends `/b2b-reset` in any authorized channel, THE Session_Manager SHALL destroy and recreate the B2B session
4. WHILE a B2B prompt is being processed, THE B2B_Router SHALL queue subsequent B2B messages and process them sequentially
5. THE B2B_Router SHALL apply a configurable rate limit (`DISCORD_B2B_RATE_LIMIT_MS`, default 5000ms) between outbound B2B messages to prevent message flooding

### Requirement 9: Discord Configuration

**User Story:** As a developer, I want Discord settings validated at startup alongside existing config, so that misconfiguration is caught early.

#### Acceptance Criteria

1. WHEN the Bridge starts, THE Bridge SHALL treat Discord as an optional channel — if `DISCORD_BOT_TOKEN` is not set, Discord features SHALL be disabled and the Bridge SHALL operate with Telegram only
2. WHEN `DISCORD_BOT_TOKEN` is set, THE Bridge SHALL validate that `DISCORD_ALLOWED_USER_IDS` contains at least one valid Discord user ID (snowflake format)
3. WHEN `DISCORD_BOT_TOKEN` is set, THE Bridge SHALL validate that `DISCORD_ALLOWED_CHANNEL_IDS` contains at least one valid Discord channel ID
4. WHEN `DISCORD_B2B_CHANNEL_ID` is set, THE Bridge SHALL validate that `DISCORD_B2B_PEER_BOT_ID` is also set and is a valid Discord snowflake ID
5. IF any required Discord configuration value is present but invalid, THEN THE Bridge SHALL refuse to start and log a descriptive error identifying the invalid configuration

### Requirement 10: Multi-Channel Coexistence

**User Story:** As a developer, I want Telegram and Discord to run simultaneously without interference, so that I can use both channels at the same time.

#### Acceptance Criteria

1. WHILE both Telegram and Discord are configured, THE Bridge SHALL run both pollers concurrently and route messages from each platform independently
2. THE Bridge SHALL maintain separate session namespaces per platform so that a Telegram chat and a Discord channel with the same numeric ID do not collide
3. WHEN a graceful shutdown signal is received, THE Bridge SHALL shut down both the Telegram_Poller and Discord_Poller cleanly before exiting
4. WHEN one platform experiences errors, THE Bridge SHALL continue operating on the other platform without interruption
5. THE Bridge SHALL share the same transport instance (tmux or ACP) across all platforms, using platform-prefixed session keys for isolation
