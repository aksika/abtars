/** A single conversation turn stored in a transcript and indexed for search. */
export type MessageRecord = {
  role: "user" | "assistant" | "compaction";
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  chatId: number;
  sessionId: string;
};

/** Hierarchical memory consolidation tier. */
export type MemoryTier = "daily" | "weekly" | "monthly" | "yearly";

/** A compacted summary produced by the LLM at any tier. */
export type CompactedMemory = {
  id: number;
  chatId: number;
  sourceSessionId: string;
  tier: MemoryTier;
  /** Unix timestamp in milliseconds when compaction was created */
  timestamp: number;
  /** LLM-generated summary text */
  summary: string;
  /** Path to the .md file on disk */
  filePath: string;
};

/** A persisted session row restored from SQLite. */
export type StoredSession = {
  channelKey: string;
  acpSessionId: string;
  /** Unix timestamp in milliseconds */
  createdAt: number;
  /** Unix timestamp in milliseconds */
  lastActivityAt: number;
};

/** A search result from the FTS5 index. */
export type SearchResult = {
  record: MessageRecord;
  /** BM25 relevance score */
  score: number;
};

/** A search result from the vector index. */
export type VectorSearchResult = {
  messageId: number;
  /** Cosine similarity score */
  score: number;
};

/** Options for filtering search results. */
export type SearchOptions = {
  chatId?: number;
  startTime?: number;
  endTime?: number;
  limit?: number;
};

/** Assembled LLM context with per-tier token usage breakdown. */
export type AssembledContext = {
  /** The full assembled context string, ready for the LLM. */
  text: string;
  /** Token usage breakdown per tier. */
  usage: {
    soul: number;
    scratchpad: number;
    recalled: number;
    working: number;
    input: number;
    total: number;
    /** Tokens used by the rolling summary within the working memory tier. */
    rollingSummary: number;
  };
};

/** Source descriptor for the ingestion pipeline (Phase 2). */
export type IngestionSource = {
  type: "youtube" | "pdf" | "text" | "markdown";
  /** URL or file path identifying the source. */
  identifier: string;
};

/** Result of an ingestion operation (Phase 2). */
export type IngestionResult = {
  sourceType: string;
  identifier: string;
  chunkCount: number;
  timestamp: number;
};

/** A previously ingested document record (Phase 2). */
export type IngestedDocument = {
  id: number;
  sourceType: string;
  identifier: string;
  chunkCount: number;
  ingestedAt: number;
  chatId: number;
};

/** A reflection meta-summary (Phase 2). */
export type Reflection = {
  channelKey: string;
  /** Date string in YYYY-MM-DD format. */
  date: string;
  /** Markdown prose content of the reflection. */
  content: string;
  /** One-line summary preview. */
  preview: string;
  /** Path to the stored markdown file. */
  filePath: string;
};

/** Result of a forget/cascade-delete operation (Phase 2). */
export type ForgetResult = {
  messagesRemoved: number;
  embeddingsRemoved: number;
  compactionsRemoved: number;
  transcriptEntriesRemoved: number;
};
