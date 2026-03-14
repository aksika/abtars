# Requirements Document

## Introduction

The AgentBridge agent currently has tools for memory search (`agentbridge-recall`) and instant storage (`agentbridge-store`), but lacks the ability to interact with web pages beyond simple text retrieval. This feature introduces a Playwright-based headless browser as an agent-callable tool — the primary goal is giving the agent full browser control for complex authentication flows, multi-step navigation, form filling, and reading content from authenticated or protected pages. The browser tool follows the existing skill pattern (shell command + SKILL.md) and works alongside the existing tools. As a secondary use case, the `/ingest` command gains a "webpage" source type that delegates to the same Browser_Manager for scraping web content into memory. A singleton Browser_Manager handles Playwright lifecycle (lazy initialization, session management, graceful shutdown). A hybrid fetch-first strategy is used for simple ingestion, while the agent tool always uses the full Playwright browser for maximum capability.

## Glossary

- **Browser_Tool**: The agent-callable tool (exposed as a shell command and SKILL.md) that gives the LLM agent direct browser control — navigate, click, fill forms, extract text, take screenshots, and manage sessions. Analogous to `agentbridge-recall` and `agentbridge-store`.
- **Browser_Manager**: A singleton component that lazily initializes a headless Chromium browser instance via Playwright, manages named browser sessions (contexts) for the agent, provides one-off contexts for ingestion scrapes, and handles graceful shutdown.
- **Browser_Session**: A named Playwright BrowserContext that persists cookies, localStorage, and session state across multiple Browser_Tool invocations. Identified by a session_id string. Enables multi-step workflows like login-then-browse.
- **Web_Scraper**: The component responsible for fetching web page content for ingestion, extracting clean text, and returning it to the Ingestion_Pipeline. Implements the hybrid fetch-first/Playwright-fallback strategy.
- **Ingestion_Pipeline**: The existing component (`IngestionPipeline` class) that accepts external documents, extracts text, chunks it, generates embeddings, and stores metadata. Extended to support the "webpage" source type.
- **Content_Extractor**: The logic that strips non-content elements (scripts, styles, navigation, footers, headers, ads) from HTML and returns clean body text. Used by both the Browser_Tool (extract_text action) and the Web_Scraper.
- **Fetch_Strategy**: The lightweight first-pass extraction approach that uses Node.js native `fetch()` to retrieve raw HTML and parses it without a browser, suitable for static or server-rendered pages. Used only by the ingestion path.
- **Playwright_Strategy**: The extraction approach that uses a headless Chromium page via Browser_Manager, renders JavaScript, and extracts text from the fully rendered DOM. Used by both the ingestion fallback and the Browser_Tool.
- **Memory_Manager**: The existing top-level coordinator (`MemoryManager` class) that exposes `ingestDocument()` and delegates to the Ingestion_Pipeline.
- **Domain_Allowlist**: A configurable list of URL patterns that the Browser_Tool is permitted to navigate to. Prevents the agent from browsing arbitrary or dangerous domains.

## Requirements

### Requirement 1: Agent-Callable Browser Tool

**User Story:** As an LLM agent, I want a browser tool I can call to navigate web pages, fill forms, click elements, and extract content, so that I can perform complex authentication procedures and interact with web UIs that require a real browser.

#### Acceptance Criteria

1. THE Browser_Tool SHALL be exposed as a shell command (`agentbridge-browser`) following the same pattern as `agentbridge-recall` and `agentbridge-store`.
2. THE Browser_Tool SHALL accept an `--action` parameter specifying the browser action to perform: `navigate`, `click`, `fill`, `extract_text`, `screenshot`, `get_page_info`, `close_session`.
3. THE Browser_Tool SHALL accept a `--session-id` parameter (optional, default: "default") that identifies which Browser_Session to use, enabling the agent to maintain multiple independent browser sessions.
4. THE Browser_Tool SHALL return structured JSON results that the agent can reason about, including success/failure status, extracted data, and page state information.
5. THE Browser_Tool SHALL have a corresponding SKILL.md file that describes all actions, parameters, usage guidance, and examples for the LLM agent.

### Requirement 2: Browser Navigate Action

**User Story:** As an LLM agent, I want to navigate the browser to a URL, so that I can access web pages for authentication flows and content reading.

#### Acceptance Criteria

1. WHEN the Browser_Tool receives action "navigate" with a `--url` parameter, THE Browser_Tool SHALL navigate the Browser_Session's page to the specified URL and wait for the "domcontentloaded" event.
2. WHEN navigation completes successfully, THE Browser_Tool SHALL return JSON containing the page title, the final URL (after redirects), and the HTTP status code.
3. IF the URL does not match the Domain_Allowlist, THEN THE Browser_Tool SHALL reject the request with an error message listing the allowed domain patterns.
4. IF navigation fails due to timeout or network error, THEN THE Browser_Tool SHALL return a JSON error response with a descriptive message including the URL and the underlying error.

### Requirement 3: Browser Click Action

**User Story:** As an LLM agent, I want to click elements on a web page, so that I can interact with buttons, links, and UI controls during authentication flows and multi-step navigation.

#### Acceptance Criteria

1. WHEN the Browser_Tool receives action "click" with a `--selector` parameter, THE Browser_Tool SHALL click the element matching the CSS selector on the current page.
2. WHEN the click triggers a navigation, THE Browser_Tool SHALL wait for the navigation to complete and return the new page title and URL.
3. WHEN the click does not trigger a navigation, THE Browser_Tool SHALL return a success status confirming the click was performed.
4. IF no element matches the selector, THEN THE Browser_Tool SHALL return an error response indicating the selector did not match any visible element.
5. THE Browser_Tool SHALL support Playwright text selectors (e.g., `text=Sign In`) in addition to CSS selectors, so the agent can target elements by visible text.

### Requirement 4: Browser Fill Action

**User Story:** As an LLM agent, I want to fill form fields on a web page, so that I can enter credentials, search queries, and other input during authentication and interaction flows.

#### Acceptance Criteria

1. WHEN the Browser_Tool receives action "fill" with `--selector` and `--value` parameters, THE Browser_Tool SHALL clear the matching input field and type the specified value.
2. WHEN the fill action completes, THE Browser_Tool SHALL return a success status confirming the value was entered.
3. IF no element matches the selector, THEN THE Browser_Tool SHALL return an error response indicating the selector did not match any input element.
4. THE Browser_Tool SHALL support filling password fields, text inputs, textareas, and other standard HTML form elements.

### Requirement 5: Browser Extract Text Action

**User Story:** As an LLM agent, I want to extract text content from the current page, so that I can read page content, verify login success, and gather information from authenticated pages.

#### Acceptance Criteria

1. WHEN the Browser_Tool receives action "extract_text" with no selector, THE Browser_Tool SHALL extract clean text from the entire page body using the Content_Extractor.
2. WHEN the Browser_Tool receives action "extract_text" with a `--selector` parameter, THE Browser_Tool SHALL extract text only from the element matching the selector.
3. THE Content_Extractor SHALL remove script, style, nav, footer, header, and aside elements, collapse whitespace, and decode HTML entities before returning text.
4. WHEN the extracted text exceeds 4000 characters, THE Browser_Tool SHALL truncate the text and include a `truncated: true` flag in the response, so the agent knows the full content was not returned.
5. IF no element matches the provided selector, THEN THE Browser_Tool SHALL return an error response indicating the selector did not match any element.

### Requirement 6: Browser Screenshot Action

**User Story:** As an LLM agent, I want to take a screenshot of the current page, so that I can visually verify page state during complex authentication flows (e.g., CAPTCHA detection, unexpected UI states).

#### Acceptance Criteria

1. WHEN the Browser_Tool receives action "screenshot", THE Browser_Tool SHALL capture a PNG screenshot of the current page viewport.
2. THE Browser_Tool SHALL save the screenshot to a temporary file and return the file path in the JSON response.
3. WHEN the Browser_Tool receives an optional `--full-page` flag, THE Browser_Tool SHALL capture the full scrollable page instead of just the viewport.

### Requirement 7: Browser Get Page Info Action

**User Story:** As an LLM agent, I want to get information about the current page state, so that I can decide what action to take next during multi-step flows.

#### Acceptance Criteria

1. WHEN the Browser_Tool receives action "get_page_info", THE Browser_Tool SHALL return JSON containing: the current URL, page title, and a list of visible interactive elements (links, buttons, inputs) with their selectors and text content.
2. THE interactive element list SHALL be limited to the first 50 elements to keep the response size manageable for the agent's context.
3. WHEN the page has form elements, THE Browser_Tool SHALL include form field names, types, and placeholder text in the element list.

### Requirement 8: Browser Session Persistence

**User Story:** As an LLM agent, I want browser sessions to persist across multiple tool calls, so that I can log in on one call and then browse authenticated pages on subsequent calls without losing cookies or session state.

#### Acceptance Criteria

1. WHEN the Browser_Tool receives a request with a session_id that does not yet exist, THE Browser_Manager SHALL create a new Browser_Session (Playwright BrowserContext) and associate it with that session_id.
2. WHEN the Browser_Tool receives a request with a session_id that already exists, THE Browser_Manager SHALL reuse the existing Browser_Session, preserving all cookies, localStorage, and page state.
3. WHEN the Browser_Tool receives action "close_session", THE Browser_Manager SHALL close the Browser_Session associated with the given session_id and release its resources.
4. THE Browser_Manager SHALL automatically close Browser_Sessions that have been idle for longer than a configurable timeout (environment variable `BROWSER_SESSION_TIMEOUT_MS`, default 300000ms / 5 minutes) to prevent resource leaks.
5. THE Browser_Manager SHALL support a maximum number of concurrent sessions (environment variable `BROWSER_MAX_SESSIONS`, default 3) and reject new session creation when the limit is reached, returning an error suggesting the agent close an existing session.

### Requirement 9: Browser Tool Security — Domain Allowlist

**User Story:** As a bridge operator, I want to restrict which domains the browser tool can navigate to, so that the agent cannot browse arbitrary or potentially dangerous websites.

#### Acceptance Criteria

1. THE Browser_Tool SHALL read a Domain_Allowlist from the environment variable `BROWSER_ALLOWED_DOMAINS` (comma-separated list of domain patterns, e.g., "*.example.com,login.service.io").
2. WHEN `BROWSER_ALLOWED_DOMAINS` is not set or empty, THE Browser_Tool SHALL allow navigation to all domains (open mode for development).
3. WHEN `BROWSER_ALLOWED_DOMAINS` is set, THE Browser_Tool SHALL reject navigation to URLs whose hostname does not match any pattern in the allowlist.
4. THE Domain_Allowlist SHALL support wildcard prefixes (e.g., "*.example.com" matches "login.example.com" and "app.example.com") and exact matches (e.g., "example.com").
5. IF a navigation request is rejected by the Domain_Allowlist, THEN THE Browser_Tool SHALL return an error response that includes the rejected domain and the list of allowed patterns.

### Requirement 10: Browser Tool Security — Credential Handling

**User Story:** As a bridge operator, I want credentials used by the browser tool to be handled securely, so that passwords and tokens are not leaked into logs or memory storage.

#### Acceptance Criteria

1. WHEN the Browser_Tool performs a "fill" action on a password field (input type="password"), THE Browser_Tool SHALL mask the value in all log output, replacing it with "***".
2. THE Browser_Tool SHALL NOT include password field values in its JSON response output.
3. THE Browser_Tool log entries SHALL include the action performed, session_id, and target URL, but SHALL NOT include form field values for password-type inputs.

### Requirement 11: Singleton Browser Lifecycle Management

**User Story:** As a bridge operator, I want the Playwright browser to be managed as a singleton with lazy initialization and graceful shutdown, so that resources are used efficiently and the process exits cleanly.

#### Acceptance Criteria

1. THE Browser_Manager SHALL lazily initialize the Chromium browser instance on the first Browser_Tool invocation or ingestion scrape request, not at application startup.
2. WHEN the Browser_Manager is asked for a browser instance and no connected browser exists, THE Browser_Manager SHALL launch a new headless Chromium browser.
3. WHEN the Browser_Manager is asked for a browser instance and a connected browser already exists, THE Browser_Manager SHALL return the existing instance without launching a new one.
4. THE Browser_Manager SHALL expose a `shutdown()` method that closes all Browser_Sessions, closes the browser instance, and releases all resources.
5. WHEN the application process receives a shutdown signal, THE Browser_Manager shutdown method SHALL be called to close the browser gracefully.
6. IF the browser process crashes or disconnects unexpectedly, THEN THE Browser_Manager SHALL detect the disconnection and launch a new browser on the next request.

### Requirement 12: Add Webpage Source Type to Ingestion Pipeline

**User Story:** As a bridge user, I want to ingest web pages by providing a URL to the `/ingest` command, so that I can add web content to the agent's memory.

#### Acceptance Criteria

1. THE Ingestion_Pipeline SHALL support a "webpage" source type in addition to the existing "youtube", "pdf", "text", and "markdown" types.
2. WHEN the Ingestion_Pipeline receives a source with type "webpage", THE Ingestion_Pipeline SHALL delegate text extraction to the Web_Scraper and then chunk, embed, and store the result using the existing pipeline.
3. WHEN the Web_Scraper returns extracted text, THE Ingestion_Pipeline SHALL record the source_type as "webpage" and the identifier as the original URL in the `ingested_documents` table.
4. IF the Web_Scraper fails to extract any text from the URL, THEN THE Ingestion_Pipeline SHALL throw an error with a descriptive message including the URL.

### Requirement 13: URL Auto-Detection in /ingest Command

**User Story:** As a bridge user, I want the `/ingest` command to automatically recognize non-YouTube HTTP/HTTPS URLs as web pages, so that I do not need to specify the source type manually.

#### Acceptance Criteria

1. WHEN the `/ingest` argument starts with "http://" or "https://" and does not match a YouTube domain (youtube.com, youtu.be), THE command handler SHALL set the source type to "webpage".
2. WHEN the `/ingest` argument starts with "http://" or "https://" and matches a YouTube domain, THE command handler SHALL continue to set the source type to "youtube" as before.
3. WHEN the `/ingest` argument does not start with "http://" or "https://", THE command handler SHALL apply the existing file-extension-based detection logic (pdf, markdown, text).
4. THE URL auto-detection logic SHALL apply identically in both the Telegram and Discord command handlers.

### Requirement 14: Hybrid Fetch-First Extraction for Ingestion

**User Story:** As a bridge operator, I want web ingestion to try a lightweight fetch before launching a browser, so that static pages are ingested quickly without unnecessary resource usage.

#### Acceptance Criteria

1. WHEN the Web_Scraper receives a URL for ingestion, THE Web_Scraper SHALL first attempt to retrieve the page using Node.js native `fetch()` with a configurable timeout (default: 15 seconds).
2. WHEN the Fetch_Strategy retrieves an HTML response, THE Content_Extractor SHALL parse the HTML, remove non-content elements (script, style, nav, footer, header, aside tags), and extract the remaining body text.
3. WHEN the Fetch_Strategy produces extracted text with a trimmed length of 200 characters or more, THE Web_Scraper SHALL return that text without invoking the Playwright_Strategy.
4. WHEN the Fetch_Strategy produces extracted text with a trimmed length of fewer than 200 characters, THE Web_Scraper SHALL treat the page as JavaScript-rendered and fall back to the Playwright_Strategy.
5. IF the Fetch_Strategy request fails (network error, non-2xx HTTP status, or timeout), THEN THE Web_Scraper SHALL fall back to the Playwright_Strategy.
6. THE Fetch_Strategy SHALL send a configurable User-Agent header (default: "Mozilla/5.0 (compatible; AgentBridge/1.0)").

### Requirement 15: Playwright Fallback Extraction for Ingestion

**User Story:** As a bridge user, I want JavaScript-rendered pages (SPAs, dynamic content) to be ingested correctly, so that the agent can learn from modern web applications.

#### Acceptance Criteria

1. WHEN the Web_Scraper falls back to the Playwright_Strategy, THE Browser_Manager SHALL provide a one-off headless Chromium browser context (not a named session) for the scrape operation.
2. WHEN the Playwright_Strategy navigates to the URL, THE Playwright_Strategy SHALL wait for the "domcontentloaded" event with a configurable navigation timeout (default: 30 seconds).
3. WHEN the page has loaded, THE Playwright_Strategy SHALL execute the Content_Extractor in the page context to extract clean text.
4. WHEN the Playwright_Strategy completes extraction, THE Browser_Manager SHALL close the one-off browser context used for that scrape to free memory.
5. IF the Playwright_Strategy navigation times out or throws an error, THEN THE Web_Scraper SHALL throw an error with a descriptive message including the URL and the underlying error.

### Requirement 16: Resource Blocking for Ingestion Scrapes

**User Story:** As a bridge operator, I want the Playwright browser to block unnecessary resources during ingestion scrapes, so that page loads are faster and use less bandwidth and memory.

#### Acceptance Criteria

1. WHEN the Playwright_Strategy creates a page for ingestion, THE Playwright_Strategy SHALL set up route interception to abort requests for image files (png, jpg, jpeg, gif, svg, webp), font files (woff, woff2, ttf, eot), video files (mp4, webm, avi), and CSS stylesheets.
2. THE resource blocking SHALL use Playwright's `page.route()` API with a glob pattern matching the blocked file extensions.
3. THE Playwright_Strategy SHALL allow HTML, JavaScript, and XHR/fetch requests to proceed unblocked, so that JavaScript-rendered content loads correctly.
4. THE Browser_Tool agent sessions SHALL NOT apply resource blocking by default, since the agent may need full page rendering for authentication flows and UI interaction.

### Requirement 17: Content Extraction Quality

**User Story:** As a bridge user, I want ingested web pages and extracted text to contain clean, readable text without HTML artifacts, so that the agent's memory and responses contain useful content.

#### Acceptance Criteria

1. THE Content_Extractor SHALL remove all HTML tags from the extracted text, returning plain text only.
2. THE Content_Extractor SHALL collapse multiple consecutive whitespace characters (spaces, tabs, newlines) into single separators to produce readable output.
3. THE Content_Extractor SHALL decode common HTML entities (&amp;, &lt;, &gt;, &quot;, &#39;, &nbsp;) into their plain text equivalents.
4. THE Content_Extractor SHALL strip elements with common non-content roles: script, style, nav, footer, header, aside, and elements with role="navigation" or role="banner" attributes.
5. WHEN the final extracted text is empty after cleaning, THE Content_Extractor SHALL report extraction failure rather than returning an empty string.

### Requirement 18: Configurable Timeouts and User-Agent

**User Story:** As a bridge operator, I want scraping timeouts, session limits, and User-Agent to be configurable via environment variables, so that I can tune behavior for different network conditions and target sites.

#### Acceptance Criteria

1. THE system SHALL read the following environment variables: `WEB_SCRAPE_FETCH_TIMEOUT_MS` (number, default 15000), `WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS` (number, default 30000), `WEB_SCRAPE_USER_AGENT` (string, default "Mozilla/5.0 (compatible; AgentBridge/1.0)"), `BROWSER_SESSION_TIMEOUT_MS` (number, default 300000), `BROWSER_MAX_SESSIONS` (number, default 3), `BROWSER_ALLOWED_DOMAINS` (string, default empty).
2. WHEN the Fetch_Strategy makes an HTTP request, THE Fetch_Strategy SHALL use the `WEB_SCRAPE_FETCH_TIMEOUT_MS` value as the request timeout.
3. WHEN the Playwright_Strategy or Browser_Tool navigates to a page, THE strategy SHALL use the `WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS` value as the navigation timeout.
4. WHEN the Fetch_Strategy or Playwright_Strategy sets a User-Agent, THE strategy SHALL use the `WEB_SCRAPE_USER_AGENT` value.
5. IF an environment variable contains an invalid value, THEN THE system SHALL log a warning and use the default value.

### Requirement 19: WSL and Headless Environment Compatibility

**User Story:** As a bridge operator running on WSL, I want Playwright to work in headless mode without requiring an X server or display, so that the browser tool and web ingestion work in my server environment.

#### Acceptance Criteria

1. THE Browser_Manager SHALL launch Chromium in headless mode by default, requiring no display server or GUI environment.
2. THE Browser_Manager SHALL function correctly in WSL2 environments after Playwright system dependencies have been installed via `npx playwright install-deps chromium`.
3. THE Browser_Manager SHALL set the `--no-sandbox` Chromium argument when running in environments where sandboxing is unavailable (common in WSL and Docker).

### Requirement 20: Browser Tool SKILL.md Definition

**User Story:** As an LLM agent, I want clear documentation of the browser tool's capabilities, parameters, and usage patterns, so that I can invoke it correctly for authentication flows and web interaction.

#### Acceptance Criteria

1. THE Browser_Tool SHALL have a SKILL.md file in `skills/browser/SKILL.md` following the same structure as the existing `skills/memory-search/SKILL.md` and `skills/instant-store/SKILL.md`.
2. THE SKILL.md SHALL document all actions (navigate, click, fill, extract_text, screenshot, get_page_info, close_session) with parameter descriptions and example invocations.
3. THE SKILL.md SHALL include a "When to use" section that guides the agent to use the browser tool for: complex authentication flows, multi-step form interactions, reading content from authenticated pages, and interacting with JavaScript-rendered UIs.
4. THE SKILL.md SHALL include a "When NOT to use" section that guides the agent to prefer simpler approaches (direct API calls, the existing web_search tool) when a full browser is not needed.
5. THE SKILL.md SHALL include example multi-step workflows (e.g., login flow: navigate → fill username → fill password → click submit → extract_text to verify success).
