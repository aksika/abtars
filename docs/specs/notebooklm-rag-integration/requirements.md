# Requirements Document

## Introduction

NotebookLM RAG Integration adds a persistent, external knowledge base layer (Layer 6) to the agent's memory architecture. The existing memory system (Layers 1–5) handles conversation history, extracted memories, compacted summaries, and topic files — all stored locally in SQLite and markdown. Layer 6 extends this with a cloud-backed Retrieval-Augmented Generation (RAG) tier powered by Google NotebookLM, accessed via the `notebooklm-cli` command-line tool (cloned at `/mnt/c/Users/qakosal/workspace/openclaw/notebooklm-mcp-cli`).

This layer serves as a long-term knowledge base for curated reference material — documents, guides, research, and structured knowledge that the agent should be able to query on demand. Unlike the local memory tiers which capture conversation-derived knowledge, Layer 6 holds externally sourced, user-curated documents that persist across sessions and are too large or too numerous for local context windows.

The integration uses the CLI directly (no MCP server) — the agent invokes `notebooklm-cli` shell commands to create notebooks, upload sources, and query the knowledge base.

## Glossary

- **NotebookLM_Client**: A new component (`src/components/notebooklm-client.ts`) that wraps the `notebooklm-cli` binary, providing typed methods for notebook management, source upload, and RAG queries.
- **NotebookLM_CLI**: The command-line tool at the configured path (default: `/mnt/c/Users/qakosal/workspace/openclaw/notebooklm-mcp-cli`) that communicates with the Google NotebookLM API. Invoked via `npx ts-node src/cli.ts` or the built binary.
- **Knowledge_Base_Skill**: A new agent skill (`skills/knowledge-base/SKILL.md`) that instructs the agent when and how to query Layer 6 for external knowledge.
- **Notebook**: A NotebookLM project container that holds sources (documents) and supports natural-language queries against those sources.
- **Source**: A document uploaded to a Notebook — can be a URL, PDF, plain text, or markdown file. NotebookLM indexes the source for RAG retrieval.
- **RAG_Query**: A natural-language question sent to a Notebook. NotebookLM returns an answer synthesized from the indexed sources, with citations.
- **RAG_Result**: The structured response from a NotebookLM query, containing the answer text, source citations, and metadata.
- **Memory_Manager**: The existing top-level coordinator for the local memory layer, which will be extended to optionally integrate Layer 6 queries.
- **Context_Assembler**: The existing component that builds the LLM context window from tiered memory sources. Will be extended to include Layer 6 results when available.
- **Agent**: The LLM (e.g., Claude) running inside Kiro that processes user messages, generates responses, and can invoke tools.
- **Agent_Transport**: The transport layer that sends prompts to the AI agent and receives responses.
- **Notebook_Registry**: A local JSON file (`.agentbridge/notebooklm/registry.json`) that maps human-readable notebook names to NotebookLM notebook IDs, tracking which notebooks are available for queries.

## Requirements

### Requirement 1: NotebookLM CLI Client Wrapper

**User Story:** As a developer, I want a typed TypeScript wrapper around the notebooklm-cli binary, so that other components can interact with NotebookLM without dealing with raw shell commands and output parsing.

#### Acceptance Criteria

1. THE NotebookLM_Client SHALL provide a `query(notebookId: string, question: string)` method that invokes the CLI and returns a structured RAG_Result.
2. THE NotebookLM_Client SHALL provide a `listNotebooks()` method that returns an array of available notebooks with their IDs and names.
3. THE NotebookLM_Client SHALL provide a `createNotebook(name: string)` method that creates a new notebook and returns its ID.
4. THE NotebookLM_Client SHALL provide an `addSource(notebookId: string, source: SourceDescriptor)` method that uploads a document to a notebook, where SourceDescriptor specifies the source type (url, pdf, text, markdown) and identifier (URL or file path).
5. THE NotebookLM_Client SHALL provide a `listSources(notebookId: string)` method that returns the sources currently indexed in a notebook.
6. THE NotebookLM_Client SHALL provide a `deleteSource(notebookId: string, sourceId: string)` method that removes a source from a notebook.
7. THE NotebookLM_Client SHALL accept a `cliPath` configuration option specifying the path to the notebooklm-cli project directory, defaulting to the value of the `NOTEBOOKLM_CLI_PATH` environment variable.
8. THE NotebookLM_Client SHALL execute CLI commands using `child_process.execFile` with a configurable timeout (default: 30 seconds) to prevent hanging processes.
9. THE NotebookLM_Client SHALL parse CLI JSON output into typed response objects and return descriptive errors when parsing fails.
10. IF the CLI binary is not found at the configured path, THEN THE NotebookLM_Client SHALL throw a descriptive error during initialization.
11. IF a CLI command times out, THEN THE NotebookLM_Client SHALL kill the child process and return a timeout error.
12. IF a CLI command returns a non-zero exit code, THEN THE NotebookLM_Client SHALL return an error containing the stderr output.

### Requirement 2: NotebookLM Configuration

**User Story:** As a developer, I want NotebookLM integration to be configurable via environment variables, so that it can be enabled/disabled and tuned without code changes.

#### Acceptance Criteria

1. THE system SHALL read the `NOTEBOOKLM_ENABLED` environment variable to determine whether Layer 6 is active, defaulting to `false`.
2. WHEN `NOTEBOOKLM_ENABLED` is set to `true`, THE system SHALL initialize the NotebookLM_Client during startup.
3. WHEN `NOTEBOOKLM_ENABLED` is not set or set to `false`, THE system SHALL skip NotebookLM initialization and all Layer 6 operations SHALL be no-ops.
4. THE system SHALL read the `NOTEBOOKLM_CLI_PATH` environment variable for the path to the notebooklm-cli project directory, defaulting to `/mnt/c/Users/qakosal/workspace/openclaw/notebooklm-mcp-cli`.
5. THE system SHALL read the `NOTEBOOKLM_TIMEOUT_MS` environment variable for the CLI command timeout in milliseconds, defaulting to `30000`.
6. THE system SHALL read the `NOTEBOOKLM_DEFAULT_NOTEBOOK` environment variable for the default notebook ID to query when no specific notebook is specified.
7. THE system SHALL read the `NOTEBOOKLM_QUERY_CACHE_TTL_MS` environment variable for the query result cache time-to-live in milliseconds, defaulting to `300000` (5 minutes).
8. WHEN `NOTEBOOKLM_ENABLED` is `true` and the CLI path is invalid, THE system SHALL log a warning and disable Layer 6 gracefully rather than crashing.

### Requirement 3: Notebook Registry

**User Story:** As a user, I want to manage multiple NotebookLM notebooks with human-readable names, so that I can organize my knowledge base by topic and query specific notebooks.

#### Acceptance Criteria

1. THE system SHALL maintain a Notebook_Registry at `.agentbridge/notebooklm/registry.json` that maps notebook names to NotebookLM notebook IDs.
2. WHEN a new notebook is created via the agent or CLI commands, THE system SHALL add an entry to the Notebook_Registry with the notebook name, ID, creation timestamp, and description.
3. WHEN the agent queries a notebook by name, THE system SHALL resolve the name to a notebook ID using the Notebook_Registry.
4. IF a notebook name is not found in the Notebook_Registry, THEN THE system SHALL return an error listing available notebook names.
5. THE Notebook_Registry SHALL be a valid JSON file. FOR ALL valid registry states, writing then reading the registry SHALL produce an equivalent object (round-trip property).
6. THE system SHALL create the `.agentbridge/notebooklm/` directory and an empty registry file on first use if they do not exist.

### Requirement 4: Agent Knowledge Base Query Skill

**User Story:** As a user, I want the agent to be able to search my NotebookLM knowledge base when I ask questions about topics covered by my uploaded documents, so that the agent can provide answers grounded in my curated reference material.

#### Acceptance Criteria

1. THE system SHALL provide a `SKILL.md` file at `skills/knowledge-base/SKILL.md` that describes the knowledge base query skill's purpose, parameters, and usage guidelines.
2. THE Knowledge_Base_Skill SHALL instruct the Agent to invoke the `agentbridge-kb` CLI command to query the knowledge base.
3. THE `agentbridge-kb` CLI command SHALL accept the following parameters:
   - `--query` (required): The natural-language question to ask
   - `--notebook` (optional): The notebook name to query (defaults to the configured default notebook)
   - `--chat-id` (required): The chat ID for logging and context
4. THE `agentbridge-kb` command SHALL return a JSON result containing the answer text, source citations, and a confidence indicator.
5. THE SKILL.md SHALL include clear "when to use" guidance covering: questions about reference material, technical documentation lookups, research queries, and questions the local memory cannot answer.
6. THE SKILL.md SHALL include clear "when NOT to use" guidance covering: questions answerable from conversation context, personal memory recall (use memory-search instead), and real-time information needs.
7. THE SKILL.md SHALL follow the same format as the existing `skills/memory-search/SKILL.md` including the YAML frontmatter.

### Requirement 5: Knowledge Base CLI Command

**User Story:** As a developer, I want a CLI entry point for knowledge base operations, so that the agent can invoke queries and management commands via shell tools.

#### Acceptance Criteria

1. THE system SHALL provide an `agentbridge-kb` CLI command that supports the following subcommands:
   - `query` — query a notebook with a natural-language question
   - `notebooks list` — list all registered notebooks
   - `notebooks create --name <name> --description <desc>` — create a new notebook
   - `sources list --notebook <name>` — list sources in a notebook
   - `sources add --notebook <name> --type <type> --identifier <path_or_url>` — add a source to a notebook
   - `sources remove --notebook <name> --source-id <id>` — remove a source from a notebook
2. THE `agentbridge-kb query` subcommand SHALL accept `--query`, `--notebook` (optional), and `--chat-id` parameters.
3. THE `agentbridge-kb` command SHALL output JSON results to stdout for all subcommands.
4. IF a subcommand fails, THEN THE `agentbridge-kb` command SHALL output a JSON error object to stdout with a descriptive `error` field and exit with code 0 (to avoid breaking the agent's tool invocation flow).
5. THE `agentbridge-kb` command SHALL validate all required parameters and return a descriptive error when parameters are missing.

### Requirement 6: Query Result Caching

**User Story:** As a user, I want repeated queries to the knowledge base to be fast, so that the agent does not make redundant API calls for the same question within a short time window.

#### Acceptance Criteria

1. THE NotebookLM_Client SHALL maintain an in-memory cache of query results keyed by `(notebookId, query)` pairs.
2. WHEN a query matches a cached entry whose age is less than the configured TTL, THE NotebookLM_Client SHALL return the cached result without invoking the CLI.
3. WHEN a query matches a cached entry whose age exceeds the configured TTL, THE NotebookLM_Client SHALL evict the entry and invoke the CLI for a fresh result.
4. THE cache SHALL use case-insensitive, whitespace-normalized query matching to improve hit rates.
5. THE cache SHALL have a maximum size of 100 entries. WHEN the cache is full, THE NotebookLM_Client SHALL evict the oldest entry before inserting a new one.
6. FOR ALL queries, querying then querying again with the same input within the TTL SHALL produce the same result (idempotence within TTL window).

### Requirement 7: Context Assembler Integration

**User Story:** As a user, I want knowledge base results to be included in the agent's context when relevant, so that the agent can reference my curated documents in its responses.

#### Acceptance Criteria

1. WHEN the Agent invokes the Knowledge_Base_Skill and receives a RAG_Result, THE Agent SHALL incorporate the answer and citations into its response to the user.
2. THE Agent SHALL clearly attribute information from the knowledge base, distinguishing it from local memory recall and conversation context.
3. THE Agent SHALL NOT automatically query the knowledge base on every message. Queries SHALL only occur when the Agent determines the knowledge base is likely to have relevant information (skill-driven, not automatic).
4. WHEN the knowledge base returns no results or an error, THE Agent SHALL fall back to its existing memory tiers and inform the user that the knowledge base did not have relevant information.

### Requirement 8: Source Ingestion via Agent

**User Story:** As a user, I want to tell the agent to add documents to my knowledge base, so that I can grow my reference material through natural conversation.

#### Acceptance Criteria

1. WHEN the user requests adding a source to the knowledge base (e.g., "add this URL to my knowledge base", "upload this document to notebook X"), THE Agent SHALL invoke the `agentbridge-kb sources add` command with the appropriate parameters.
2. THE Agent SHALL confirm successful source addition to the user, including the notebook name and source identifier.
3. THE Agent SHALL support adding sources of type: `url`, `pdf`, `text`, and `markdown`.
4. IF the source addition fails, THEN THE Agent SHALL inform the user of the failure reason.
5. WHEN adding a source, THE Agent SHALL default to the configured default notebook if the user does not specify a notebook name.

### Requirement 9: Notebook Management via Telegram Commands

**User Story:** As a user, I want Telegram commands to manage my knowledge base notebooks, so that I can create notebooks and list their contents without leaving the chat.

#### Acceptance Criteria

1. WHEN the user sends `/kb list`, THE system SHALL list all registered notebooks with their names, source counts, and creation dates.
2. WHEN the user sends `/kb create <name>`, THE system SHALL create a new notebook with the given name and confirm creation.
3. WHEN the user sends `/kb sources <notebook-name>`, THE system SHALL list all sources in the specified notebook.
4. WHEN the user sends `/kb query <question>`, THE system SHALL query the default notebook and return the answer with citations.
5. IF the NotebookLM integration is disabled, THEN THE system SHALL respond with "📚 Knowledge base is disabled." for all `/kb` commands.
6. IF a `/kb` command fails, THEN THE system SHALL respond with a descriptive error message.

### Requirement 10: Error Handling and Graceful Degradation

**User Story:** As a user, I want the knowledge base integration to fail gracefully, so that errors in Layer 6 never disrupt the agent's core functionality.

#### Acceptance Criteria

1. IF the NotebookLM_CLI is unreachable or returns an error, THEN THE system SHALL log the error and continue operating with Layers 1–5 only.
2. IF a knowledge base query times out, THEN THE system SHALL return a timeout error to the agent and the agent SHALL inform the user that the knowledge base is temporarily unavailable.
3. IF the Google NotebookLM API returns an authentication error, THEN THE system SHALL log the error, disable Layer 6 for the current session, and inform the user.
4. THE system SHALL NOT retry failed knowledge base queries automatically. The agent or user SHALL decide whether to retry.
5. IF the Notebook_Registry file is corrupted or unreadable, THEN THE system SHALL log a warning, create a fresh empty registry, and continue operation.
6. THE NotebookLM_Client SHALL catch all exceptions from CLI invocations and return structured error objects rather than throwing unhandled exceptions.

### Requirement 11: Logging and Observability

**User Story:** As a developer, I want knowledge base operations to be logged, so that I can debug issues and monitor usage.

#### Acceptance Criteria

1. THE NotebookLM_Client SHALL log all CLI invocations at `debug` level, including the command, notebook ID, and execution time.
2. THE NotebookLM_Client SHALL log all errors at `error` level, including the command that failed and the error details.
3. THE NotebookLM_Client SHALL log cache hits and misses at `debug` level.
4. WHEN a knowledge base query succeeds, THE NotebookLM_Client SHALL log the query, notebook name, answer length, and citation count at `info` level.
5. THE `/memory` Telegram command SHALL include a Layer 6 status line showing whether NotebookLM is enabled, the number of registered notebooks, and the cache size.
