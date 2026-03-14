# Requirements Document

## Introduction

A web-based operations dashboard for monitoring and controlling the AgentBridge process at runtime. The Dashboard provides a single-page admin panel served over HTTP that displays real-time status of all bridge subsystems: platform pollers (Telegram, Discord), memory storage, heartbeat system, transport layer, and general bridge health. Operators can toggle platforms on/off, switch between transport modes (tmux/ACP) at runtime, and observe system metrics pushed via WebSocket. The dashboard is activated via the `--web` or `--all` CLI flag, uses token-based authentication (`WEB_AUTH_TOKEN`), and is built with Node.js built-in `http` module (no external web framework).

## Glossary

- **Dashboard_Server**: The HTTP server component using Node.js built-in `http` module that serves the static Dashboard_UI and handles WebSocket upgrades for real-time status push. Runs on a configurable port within the AgentBridge process.
- **Dashboard_UI**: The single-page HTML/CSS/JavaScript frontend served by the Dashboard_Server. Renders a control panel with status cards, toggle controls, and live metrics.
- **Status_Broadcaster**: The server-side component that periodically collects system metrics from all subsystems and pushes a JSON status snapshot to all connected WebSocket clients.
- **Platform_Controller**: The server-side component that handles HTTP API requests to enable or disable platform pollers (Telegram, Discord) at runtime by calling their `.start()` and `.stop()` methods.
- **Transport_Controller**: The server-side component that handles HTTP API requests to switch the active transport mode (tmux or ACP) at runtime. Destroys the current transport, creates and initializes the new one, and re-wires the memory LLM callback.
- **Auth_Gate**: The authentication component that validates a bearer token provided by the client on both HTTP API requests and WebSocket connections. Uses a shared secret from the `WEB_AUTH_TOKEN` environment variable.
- **Memory_Manager**: The existing memory system that provides `getStats(chatId)` returning message counts, extracted memories, compaction counts, ingested documents, heartbeat status, and database size.
- **Heartbeat_System**: The existing background task scheduler with `.start()`, `.stop()`, configurable `intervalMs`, and registered `HeartbeatTask[]` array.
- **Transport**: The existing `IKiroTransport` implementation (TmuxClient or AcpTransport) with `isReady` property and, for TmuxClient, `contextPercent` for context window usage.
- **Telegram_Poller**: The existing Telegram long-poll component with `.start()` and `.stop()` methods and a `running` state.
- **Discord_Poller**: The existing Discord Gateway listener with `.start()` and `.stop()` methods and a `started` state.
- **Memory_Search_Controller**: The server-side component that handles HTTP API requests for memory keyword search. Executes the same multi-stage recall pipeline as the `agentbridge-recall` CLI: FTS5 → relaxed FTS5 → substring → original-language substring → compaction summaries, using `MemoryIndex`.

## Requirements

### Requirement 1: Dashboard Server Lifecycle

**User Story:** As an operator, I want the dashboard server to start and stop as part of the AgentBridge process lifecycle, so that the dashboard is available when the bridge runs with the `--web` flag.

#### Acceptance Criteria

1. WHEN the `--web` or `--all` CLI flag is passed, THE Dashboard_Server SHALL start listening on the port specified by the `WEB_PORT` environment variable (default: 3000).
2. WHEN the `--web` flag is not passed and `--all` is not passed, THE Dashboard_Server SHALL not start and no port SHALL be bound.
3. WHEN the AgentBridge process receives a SIGINT or SIGTERM signal, THE Dashboard_Server SHALL close all active WebSocket connections and stop listening within 5 seconds.
4. THE Dashboard_Server SHALL log the listening address and port at startup using the existing logger at info level.
5. IF the configured port is already in use, THEN THE Dashboard_Server SHALL log an error and exit the process with a non-zero exit code.

### Requirement 2: Static Dashboard Serving

**User Story:** As an operator, I want to open a URL in my browser and see the dashboard, so that I can monitor the bridge without additional tooling.

#### Acceptance Criteria

1. WHEN an HTTP GET request is received for the root path `/`, THE Dashboard_Server SHALL respond with the Dashboard_UI HTML page.
2. WHEN an HTTP GET request is received for a static asset path (CSS, JS, favicon), THE Dashboard_Server SHALL respond with the corresponding file and appropriate `Content-Type` header.
3. WHEN an HTTP GET request is received for a path that does not match any static asset or API route, THE Dashboard_Server SHALL respond with HTTP 404.

### Requirement 3: Authentication

**User Story:** As an operator, I want the dashboard protected by a token, so that only authorized users can view system status or control platforms.

#### Acceptance Criteria

1. WHEN a WebSocket upgrade request is received, THE Auth_Gate SHALL extract the token from the `token` query parameter or the `Authorization` header.
2. WHEN an HTTP request is received for an API route (`/api/*`), THE Auth_Gate SHALL extract the token from the `Authorization` header (Bearer scheme).
3. WHEN the provided token matches the `WEB_AUTH_TOKEN` environment variable, THE Auth_Gate SHALL allow the request to proceed.
4. WHEN the provided token does not match or is missing, THE Auth_Gate SHALL reject the request with HTTP 401.
5. THE Auth_Gate SHALL use constant-time string comparison for token validation to prevent timing attacks.
6. IF `--web` is passed and `WEB_AUTH_TOKEN` is not set, THEN THE Dashboard_Server SHALL log an error and exit the process with a non-zero exit code.

### Requirement 4: Real-Time Status Push

**User Story:** As an operator, I want the dashboard to show live system metrics without manual refresh, so that I can monitor the bridge in real time.

#### Acceptance Criteria

1. WHEN a WebSocket connection is established, THE Status_Broadcaster SHALL immediately send a full status snapshot to the newly connected client.
2. WHILE one or more WebSocket clients are connected, THE Status_Broadcaster SHALL push a status snapshot to all clients at a configurable interval (default: 5 seconds).
3. THE status snapshot SHALL be a JSON object containing: bridge uptime, platform states, transport status, memory stats, and heartbeat status.
4. WHEN a WebSocket connection is closed, THE Status_Broadcaster SHALL remove the client from the broadcast list and stop broadcasting when no clients remain.

### Requirement 5: Platform Toggle Controls

**User Story:** As an operator, I want to enable or disable Telegram and Discord at runtime from the dashboard, so that I can control which platforms are active without restarting the bridge.

#### Acceptance Criteria

1. THE Dashboard_UI SHALL organize platform controls into three groups: "Access Interfaces" (Telegram, Discord), "External Tooling" (Projects, LM Notebook, Keep), and "Social Media" (X, Facebook).
2. WHEN an authenticated POST request is received at `/api/platforms/telegram/start`, THE Platform_Controller SHALL call `Telegram_Poller.start()` and respond with the updated platform state.
3. WHEN an authenticated POST request is received at `/api/platforms/telegram/stop`, THE Platform_Controller SHALL call `Telegram_Poller.stop()` and respond with the updated platform state.
4. WHEN an authenticated POST request is received at `/api/platforms/discord/start`, THE Platform_Controller SHALL call `Discord_Poller.start()` and respond with the updated platform state.
5. WHEN an authenticated POST request is received at `/api/platforms/discord/stop`, THE Platform_Controller SHALL call `Discord_Poller.stop()` and respond with the updated platform state.
6. IF a platform poller was not initialized at startup (flag not passed and poller is null), THEN THE Platform_Controller SHALL respond with HTTP 409 and a message indicating the platform is not configured.
7. WHEN a platform state changes, THE Status_Broadcaster SHALL push an updated status snapshot to all connected WebSocket clients within 1 second.
8. THE Dashboard_UI SHALL render the "External Tooling" group with three items (Projects, LM Notebook, Keep), each displayed as a disabled/greyed-out toggle with a "coming soon" tooltip. These items are placeholders for future integration and SHALL NOT have backend API endpoints.
9. THE Dashboard_UI SHALL render the "Social Media" group with two items (X, Facebook), each displayed as a disabled/greyed-out toggle with a "coming soon" tooltip. These items are placeholders for future integration and SHALL NOT have backend API endpoints.

### Requirement 6: Memory Storage Monitoring

**User Story:** As an operator, I want to see memory storage statistics on the dashboard, so that I can track how much data the bridge has accumulated.

#### Acceptance Criteria

1. THE status snapshot SHALL include memory stats from `Memory_Manager.getStats()`: total messages, extracted memories, extracted-by-type breakdown, preserved keywords, compaction counts (daily, weekly, quarterly), ingested document count, and database size in bytes.
2. WHILE the Memory_Manager is disabled (null), THE status snapshot SHALL include a `memoryEnabled: false` field and omit memory stats.
3. THE Dashboard_UI SHALL display memory stats in a dedicated card with human-readable formatting (e.g., database size in MB).

### Requirement 7: Heartbeat Monitoring

**User Story:** As an operator, I want to see heartbeat system status on the dashboard, so that I can verify background tasks are running.

#### Acceptance Criteria

1. THE status snapshot SHALL include heartbeat status: running state (boolean), interval in milliseconds, and the list of registered task names.
2. WHILE the Heartbeat_System is not running, THE Dashboard_UI SHALL display the heartbeat status as stopped with a visual indicator.
3. WHILE the Heartbeat_System is running, THE Dashboard_UI SHALL display the heartbeat status as running with the interval and task names.

### Requirement 8: Memory Keyword Search

**User Story:** As an operator, I want to search memory by keyword from the dashboard, so that I can inspect what the agent would recall for a given query without going through a chat platform.

#### Acceptance Criteria

1. THE Dashboard_UI SHALL render a search box in the Memory card that accepts a keyword query string.
2. THE Dashboard_UI SHALL render four toggle buttons next to the search box for memory layer filtering: L1 (Raw Messages — FTS5 + substring on `messages` table), L2 (Extracted Memories — FTS5 on `extracted_memories` table), L3 (Compaction Summaries — LIKE on `compactions` table, daily/weekly/quarterly), L4 (Original Language — substring on `extracted_memories` with `preserve_original`), and L5 (Cloud — not yet implemented). All five layers SHALL be rendered; L1 through L4 SHALL be enabled by default; L5 SHALL be rendered as disabled/greyed out with a "coming soon" tooltip.
3. WHEN an authenticated GET request is received at `/api/memory/search` with query parameters `keywords` (required, comma-separated), `chatId` (required), `layers` (optional, comma-separated subset of `L1,L2,L3,L4,L5`, default `L1,L2,L3,L4`), `original` (optional), `timeStart` (optional, unix ms), and `timeEnd` (optional, unix ms), THE Memory_Search_Controller SHALL execute only the search stages corresponding to the selected layers.
4. THE Memory_Search_Controller SHALL map layers to search stages as follows: L1 → FTS5 full-text search and relaxed FTS5 and substring search on raw messages, L2 → FTS5 search on extracted memories via `MemoryIndex.searchExtracted`, L3 → compaction summary LIKE search on weekly and quarterly summaries, L4 → original-language substring search via `MemoryIndex.searchOriginal` (only when `original` parameter is also provided), L5 → reserved for future cloud memory search (if `L5` is requested, THE Memory_Search_Controller SHALL return an empty array for that layer with a `"status": "not_implemented"` field).
5. THE Memory_Search_Controller SHALL deduplicate results across all selected layers, return a JSON array of results each containing: `content`, `date` (ISO string), `source` (layer label and search method), and `score`, sorted by score descending, limited to 10 results.
6. THE Dashboard_UI SHALL display search results below the search box with the content, date, source layer, and score for each result.
7. WHILE the Memory_Manager is disabled, THE Memory_Search_Controller SHALL respond with HTTP 409 and a message indicating memory is not enabled.
8. IF the search query is empty, THEN THE Memory_Search_Controller SHALL respond with HTTP 400.

### Requirement 9: Transport Monitoring

**User Story:** As an operator, I want to see transport layer status on the dashboard, so that I can verify the connection to Kiro CLI is healthy.

#### Acceptance Criteria

1. THE status snapshot SHALL include transport status: transport type (tmux or acp), connection state (`isReady` boolean), and context window usage percentage (from TmuxClient `contextPercent`, or -1 if unavailable).
2. THE Dashboard_UI SHALL display the transport type, connection state with a visual indicator (connected/disconnected), and context window percentage as a progress indicator.

### Requirement 10: Transport Switching

**User Story:** As an operator, I want to switch between tmux and ACP transport modes from the dashboard, so that I can change how the bridge communicates with Kiro CLI without restarting the process.

#### Acceptance Criteria

1. WHEN an authenticated POST request is received at `/api/transport/switch` with a JSON body `{"mode": "tmux"}` or `{"mode": "acp"}`, THE Transport_Controller SHALL destroy the current transport, create a new transport of the requested type using the existing config values, call `initialize()` on it, and update the shared transport reference.
2. WHEN the transport switch is in progress, THE Transport_Controller SHALL stop all platform pollers before destroying the current transport and restart them after the new transport is initialized.
3. WHEN the transport switch completes successfully, THE Transport_Controller SHALL respond with HTTP 200 and the updated transport status, and THE Status_Broadcaster SHALL push an updated status snapshot to all connected WebSocket clients.
4. IF the requested transport mode is the same as the currently active mode, THEN THE Transport_Controller SHALL respond with HTTP 200 and a no-op message without reinitializing.
5. IF the new transport fails to initialize, THEN THE Transport_Controller SHALL attempt to re-initialize the previous transport as a rollback, respond with HTTP 500 and a JSON error message, and push an error status snapshot.
6. WHEN the Memory_Manager is enabled and the transport is switched, THE Transport_Controller SHALL re-register the LLM callback on the new transport instance.

### Requirement 11: Bridge Health Overview

**User Story:** As an operator, I want to see general bridge health at a glance, so that I can quickly assess whether the system is operating normally.

#### Acceptance Criteria

1. THE status snapshot SHALL include: process uptime in milliseconds, enabled platform list, and timestamp of the snapshot.
2. THE Dashboard_UI SHALL display uptime in a human-readable format (e.g., "2h 15m 30s").
3. THE Dashboard_UI SHALL display each platform grouped under its category (Access Interfaces, External Tooling, Social Media) with a status badge showing enabled/disabled and running/stopped states. Future items (External Tooling, Social Media) SHALL show a "coming soon" badge.
4. THE Dashboard_UI SHALL use color-coded indicators: green for healthy/running, yellow for degraded/stopped-but-configured, red for error/disconnected.

### Requirement 12: Dashboard UI Layout

**User Story:** As an operator, I want a clean, organized dashboard layout, so that I can find information quickly.

#### Acceptance Criteria

1. THE Dashboard_UI SHALL render a header with the dashboard title and the Kiro Professor logo from `logo/KiroProfessor.jpg`.
2. THE Dashboard_UI SHALL organize metrics into distinct cards: Bridge Health, Platforms, Transport, Memory, and Heartbeat.
3. THE Dashboard_UI SHALL be usable on both desktop and tablet viewports with responsive layout.
4. WHEN the WebSocket connection to the Dashboard_Server is lost, THE Dashboard_UI SHALL display a visible connection-lost banner and attempt to reconnect with exponential backoff (starting at 1 second, max 30 seconds).
5. THE Dashboard_UI SHALL update all displayed metrics when a new status snapshot is received over WebSocket without full page reload.
6. THE Dashboard_UI SHALL use a dark color scheme (dark background, light text) as the default and only theme.

### Requirement 13: Configuration

**User Story:** As an operator, I want the dashboard configured through environment variables consistent with the existing config pattern, so that deployment is straightforward.

#### Acceptance Criteria

1. THE Config SHALL include a `WEB_PORT` environment variable (default: `3000`) specifying the HTTP server listen port.
2. THE Config SHALL include a `WEB_AUTH_TOKEN` environment variable (required when `--web` is used) specifying the shared secret for authentication.
3. THE Config SHALL include a `WEB_HOST` environment variable (default: `0.0.0.0`) specifying the bind address.
4. THE Config SHALL include a `WEB_PUSH_INTERVAL_MS` environment variable (default: `5000`) specifying the status broadcast interval in milliseconds.
5. THE `.env.example` file SHALL document all web-related environment variables with descriptions.

### Requirement 14: Error Handling

**User Story:** As an operator, I want the dashboard to handle errors gracefully, so that a single failure does not break monitoring or the bridge process.

#### Acceptance Criteria

1. IF a WebSocket client disconnects unexpectedly, THEN THE Status_Broadcaster SHALL remove the client and continue broadcasting to remaining clients.
2. IF collecting stats from a subsystem fails (e.g., Memory_Manager throws), THEN THE Status_Broadcaster SHALL include an error field for that subsystem in the snapshot and continue collecting from other subsystems.
3. IF a platform toggle request fails, THEN THE Platform_Controller SHALL respond with HTTP 500 and a JSON error message describing the failure.
4. THE Dashboard_Server SHALL continue serving other connections when one connection encounters an error.
