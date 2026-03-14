# Implementation Plan: NotebookLM RAG Integration (Layer 6)

## Overview

Incremental implementation of the NotebookLM RAG integration, building from types → config → core components → CLI → skill → Telegram commands → wiring. Each task builds on the previous, with property-based tests placed close to the code they validate.

## Tasks

- [x] 1. Define types and configuration
  - [x] 1.1 Create `src/types/notebooklm.ts` with all NotebookLM type definitions
    - Define `NotebookLMConfig`, `RAGResult`, `RAGCitation`, `SourceDescriptor`, `SourceInfo`, `NotebookInfo`, `NotebookRegistryEntry`, `NotebookRegistryData`, `KBQueryResult`, `KBErrorResult`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.1, 6.1_

  - [x] 1.2 Export new types from `src/types/index.ts`
    - Add re-exports for all types defined in `notebooklm.ts`
    - _Requirements: 1.1_

  - [x] 1.3 Create `src/components/notebooklm-config.ts` with `loadNotebookLMConfig()`
    - Read `NOTEBOOKLM_ENABLED`, `NOTEBOOKLM_CLI_PATH`, `NOTEBOOKLM_TIMEOUT_MS`, `NOTEBOOKLM_DEFAULT_NOTEBOOK`, `NOTEBOOKLM_QUERY_CACHE_TTL_MS` from environment
    - Apply defaults as specified in design (enabled=false, timeout=30000, cacheTtl=300000)
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 1.4 Write property test for configuration boolean parsing
    - **Property 2: Configuration Boolean Parsing**
    - **Validates: Requirements 2.1**

- [x] 2. Implement Notebook Registry
  - [x] 2.1 Create `src/components/notebook-registry.ts` with `NotebookRegistry` class
    - Implement `load()`, `save()`, `resolve()`, `register()`, `list()` methods
    - Auto-create `.agentbridge/notebooklm/` directory and empty registry on first use
    - Handle corrupted registry files gracefully (log warning, create fresh empty registry)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 10.5_

  - [ ]* 2.2 Write property test for registry register-then-resolve
    - **Property 4: Registry Register-Then-Resolve**
    - **Validates: Requirements 3.2, 3.3**

  - [ ]* 2.3 Write property test for registry JSON round-trip
    - **Property 5: Registry JSON Round-Trip**
    - **Validates: Requirements 3.5**

- [x] 3. Checkpoint — Types, config, and registry
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement NotebookLMClient
  - [x] 4.1 Create `src/components/notebooklm-client.ts` with `NotebookLMClient` class
    - Implement `initialize()` to validate CLI path exists
    - Implement `query()`, `listNotebooks()`, `createNotebook()`, `addSource()`, `listSources()`, `deleteSource()` methods
    - Use `child_process.execFile` with `AbortController` for timeout enforcement
    - Parse CLI JSON stdout into typed response objects
    - Wrap all public methods in try/catch, return structured error objects (never throw)
    - Log all CLI invocations at debug level, errors at error level, successful queries at info level
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 10.1, 10.6, 11.1, 11.2, 11.4_

  - [x] 4.2 Implement query cache in `NotebookLMClient`
    - In-memory `Map<string, { result: RAGResult; timestamp: number }>` cache
    - Case-insensitive, whitespace-normalized key matching
    - Max 100 entries with oldest-entry eviction
    - Configurable TTL from `NotebookLMConfig.queryCacheTtlMs`
    - Expose `getCacheStats()` for observability
    - Log cache hits/misses at debug level
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 11.3_

  - [x] 4.3 Implement disabled-state no-op behavior in `NotebookLMClient`
    - When `config.enabled` is false, all methods return immediately with empty/error results
    - No CLI subprocess invocations when disabled
    - _Requirements: 2.3_

  - [ ]* 4.4 Write property test for CLI output parsing round-trip
    - **Property 1: CLI Output Parsing Round-Trip**
    - **Validates: Requirements 1.9, 1.1**

  - [ ]* 4.5 Write property test for disabled state no-ops
    - **Property 3: Disabled State No-Ops**
    - **Validates: Requirements 2.3**

  - [ ]* 4.6 Write property test for cache idempotence within TTL
    - **Property 10: Cache Idempotence Within TTL**
    - **Validates: Requirements 6.2, 6.6**

  - [ ]* 4.7 Write property test for cache expiry after TTL
    - **Property 11: Cache Expiry After TTL**
    - **Validates: Requirements 6.3**

  - [ ]* 4.8 Write property test for cache key normalization
    - **Property 12: Cache Key Normalization**
    - **Validates: Requirements 6.4**

  - [ ]* 4.9 Write property test for cache max size invariant
    - **Property 13: Cache Max Size Invariant**
    - **Validates: Requirements 6.5**

  - [ ]* 4.10 Write property test for exception safety
    - **Property 15: Exception Safety**
    - **Validates: Requirements 10.6**

- [x] 5. Checkpoint — Core client with caching
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement agentbridge-kb CLI
  - [x] 6.1 Create `src/cli/agentbridge-kb.ts` with CLI entry point
    - Implement `parseArgs()` and `validateArgs()` following the `agentbridge-store.ts` pattern
    - Support subcommands: `query`, `notebooks list`, `notebooks create`, `sources list`, `sources add`, `sources remove`
    - Output JSON to stdout for all results (success and error)
    - Exit with code 0 even on errors (to avoid breaking agent tool invocation flow)
    - Validate all required parameters per subcommand, return descriptive errors for missing params
    - Wire subcommands to `NotebookLMClient` and `NotebookRegistry` methods
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 4.3, 4.4_

  - [x] 6.2 Add `agentbridge-kb` bin entry to `package.json`
    - Add `"agentbridge-kb": "dist/cli/agentbridge-kb.js"` to the `bin` field
    - _Requirements: 5.1_

  - [ ]* 6.3 Write property test for CLI argument parsing
    - **Property 6: CLI Argument Parsing**
    - **Validates: Requirements 4.3, 5.2**

  - [ ]* 6.4 Write property test for CLI subcommand routing
    - **Property 7: CLI Subcommand Routing**
    - **Validates: Requirements 5.1**

  - [ ]* 6.5 Write property test for CLI output always valid JSON
    - **Property 8: CLI Output Always Valid JSON**
    - **Validates: Requirements 5.3, 5.4**

  - [ ]* 6.6 Write property test for CLI validation errors for missing parameters
    - **Property 9: CLI Validation Errors for Missing Parameters**
    - **Validates: Requirements 5.5**

- [x] 7. Checkpoint — CLI complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Create Knowledge Base Skill
  - [x] 8.1 Create `skills/knowledge-base/SKILL.md`
    - Follow the YAML frontmatter + markdown format of `skills/memory-search/SKILL.md`
    - Include skill name, description, invocation instructions for `agentbridge-kb query`
    - Document parameters: `--query` (required), `--notebook` (optional), `--chat-id` (required)
    - Include "when to use" guidance: reference material, documentation lookups, research queries, questions local memory cannot answer
    - Include "when NOT to use" guidance: conversation context answers, personal memory recall, real-time info
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.7_

- [x] 9. Implement Telegram /kb commands
  - [x] 9.1 Add `/kb` command handler in `src/main.ts`
    - Handle subcommands: `list`, `create <name>`, `sources <notebook>`, `query <question>`
    - When `NOTEBOOKLM_ENABLED` is false, respond with "📚 Knowledge base is disabled." for all `/kb` commands
    - Return descriptive error messages on failure
    - Wire to `NotebookLMClient` and `NotebookRegistry` for actual operations
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 9.2 Extend `/memory` command to include Layer 6 status line
    - Show whether NotebookLM is enabled, number of registered notebooks, and cache size
    - _Requirements: 11.5_

  - [ ]* 9.3 Write property test for disabled KB Telegram response
    - **Property 14: Disabled KB Telegram Response**
    - **Validates: Requirements 9.5**

- [x] 10. Integration and wiring
  - [x] 10.1 Initialize `NotebookLMClient` in `src/main.ts` startup
    - Load config via `loadNotebookLMConfig()`
    - When enabled, initialize client and validate CLI path
    - When enabled but CLI path invalid, log warning and disable gracefully
    - When disabled, skip initialization entirely
    - _Requirements: 2.1, 2.2, 2.3, 2.8, 10.1, 10.3_

  - [x] 10.2 Wire `NotebookLMClient` and `NotebookRegistry` into Telegram command handlers and CLI
    - Pass initialized client/registry instances to `/kb` handler and `agentbridge-kb` CLI
    - Ensure graceful degradation: Layer 6 errors never disrupt Layers 1–5
    - _Requirements: 7.4, 10.1, 10.2, 10.4_

- [x] 11. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` with `vitest` (both already in devDependencies)
- All CLI invocations are mocked in tests — no real `notebooklm-cli` calls
- The design is intentionally decoupled: Layer 6 is entirely optional and all code paths are no-ops when disabled
