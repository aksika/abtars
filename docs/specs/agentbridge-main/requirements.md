# Requirements Document

## Introduction

This document defines the requirements for the Telegram–Kiro CLI Bridge, a standalone Node.js intermediary agent that bridges Telegram to Kiro CLI via the Agent Client Protocol (ACP). The bridge long-polls Telegram for messages, spawns `kiro-cli acp` as a child process, and translates between Telegram's Bot API and Kiro's JSON-RPC 2.0 protocol over stdio. It exposes zero network surface, enforces a Telegram user ID whitelist, and delegates all AI work to Kiro CLI.

## Glossary

- **Bridge**: The standalone Node.js intermediary agent process that connects Telegram to Kiro CLI
- **Telegram_Poller**: The component responsible for long-polling the Telegram Bot API via `getUpdates`
- **Security_Gate**: The component that enforces the Telegram user ID whitelist on all inbound messages
- **Session_Manager**: The component that maps Telegram chat IDs to ACP sessions and manages session lifecycle
- **ACP_Client**: The component that manages the `kiro-cli acp` child process and JSON-RPC 2.0 communication over stdio
- **Permission_Handler**: The component that handles `session/request_permission` notifications from Kiro, either auto-approving or forwarding to the Telegram user
- **Response_Formatter**: The component that converts aggregated ACP responses into Telegram-friendly messages
- **ACP**: Agent Client Protocol — JSON-RPC 2.0 over stdio used by `kiro-cli acp`
- **Trust_Mode**: A configuration mode where all Kiro permission requests are auto-approved without user interaction
- **Interactive_Mode**: The default mode where permission requests are forwarded to the Telegram user for approval or denial

## Requirements

### Requirement 1: Telegram Long-Polling

**User Story:** As a developer, I want the bridge to receive Telegram messages via long-polling, so that no inbound network ports are exposed and deployment is simple.

#### Acceptance Criteria

1. WHEN the Bridge starts, THE Telegram_Poller SHALL call the Telegram Bot API `getUpdates` endpoint with offset tracking and a configurable timeout (default 30 seconds)
2. WHEN the Telegram Bot API returns updates, THE Telegram_Poller SHALL parse each Update object and extract text messages and commands
3. WHEN the Telegram Bot API returns an error or the network times out, THE Telegram_Poller SHALL retry with exponential backoff and jitter, starting at 1 second and capping at 60 seconds
4. WHEN a graceful shutdown signal is received, THE Telegram_Poller SHALL cancel in-flight requests via AbortController and stop polling
5. WHILE the Bridge is running, THE Telegram_Poller SHALL never self-terminate due to transient errors and SHALL always retry

### Requirement 2: Security Gate

**User Story:** As a developer, I want all inbound messages validated against a user ID whitelist, so that only authorized Telegram users can interact with Kiro.

#### Acceptance Criteria

1. WHEN the Bridge starts, THE Security_Gate SHALL load allowed user IDs from the `ALLOWED_USER_IDS` configuration
2. WHEN a message is received, THE Security_Gate SHALL validate `message.from.id` against the whitelist before any further processing occurs
3. WHEN an authorized user sends a message, THE Security_Gate SHALL pass the message to the Session_Manager
4. WHEN an unauthorized user sends a message, THE Security_Gate SHALL silently drop the message without sending any response
5. IF the `ALLOWED_USER_IDS` configuration is empty or missing, THEN THE Bridge SHALL refuse to start

### Requirement 3: Session Management

**User Story:** As a developer, I want Telegram chat IDs mapped to ACP sessions, so that each conversation maintains its own Kiro context.

#### Acceptance Criteria

1. WHEN an authorized user sends a first message or the `/new` command, THE Session_Manager SHALL create a new ACP session via the ACP_Client and map the Telegram chat ID to the returned session ID
2. WHEN an authorized user sends a subsequent message, THE Session_Manager SHALL route the message to the existing ACP session for that chat ID
3. WHEN an authorized user sends the `/reset` command, THE Session_Manager SHALL destroy the current ACP session and create a fresh one for that chat ID
4. WHEN the ACP_Client detects a crashed or stale session, THE Session_Manager SHALL recreate the session and notify the Telegram user
5. THE Session_Manager SHALL maintain a one-to-one mapping between Telegram chat IDs and ACP session IDs, ensuring no two chat IDs share the same ACP session

### Requirement 4: ACP Client Communication

**User Story:** As a developer, I want the bridge to manage the `kiro-cli acp` child process and handle JSON-RPC 2.0 communication, so that Telegram messages are translated into Kiro prompts and responses are routed back.

#### Acceptance Criteria

1. WHEN the Bridge starts, THE ACP_Client SHALL spawn `kiro-cli acp` as a child process and send an `initialize` JSON-RPC request with protocol version and client capabilities
2. WHEN a new ACP session is needed, THE ACP_Client SHALL send a `session/new` JSON-RPC request with the configured working directory and return the session ID
3. WHEN a user message is routed to a session, THE ACP_Client SHALL send a `session/prompt` JSON-RPC request with the session ID and message content
4. WHEN the `kiro-cli acp` process emits `session/update` notifications on stdout, THE ACP_Client SHALL parse the newline-delimited JSON-RPC messages and route them to the appropriate session handler
5. WHEN the `kiro-cli acp` process exits unexpectedly, THE ACP_Client SHALL notify the Telegram user, respawn the process, and create a new ACP session
6. THE ACP_Client SHALL track JSON-RPC request IDs to correlate responses with their originating requests

### Requirement 5: Permission Handling

**User Story:** As a developer, I want Kiro's permission requests handled according to the configured mode, so that dangerous operations are gated appropriately.

#### Acceptance Criteria

1. WHEN a `session/request_permission` notification is received and Trust_Mode is enabled, THE Permission_Handler SHALL auto-approve the request and respond to the ACP_Client immediately
2. WHEN a `session/request_permission` notification is received and Interactive_Mode is active, THE Permission_Handler SHALL forward the permission request to the Telegram user as an inline keyboard with Approve and Deny options
3. WHEN the Telegram user responds to a permission prompt, THE Permission_Handler SHALL send the user's decision back to the ACP_Client via JSON-RPC
4. IF the Telegram user does not respond to a permission prompt within the configured timeout (default 60 seconds), THEN THE Permission_Handler SHALL auto-deny the request and notify the user that the action was denied due to timeout
5. WHILE a permission prompt is pending, THE Permission_Handler SHALL track the ACP request ID, Telegram message ID, and timeout handle for correlation

### Requirement 6: Response Formatting

**User Story:** As a developer, I want ACP responses converted into Telegram-friendly messages, so that Kiro's output is readable and well-formatted in Telegram.

#### Acceptance Criteria

1. WHEN `agent_message_chunk` notifications are received, THE Response_Formatter SHALL collect and aggregate them into a complete response
2. WHEN the aggregated response exceeds 4096 characters, THE Response_Formatter SHALL split the response into chunks that each fit within Telegram's 4096-character message limit
3. WHEN splitting responses, THE Response_Formatter SHALL split at paragraph or code block boundaries to preserve readability
4. WHEN formatting responses, THE Response_Formatter SHALL convert Markdown to Telegram MarkdownV2 or HTML parse mode
5. WHEN tool call status updates are received, THE Response_Formatter SHALL format them as status messages (e.g., "🔧 Reading auth.ts..." → "✅ Done")

### Requirement 7: Configuration Validation

**User Story:** As a developer, I want all configuration validated at startup, so that the bridge fails fast with clear errors rather than failing at runtime.

#### Acceptance Criteria

1. WHEN the Bridge starts, THE Bridge SHALL validate that `TELEGRAM_BOT_TOKEN` is non-empty and matches the format `\d+:[A-Za-z0-9_-]+`
2. WHEN the Bridge starts, THE Bridge SHALL validate that `ALLOWED_USER_IDS` contains at least one valid numeric ID
3. WHEN the Bridge starts, THE Bridge SHALL validate that the `KIRO_CLI_PATH` (default: `kiro-cli`) resolves to an executable file
4. WHEN the Bridge starts, THE Bridge SHALL validate that `WORKING_DIR` (default: current working directory) is an existing directory
5. IF any required configuration value is missing or invalid, THEN THE Bridge SHALL refuse to start and log a descriptive error message identifying the invalid configuration

### Requirement 8: Error Recovery

**User Story:** As a developer, I want the bridge to recover gracefully from errors, so that it remains operational without manual intervention.

#### Acceptance Criteria

1. WHEN the `kiro-cli acp` process crashes, THE Bridge SHALL notify the Telegram user with a message indicating the session ended unexpectedly, respawn the process, and create a new ACP session
2. WHEN the Telegram Bot API returns sustained errors, THE Bridge SHALL continue retrying with exponential backoff indefinitely without self-terminating
3. WHEN the ACP_Client receives a JSON-RPC error response for a session error, THE ACP_Client SHALL attempt to create a new session
4. WHEN the ACP_Client receives a JSON-RPC error response for a protocol error, THE ACP_Client SHALL restart the `kiro-cli acp` process
5. WHEN a user sends a message while a previous prompt is still being processed, THE Bridge SHALL either queue the message or notify the user that the previous request is still in progress

### Requirement 9: Security Posture

**User Story:** As a developer, I want the bridge to have zero network attack surface and leak no information, so that it is safe to run on any machine.

#### Acceptance Criteria

1. THE Bridge SHALL operate with outbound-only network traffic to the Telegram Bot API and local stdio to `kiro-cli acp`
2. THE Bridge SHALL expose no HTTP server, no webhooks, no WebSocket listeners, and no open ports
3. THE Bridge SHALL store all secrets (bot token, user IDs) in the `.env` file and contain no hardcoded credentials in the codebase
4. WHEN an unauthorized user sends a message, THE Security_Gate SHALL provide no response or error information to the sender
5. THE Bridge SHALL use ACP exclusively for Kiro communication and SHALL NOT implement or use MCP
