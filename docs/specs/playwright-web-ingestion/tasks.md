# Implementation Plan: Playwright Web Ingestion & Agent Browser Tool

## Overview

Incrementally build the Playwright-based browser tool and webpage ingestion feature for AgentBridge. Starts with shared types and pure-logic components (DomainAllowlist, ContentExtractor), then builds the BrowserManager singleton, BrowserTool action dispatcher, CLI entry point, WebScraper with hybrid fetch-first strategy, ingestion pipeline extension, command handler updates, and finally the SKILL.md. Each task builds on the previous, with property-based tests close to the implementation they validate.

## Tasks

- [x] 1. Install Playwright dependency and define browser types
  - [x] 1.1 Add `playwright` to `package.json` dependencies and add `agentbridge-browser` to the `bin` field
    - Run `npm install playwright`
    - Add `"agentbridge-browser": "dist/cli/agentbridge-browser.js"` to the `bin` field in `package.json`
    - _Requirements: 1.1, 19.2_

  - [x] 1.2 Create `src/types/browser.ts` with all browser-related types
    - Define `BrowserActionType`, `BrowserAction`, `BrowserToolResult`, `PageElement`, `BrowserSession` types exactly as specified in the design document
    - Export all types from `src/types/index.ts`
    - _Requirements: 1.2, 1.4, 7.1_

  - [x] 1.3 Extend `IngestionSource` type in `src/types/memory.ts`
    - Add `"webpage"` to the `IngestionSource.type` union: `"youtube" | "pdf" | "text" | "markdown" | "webpage"`
    - _Requirements: 12.1_

- [x] 2. Implement DomainAllowlist
  - [x] 2.1 Create `src/components/domain-allowlist.ts`
    - Implement `DomainAllowlist` class with constructor accepting `string[]` patterns
    - Implement `isAllowed(url: string): boolean` — parse URL hostname, match against patterns
    - Support wildcard prefixes (`*.example.com` matches any subdomain) and exact matches (`example.com`)
    - Implement `isOpenMode` getter (true when no patterns configured)
    - Implement `patterns` getter for error messages
    - Read patterns from `BROWSER_ALLOWED_DOMAINS` env var (comma-separated)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 2.2 Write property test for domain allowlist matching
    - **Property 3: Domain allowlist matching**
    - Generate random URLs and pattern sets, verify: empty set → all allowed; non-empty set → allowed iff hostname matches at least one pattern; `*.X` matches subdomains; bare `X` matches exact; rejected URLs produce error containing hostname and patterns list
    - **Validates: Requirements 2.3, 9.2, 9.3, 9.4, 9.5**

- [x] 3. Implement ContentExtractor
  - [x] 3.1 Create `src/components/content-extractor.ts`
    - Implement `extractTextFromHtml(html: string): string` — parse raw HTML, remove `script`/`style`/`nav`/`footer`/`header`/`aside` elements and elements with `role="navigation"` or `role="banner"`, strip all HTML tags, collapse consecutive whitespace, decode HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`), return plain text
    - Implement `extractTextFromPage(page: Page, selector?: string): Promise<string>` — run extraction logic in Playwright page context via `page.evaluate()`, optionally scoped to a CSS selector
    - Return empty string on empty input (callers treat as extraction failure)
    - _Requirements: 5.1, 5.2, 5.3, 14.2, 17.1, 17.2, 17.3, 17.4, 17.5_

  - [x] 3.2 Write property test for ContentExtractor produces clean text
    - **Property 4: ContentExtractor produces clean text**
    - Generate random HTML strings containing script/style/nav/footer/header/aside elements, verify output has no HTML tags, no content from stripped elements, no consecutive whitespace, and all common HTML entities are decoded
    - **Validates: Requirements 5.3, 14.2, 17.1, 17.2, 17.3, 17.4**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement BrowserManager singleton
  - [x] 5.1 Create `src/components/browser-manager.ts`
    - Implement `BrowserManager` class as a singleton
    - Lazy-launch headless Chromium on first request via `chromium.launch({ headless: true, args: ['--no-sandbox'] })`
    - Detect browser disconnection via `browser.on('disconnected')` and re-launch on next request
    - Implement `getSession(sessionId: string): Promise<BrowserSession>` — create or reuse named sessions, track in `Map<string, BrowserSession>`, update `lastActivityAt` on reuse
    - Implement `closeSession(sessionId: string): Promise<void>` — close context, remove from map
    - Implement `createOneOffContext(): Promise<{ context, page }>` — for ingestion scrapes, no session tracking
    - Implement `closeContext(context): Promise<void>` — close a one-off context
    - Implement `shutdown(): Promise<void>` — close all sessions, close browser, clear idle timer
    - Implement `activeSessionCount` getter
    - Enforce `BROWSER_MAX_SESSIONS` (default 3) — reject new sessions when limit reached
    - Run idle-check interval that closes sessions exceeding `BROWSER_SESSION_TIMEOUT_MS` (default 300000ms)
    - Set `WEB_SCRAPE_USER_AGENT` on all contexts
    - Read and validate env vars with defaults: `BROWSER_SESSION_TIMEOUT_MS`, `BROWSER_MAX_SESSIONS`, `WEB_SCRAPE_USER_AGENT`; log warning and use default for invalid values
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 18.1, 18.4, 18.5, 19.1, 19.3_

  - [x] 5.2 Write property test for session create-or-reuse idempotence
    - **Property 7: Session create-or-reuse idempotence**
    - Generate random session ID strings, verify first `getSession(id)` creates a new session, subsequent `getSession(id)` returns the same BrowserSession (same context, same page)
    - **Validates: Requirements 8.1, 8.2**

  - [x] 5.3 Write property test for max sessions enforcement
    - **Property 10: Max sessions enforcement**
    - Configure a random max-session limit N, create N sessions, verify creating session N+1 returns an error and `activeSessionCount` remains N
    - **Validates: Requirements 8.5**

  - [x] 5.4 Write property test for environment variable parsing with defaults
    - **Property 16: Environment variable parsing with defaults**
    - Generate random env var values (valid numbers, invalid strings, unset), verify each config parameter resolves to parsed value when valid or documented default when invalid/unset, and invalid values trigger a log warning
    - **Validates: Requirements 18.1, 18.5**

- [x] 6. Implement BrowserTool action dispatcher
  - [x] 6.1 Create `src/components/browser-tool.ts`
    - Implement `BrowserTool` class with constructor accepting `BrowserManager` and `DomainAllowlist`
    - Implement `execute(action: BrowserAction): Promise<BrowserToolResult>` dispatching to action handlers:
    - **navigate**: check DomainAllowlist, get session, `page.goto(url, { waitUntil: 'domcontentloaded', timeout })`, return `{ success, title, url, status }`; on allowlist rejection return error with rejected domain and allowed patterns; on timeout/network error return error with URL
    - **click**: get session, `page.click(selector)`, detect navigation, return `{ success, navigated, title?, url? }`; support text selectors (`text=...`); on selector not found return error
    - **fill**: get session, `page.fill(selector, value)`, return `{ success }`; mask password values in logs (replace with `***`); do not include password values in JSON response; on selector not found return error
    - **extract_text**: get session, call `ContentExtractor.extractTextFromPage(page, selector?)`, truncate at 4000 chars with `truncated: true` flag; on empty text return error; on selector not found return error
    - **screenshot**: get session, `page.screenshot({ fullPage?, path: tmpFile })`, return `{ success, filePath }`
    - **get_page_info**: get session, evaluate page to collect interactive elements (links, buttons, inputs) with selectors/text/type/name/placeholder/href, cap at 50 elements, return `{ success, url, title, elements }`
    - **close_session**: call `BrowserManager.closeSession(sessionId)`, return `{ success }`
    - All results are JSON-serializable with `success` boolean; failures include `error` string
    - Use `WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS` for navigation timeout
    - _Requirements: 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.4, 5.5, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 8.3, 10.1, 10.2, 10.3_

  - [x] 6.2 Write property test for JSON output structure invariant
    - **Property 2: JSON output structure invariant**
    - For any browser tool execution (success or failure), verify output is valid JSON containing `success` boolean; on failure additionally contains `error` string
    - **Validates: Requirements 1.4**

  - [x] 6.3 Write property test for text truncation at 4000 characters
    - **Property 5: Text truncation at 4000 characters**
    - Generate random strings of varying lengths, verify: if length > 4000 then response text ≤ 4000 chars and `truncated` is true; if length ≤ 4000 then full text returned and `truncated` is false
    - **Validates: Requirements 5.4**

  - [x] 6.4 Write property test for interactive element list capped at 50
    - **Property 6: Interactive element list capped at 50**
    - Generate pages with N interactive elements, verify `get_page_info` response contains at most 50 elements
    - **Validates: Requirements 7.2**

  - [x] 6.5 Write property test for credential masking
    - **Property 11: Credential masking**
    - For any `fill` action targeting a password-type input, verify password value never appears in log output or JSON response; logs contain action name, session ID, and URL but password replaced with `***`
    - **Validates: Requirements 10.1, 10.2, 10.3**

  - [x] 6.6 Write property test for error responses include URL
    - **Property 17: Error responses include URL**
    - Generate random URLs, simulate navigation/ingestion/extraction failures, verify error message string contains the URL that caused the failure
    - **Validates: Requirements 2.4, 12.4, 15.5**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement BrowserTool CLI entry point
  - [x] 8.1 Create `src/cli/agentbridge-browser.ts`
    - Follow the same pattern as `src/cli/agentbridge-store.ts` and `src/cli/agentbridge-recall.ts`
    - Parse argv: `--action`, `--url`, `--selector`, `--value`, `--session-id` (default: "default"), `--full-page` flag
    - Validate `--action` is one of the 7 valid action types; reject invalid actions with JSON error
    - Validate required params per action (e.g., `navigate` requires `--url`, `click` requires `--selector`, `fill` requires `--selector` and `--value`)
    - Instantiate `DomainAllowlist` (from `BROWSER_ALLOWED_DOMAINS` env var), `BrowserManager`, `BrowserTool`
    - Execute action, print JSON result to stdout
    - Handle IPC to main process BrowserManager via Unix domain socket (`~/.agentbridge/browser.sock`); fall back to ephemeral browser if main process not running
    - Export `parseArgs` and `validateArgs` for unit testing
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 8.2 Write property test for CLI action validation
    - **Property 1: CLI action validation**
    - Generate random strings as `--action` parameter, verify only `navigate`, `click`, `fill`, `extract_text`, `screenshot`, `get_page_info`, `close_session` are accepted; all others rejected with error
    - **Validates: Requirements 1.2**

- [x] 9. Implement WebScraper with hybrid fetch-first strategy
  - [x] 9.1 Create `src/components/web-scraper.ts`
    - Implement `WebScraper` class with constructor accepting `BrowserManager`
    - Implement `extractText(url: string): Promise<string>` with hybrid strategy:
      1. Try `fetch(url)` with `WEB_SCRAPE_FETCH_TIMEOUT_MS` timeout (default 15000) and `WEB_SCRAPE_USER_AGENT` header
      2. Parse HTML response with `ContentExtractor.extractTextFromHtml()`
      3. If extracted text ≥ 200 chars trimmed → return (static page done)
      4. If text < 200 chars or fetch failed (network error, non-2xx, timeout) → fall back to Playwright
      5. Playwright fallback: `BrowserManager.createOneOffContext()`, set up `page.route()` to block images/fonts/video/CSS (`**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot,mp4,webm,avi,css}`), navigate with `WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS` timeout, extract via `ContentExtractor.extractTextFromPage()`, close one-off context
      6. If Playwright also fails → throw descriptive error including URL
    - If extracted text is empty after cleaning → throw error with URL
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 15.1, 15.2, 15.3, 15.4, 15.5, 16.1, 16.2, 16.3, 16.4, 18.2, 18.3, 18.4_

  - [x] 9.2 Write property test for fetch-first fallback threshold
    - **Property 15: Fetch-first fallback threshold**
    - For any URL, verify Playwright fallback is invoked iff fetch strategy either failed or produced text with trimmed length < 200 characters
    - **Validates: Requirements 14.3, 14.4**

- [x] 10. Extend IngestionPipeline for webpage source type
  - [x] 10.1 Update `src/components/ingestion-pipeline.ts` to handle `"webpage"` source type
    - Add a `case "webpage":` to the `switch` in `ingest()` method
    - Instantiate `WebScraper` (passing `BrowserManager` singleton) and call `webScraper.extractText(source.identifier)` to get text
    - The rest of the pipeline (chunking, embedding, storing) remains unchanged
    - Record `source_type` as `"webpage"` and `identifier` as the original URL in `ingested_documents`
    - If WebScraper returns empty text, throw error with descriptive message including URL
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x] 10.2 Write property test for webpage ingestion metadata
    - **Property 13: Webpage ingestion metadata**
    - For any successful webpage ingestion, verify the `ingested_documents` record has `source_type` = `"webpage"` and `identifier` = original URL
    - **Validates: Requirements 12.3**

- [x] 11. Update /ingest command handlers for URL auto-detection
  - [x] 11.1 Update Telegram `/ingest` handler in `src/main.ts`
    - Modify the source type auto-detection logic to add `"webpage"` detection:
      - If arg starts with `http://` or `https://` and hostname matches `youtube.com`, `www.youtube.com`, `m.youtube.com`, or `youtu.be` → `"youtube"`
      - If arg starts with `http://` or `https://` and hostname does NOT match YouTube → `"webpage"`
      - Otherwise → existing file-extension logic (pdf, markdown, text)
    - Update the `sourceType` type annotation to include `"webpage"`
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [x] 11.2 Update Discord `/ingest` handler in `src/main.ts` with identical URL auto-detection logic
    - Apply the same detection logic as 11.1 to the Discord handler
    - _Requirements: 13.4_

  - [x] 11.3 Write property test for URL auto-detection
    - **Property 14: URL auto-detection**
    - Generate random URLs (YouTube and non-YouTube HTTP/HTTPS) and file paths, verify: YouTube URLs → `"youtube"`, non-YouTube HTTP URLs → `"webpage"`, non-HTTP strings → existing file-extension logic
    - **Validates: Requirements 13.1, 13.2, 13.3**

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Wire BrowserManager into main.ts and handle shutdown
  - [x] 13.1 Initialize BrowserManager singleton in `src/main.ts`
    - Create and export a `BrowserManager` singleton instance
    - Wire `BrowserManager.shutdown()` into the existing shutdown handler so the browser closes gracefully on process exit
    - Pass the BrowserManager to the IngestionPipeline (or make it accessible for WebScraper construction)
    - _Requirements: 11.4, 11.5_

  - [x] 13.2 Write property test for browser singleton reuse
    - **Property 12: Browser singleton reuse**
    - For any sequence of `getSession()` or `createOneOffContext()` calls, verify BrowserManager uses the same underlying Chromium instance (no duplicate launches) while browser remains connected
    - **Validates: Requirements 11.3**

  - [x] 13.3 Write property test for session close removes session
    - **Property 8: Session close removes session**
    - For any active session ID, after `closeSession(id)`, verify session no longer exists in manager and subsequent `getSession(id)` creates a fresh session (different context)
    - **Validates: Requirements 8.3**

  - [x] 13.4 Write property test for idle timeout cleanup
    - **Property 9: Idle timeout cleanup**
    - For any session whose `lastActivityAt` is older than `BROWSER_SESSION_TIMEOUT_MS`, verify idle-check sweep closes that session and removes it from the session map
    - **Validates: Requirements 8.4**

- [x] 14. Create SKILL.md for the browser tool
  - [x] 14.1 Create `skills/browser/SKILL.md`
    - Follow the same frontmatter + sections structure as `skills/memory-search/SKILL.md` and `skills/instant-store/SKILL.md`
    - Frontmatter: `name: browser`, `description: ...`, `user-invocable: false`
    - Document all 7 actions (navigate, click, fill, extract_text, screenshot, get_page_info, close_session) with parameter descriptions and example invocations
    - Include "When to use" section: complex authentication flows, multi-step form interactions, reading authenticated pages, JavaScript-rendered UIs
    - Include "When NOT to use" section: prefer simpler approaches (direct API calls, web_search) when full browser not needed
    - Include example multi-step workflow: navigate → fill username → fill password → click submit → extract_text to verify success
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The project uses TypeScript, vitest for testing, fast-check for property-based testing
- The BrowserManager singleton is shared between the agent tool path and the ingestion path
- Resource blocking (images/fonts/video/CSS) applies only to ingestion scrapes, not agent sessions
- The CLI communicates with the main process BrowserManager via Unix domain socket for session persistence
