# Implementation Plan: Kiro Professor Web UI Dashboard

## Overview

Implement a web-based operations dashboard for the AgentBridge process using Node.js built-in `http` module, manual WebSocket upgrade, and an inline HTML frontend. The implementation proceeds bottom-up: config parsing → auth → data models → controllers → broadcaster → server → UI → main.ts wiring. All components live in `src/components/` with co-located test files.

## Tasks

- [x] 1. Dashboard configuration and data models
  - [x] 1.1 Create `src/components/dashboard-config.ts` with config parsing and type definitions
    - Define `DashboardConfig` type with `webPort`, `webHost`, `webAuthToken`, `webPushIntervalMs`
    - Export `loadDashboardConfig(env: Record<string, string | undefined>)` that parses env vars with defaults (port: 3000, host: "0.0.0.0", interval: 5000)
    - Invalid numeric values fall back to defaults
    - Export `validateDashboardConfig(config, webEnabled)` that throws if `--web` is set and `WEB_AUTH_TOKEN` is missing
    - Define and export `StatusSnapshot`, `PlatformStates`, `TransportStatus`, `MemoryStatus`, `HeartbeatStatus` types
    - Define and export `WebSearchResult`, `MemorySearchResponse` types
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 4.3, 6.1, 9.1_

  - [x] 1.2 Write property test for config parsing with defaults (Property 10)
    - **Property 10: Dashboard config parsing with defaults**
    - For any set of env var values (including missing/empty), `WEB_PORT` parses to number (default 3000), `WEB_HOST` to string (default "0.0.0.0"), `WEB_PUSH_INTERVAL_MS` to number (default 5000). Invalid numeric values fall back to defaults.
    - Use `fc.record({ WEB_PORT: fc.oneof(fc.constant(undefined), fc.string()), ... })` generators
    - **Validates: Requirements 13.1, 13.3, 13.4**

  - [x] 1.3 Write property test for uptime formatting (Property 11)
    - **Property 11: Uptime formatting**
    - Export `formatUptime(ms: number)` from `dashboard-config.ts`
    - For any non-negative millisecond value, produces a human-readable string with hours/minutes/seconds that represents the same duration within 1-second precision
    - Use `fc.nat({ max: 365 * 24 * 3600 * 1000 })` generator
    - **Validates: Requirements 11.2**

- [x] 2. Authentication gate
  - [x] 2.1 Create `src/components/auth-gate.ts` with `AuthGate` class
    - Constructor takes `token: string`
    - `validate(provided: string): boolean` — uses `crypto.timingSafeEqual` for constant-time comparison, returns `false` for empty/missing tokens
    - `extractToken(req: http.IncomingMessage): string | null` — extracts from `Authorization: Bearer <token>` header or `?token=<token>` query parameter
    - `guard(req, res): boolean` — returns true if authorized, sends 401 JSON response if not
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.2 Write property test for token extraction (Property 2)
    - **Property 2: Token extraction from requests**
    - For any HTTP request with a token in `Authorization: Bearer <token>` header or `?token=<token>` query param, `extractToken()` returns that exact token. For requests with neither, returns `null`.
    - Use `fc.string()` for token values, mock `http.IncomingMessage` with headers/url
    - **Validates: Requirements 3.1, 3.2**

  - [x] 2.3 Write property test for token validation correctness (Property 3)
    - **Property 3: Token validation correctness**
    - For any two non-empty strings A and B, `validate(A)` with configured token B returns `true` iff A === B. Empty or missing tokens always return `false`.
    - Use `fc.tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }))` generator
    - **Validates: Requirements 3.3, 3.4**

- [x] 3. Platform controller
  - [x] 3.1 Create `src/components/platform-controller.ts` with `PlatformController` class
    - Constructor takes `PlatformRefs` (telegramPoller, discordPoller — both nullable)
    - `handle(platform: string, action: string): Promise<{ status: number; body: object }>` — routes start/stop to poller methods
    - Returns 409 if poller is `null` (not configured), 500 if poller method throws, 400 for invalid platform/action
    - `getStates(): PlatformStates` — returns current running state of each platform
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 14.3_

  - [x] 3.2 Write property test for platform toggle state consistency (Property 5)
    - **Property 5: Platform toggle state consistency**
    - For any configured platform and action (start/stop), after handling, the running state matches the action. For unconfigured platforms (null), returns 409. When the operation throws, returns 500.
    - Use `fc.record({ platform: fc.constantFrom("telegram", "discord"), action: fc.constantFrom("start", "stop"), configured: fc.boolean() })` generator
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 14.3**

- [x] 4. Checkpoint — Config, auth, and platform controller
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Transport controller
  - [x] 5.1 Create `src/components/transport-controller.ts` with `TransportController` class
    - Constructor takes `TransportSwitchDeps` (config, getCurrentTransport, setTransport, platformRefs, memory)
    - `handle(mode: "tmux" | "acp"): Promise<{ status: number; body: object }>` — implements the switch sequence:
      1. If requested mode === current mode → return 200 no-op
      2. Stop all running platform pollers
      3. Destroy current transport
      4. Create new transport from config, call `initialize()`
      5. If memory enabled, re-register LLM callback via `memory.setLlmCall()`
      6. Update shared transport reference via `setTransport()`
      7. Restart previously-running pollers
      8. On failure: attempt rollback to previous transport, return 500
    - `getTransportStatus(): TransportStatus` — returns type, isReady, contextPercent
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x] 5.2 Write property test for transport switch no-op (Property 8)
    - **Property 8: Transport switch no-op for same mode**
    - For any transport switch request where requested mode equals current mode, returns 200 without destroying or reinitializing. The transport reference remains the same object.
    - Use `fc.constantFrom("tmux", "acp")` for mode, mock transport with identity tracking
    - **Validates: Requirements 10.4**

- [x] 6. Memory search controller
  - [x] 6.1 Create `src/components/memory-search-controller.ts` with `MemorySearchController` class
    - Constructor takes `MemorySearchDeps` (memoryManager with memoryIndex access)
    - `handle(params: URLSearchParams): Promise<{ status: number; body: object }>` — parses query params:
      - `keywords` (required, comma-separated) — returns 400 if empty
      - `chatId` (required)
      - `layers` (optional, comma-separated, default `L1,L2,L3,L4`)
      - `original` (optional, needed for L4)
      - `timeStart`, `timeEnd` (optional, unix ms)
    - Layer mapping: L1 → FTS5 + relaxed + substring on messages, L2 → searchExtracted, L3 → compaction LIKE, L4 → searchOriginal (only with `original` param), L5 → empty array with `"status": "not_implemented"`
    - Deduplicates by `timestamp + content_prefix`, sorts by score descending, limits to 10
    - Returns 409 if memory is disabled
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [x] 6.2 Write property test for memory search layer selection (Property 6)
    - **Property 6: Memory search layer selection**
    - For any subset of layers {L1, L2, L3, L4, L5}, only the corresponding search stages execute. Unselected layers produce no results. L5 always returns empty with `"status": "not_implemented"`.
    - Use `fc.subarray(["L1", "L2", "L3", "L4", "L5"])` generator, mock MemoryIndex methods to track which were called
    - **Validates: Requirements 8.3, 8.4**

  - [x] 6.3 Write property test for search result deduplication and ordering (Property 7)
    - **Property 7: Search result deduplication and ordering**
    - For any set of search results from multiple layers, merged output has no duplicates (by timestamp + content prefix), is sorted by score descending, and contains at most 10 results. Empty keywords → 400, disabled memory → 409.
    - Use `fc.array(fc.record({ content: fc.string(), date: fc.date(), score: fc.float() }))` generator
    - **Validates: Requirements 8.5, 8.7, 8.8**

- [x] 7. Checkpoint — Controllers complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Status broadcaster (WebSocket push)
  - [x] 8.1 Create `src/components/status-broadcaster.ts` with `StatusBroadcaster` class
    - Constructor takes `getStatus: () => StatusSnapshot` and `intervalMs: number`
    - `addClient(socket): void` — adds client to set, sends immediate snapshot, starts interval if first client
    - `removeClient(socket): void` — removes client, stops interval if last client disconnects
    - `pushNow(): void` — force-pushes snapshot to all clients (called by controllers after state changes)
    - `shutdown(): void` — stops interval, closes all client sockets
    - Implement manual WebSocket text frame encoding (opcode 0x81) for JSON payloads
    - Handle send errors by removing broken clients and continuing to others
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 14.1, 14.2_

  - [x] 8.2 Write property test for WebSocket client list consistency (Property 12)
    - **Property 12: WebSocket client list consistency**
    - For any sequence of addClient/removeClient operations, tracked client count equals adds minus removes (clamped to 0). Broadcasting is active iff at least one client is connected.
    - Use `fc.array(fc.record({ op: fc.constantFrom("add", "remove"), clientId: fc.nat({ max: 10 }) }))` generator
    - **Validates: Requirements 4.4, 14.1**

  - [x] 8.3 Write property test for status snapshot completeness (Property 4)
    - **Property 4: Status snapshot completeness**
    - For any combination of subsystem states (memory enabled/disabled, heartbeat running/stopped, transport tmux/acp, platforms configured/unconfigured), the generated StatusSnapshot contains all required top-level fields with correct types. When memory is disabled, `memory.enabled` is `false` and `memory.stats` is `null`. When getStats() throws, snapshot includes `error` field while still containing other subsystem data.
    - Use `fc.record({ memoryEnabled: fc.boolean(), heartbeatRunning: fc.boolean(), transportType: fc.constantFrom("tmux", "acp"), ... })` generator
    - **Validates: Requirements 4.3, 6.1, 6.2, 7.1, 9.1, 11.1, 14.2**

- [x] 9. Dashboard server (HTTP + WebSocket upgrade)
  - [x] 9.1 Create `src/components/dashboard-server.ts` with `DashboardServer` class
    - Constructor takes `DashboardServerDeps` (config, getStatus, platformController, transportController, memorySearchController)
    - `start(): Promise<void>` — creates `http.Server`, listens on `config.webHost:config.webPort`
      - On `EADDRINUSE`, log error and `process.exit(1)`
      - Log listening address and port at info level
    - `stop(): Promise<void>` — close all WS connections via broadcaster.shutdown(), close HTTP server
    - Route `GET /` → serve inline HTML (unauthenticated)
    - Route `GET /api/memory/search` → auth gate → memorySearchController.handle()
    - Route `POST /api/platforms/:platform/:action` → auth gate → platformController.handle()
    - Route `POST /api/transport/switch` → auth gate → transportController.handle()
    - Handle `upgrade` event for WebSocket at `/ws` path → auth gate (query param) → manual WS handshake (SHA-1 accept key via `node:crypto`) → broadcaster.addClient()
    - Unknown routes → 404 JSON response
    - Wrap all request handlers in try/catch → 500 on unhandled errors, continue serving
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 2.3, 3.6, 14.4_

  - [x] 9.2 Write property test for unknown route returns 404 (Property 9)
    - **Property 9: Unknown route returns 404**
    - For any HTTP request path that does not match `/`, `/ws`, or any `/api/*` route, the server responds with 404.
    - Use `fc.string()` filtered to exclude known routes, mock request/response objects
    - **Validates: Requirements 2.3**

- [x] 10. Dashboard UI (inline HTML)
  - [x] 10.1 Create `src/components/dashboard-ui.ts` with `renderDashboardHtml(logoBase64: string): string`
    - Export function that returns a complete HTML string with inline CSS and JS
    - Dark theme CSS: dark background (#1a1a2e), light text, responsive grid layout
    - Header with dashboard title and Kiro Professor logo (base64 data URI)
    - Cards: Bridge Health (uptime, enabled platforms), Platforms (3 groups), Transport, Memory (with search), Heartbeat
    - Platform groups: "Access Interfaces" (Telegram, Discord — functional toggles), "External Tooling" (Projects, LM Notebook, Keep — disabled/greyed with "coming soon" tooltip), "Social Media" (X, Facebook — disabled/greyed with "coming soon" tooltip)
    - Transport card: type, connection state indicator (green/red), context window percentage progress bar
    - Memory card: stats display (human-readable sizes), search box with L1-L5 layer toggle buttons (L5 disabled with "coming soon" tooltip), search results area
    - Heartbeat card: running/stopped indicator, interval, task names list
    - Color-coded indicators: green (healthy/running), yellow (degraded/stopped-but-configured), red (error/disconnected)
    - Inline `<script>`: WebSocket connection to `/ws?token=...`, DOM update on snapshot, platform toggle API calls, transport switch API calls, memory search API calls
    - Connection-lost banner with exponential backoff reconnect (1s start, 30s max, reset on success)
    - Token input prompt on page load (stored in sessionStorage)
    - Responsive layout for desktop and tablet viewports
    - _Requirements: 2.1, 2.2, 4.3, 5.1, 5.7, 5.8, 5.9, 6.3, 7.2, 7.3, 8.1, 8.2, 8.6, 9.2, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 10.2 Write property test for reconnect exponential backoff (Property 13)
    - **Property 13: Reconnect exponential backoff**
    - Extract the backoff calculation as a pure function `getReconnectDelay(attempt: number): number`
    - For any sequence of N consecutive attempts (N ≥ 1), delay is `min(1000 * 2^(N-1), 30000)`. Never exceeds 30s, resets to 1s after success.
    - Use `fc.nat({ max: 20 })` for attempt count
    - **Validates: Requirements 12.4**

- [x] 11. Checkpoint — Server and UI complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Wire into main.ts and CLI
  - [x] 12.1 Add `--web` CLI flag parsing in `src/main.ts`
    - Parse `--web` and `--all` flags from `process.argv`
    - When `--web` or `--all` is present, set `webEnabled = true`
    - Call `loadDashboardConfig(process.env)` and `validateDashboardConfig()` when web is enabled
    - Exit with error if `WEB_AUTH_TOKEN` is not set when web is enabled
    - _Requirements: 1.1, 1.2, 3.6, 13.2_

  - [x] 12.2 Write property test for CLI flag parsing (Property 1)
    - **Property 1: CLI flag parsing determines web enablement**
    - For any set of CLI arguments, parsed result has `web: true` iff arguments contain `--web` or `--all`. All other combinations yield `web: false`.
    - Use `fc.array(fc.constantFrom("--web", "--all", "--telegram", "--discord", "--memory", "--heartbeat"))` generator
    - **Validates: Requirements 1.1, 1.2**

  - [x] 12.3 Instantiate and wire all dashboard components in `src/main.ts`
    - Read `logo/KiroProfessor.jpg`, base64-encode it
    - Build `getStatus()` function that assembles `StatusSnapshot` from all subsystem refs
    - Create `AuthGate`, `PlatformController`, `TransportController`, `MemorySearchController` (null if memory disabled)
    - Create `DashboardServer` with all deps
    - Call `dashboardServer.start()` during startup
    - After platform/transport state changes, call `dashboardServer.broadcaster.pushNow()`
    - _Requirements: 1.1, 4.3, 5.7, 10.3, 10.6, 11.1, 12.1_

  - [x] 12.4 Add graceful shutdown for dashboard server
    - In the existing SIGINT/SIGTERM handler, call `await dashboardServer?.stop()` before other cleanup
    - Ensure all WS connections are closed and server stops listening within 5 seconds
    - _Requirements: 1.3_

- [x] 13. Update `.env.example` with web-related variables
  - Add `WEB_PORT`, `WEB_HOST`, `WEB_AUTH_TOKEN`, `WEB_PUSH_INTERVAL_MS` with descriptions
  - _Requirements: 13.5_

- [x] 14. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` with vitest, consistent with existing project patterns
- Test files are co-located: `src/components/<component>.test.ts`
- WebSocket implementation is manual (no `ws` library) — uses `node:http` upgrade + `node:crypto` for handshake
- The dashboard UI is a single inline HTML string, no build step or static file directory
- Checkpoints ensure incremental validation at natural break points
- Property tests validate universal correctness properties from the design document
