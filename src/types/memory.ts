/** A single conversation turn stored in a transcript and indexed for search. */
export type MessageRecord = {
  role: "user" | "assistant" | "compaction";
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  chatId: number;
  sessionId: string;
  /** Platform-specific message ID (e.g. Telegram message_id) for reaction tracking */
  platformMessageId?: number;
};

/** Hierarchical memory consolidation tier. Quarterly added for new 3-tier compaction; monthly/yearly kept for backward compat. */
export type MemoryTier = "daily" | "weekly" | "quarterly" | "monthly" | "yearly";


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
  type: "youtube" | "pdf" | "text" | "markdown" | "webpage";
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
  transcriptEntriesRemoved: number;
};

/** Result of intent detection on a user message. */
export type RecallAnalysis = {
  hasRecallIntent: boolean;
  temporalRange: { startTime: number; endTime: number } | null;
  strippedQuery: string;
  hasTopicKeywords: boolean;
};

/** Result from the recall fallback pipeline. */
export type PipelineResult = {
  results: SearchResult[];
  stage: "primary" | "context" | "relaxed" | "substring" | "vector" | "temporal" | "none";
  isFallback: boolean;
};

/** A structured memory extracted from conversation transcripts by the MemoryExtractor. */
export type ExtractedMemory = {
  id?: number;
  chat_id: number;
  content_original: string;
  content_en: string;
  memory_type: "fact" | "decision" | "preference" | "event";
  source_timestamp: number;
  preserve_original: boolean;
  preserved_keyword?: string;
  emotion_score: number;
  created_at: number;
};

/** Parameters for the agent-initiated memory search tool. */
export type MemorySearchParams = {
  keywords: string[];
  original_keyword?: string;
  time_range?: { start: number; end: number };
};

/** A single result from the memory search tool. */
export type MemorySearchResult = {
  content: string;
  content_original?: string;
  memory_type?: string;
  source_timestamp: number;
  tier: "extracted" | "daily" | "weekly" | "quarterly";
  score: number;
};

/** Heartbeat task definition. */
export type HeartbeatTask = {
  name: string;
  execute: () => Promise<void>;
};

/** Parameters for the agent-initiated instant memory store tool. */
export type InstantStoreParams = {
  chatId: number;
  contentEn: string;
  contentOriginal: string;
  memoryType: "fact" | "decision" | "preference" | "event";
  emotionScore: number;
  keyword?: string;
};

/** Result of an instant memory store operation. */
export type InstantStoreResult = {
  stored: boolean;
  memoriesCount: number;
  error?: string;
};

