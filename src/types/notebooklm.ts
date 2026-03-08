/** Configuration for the NotebookLM Layer 6 integration. */
export type NotebookLMConfig = {
  enabled: boolean;
  cliPath: string;
  timeoutMs: number;
  defaultNotebook: string;
  queryCacheTtlMs: number;
};

/** A structured response from a NotebookLM RAG query. */
export type RAGResult = {
  answer: string;
  citations: RAGCitation[];
  confidence: "high" | "medium" | "low" | "none";
  notebookId: string;
  query: string;
};

/** A citation from a RAG query result. */
export type RAGCitation = {
  sourceId: string;
  sourceName: string;
  excerpt: string;
};

/** Descriptor for a source to upload to a notebook. */
export type SourceDescriptor = {
  type: "url" | "pdf" | "text" | "markdown";
  identifier: string;
};

/** Information about a source in a notebook. */
export type SourceInfo = {
  id: string;
  name: string;
  type: string;
  addedAt: number;
};

/** Information about a notebook. */
export type NotebookInfo = {
  id: string;
  name: string;
};

/** A single entry in the notebook registry. */
export type NotebookRegistryEntry = {
  name: string;
  notebookId: string;
  description: string;
  createdAt: number;
  sourceCount: number;
};

/** The full registry file structure. */
export type NotebookRegistryData = {
  version: 1;
  notebooks: NotebookRegistryEntry[];
};

/** Result of an agentbridge-kb query command (JSON output). */
export type KBQueryResult = {
  answer: string;
  citations: RAGCitation[];
  confidence: string;
  notebookName: string;
  cached: boolean;
};

/** Error result from agentbridge-kb (JSON output). */
export type KBErrorResult = {
  error: string;
};
