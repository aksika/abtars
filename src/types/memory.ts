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
  };
};
