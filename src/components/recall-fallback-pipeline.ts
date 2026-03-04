import type { MemoryManager } from "./memory-manager.js";
import type { IntentDetector } from "./intent-detector.js";
import type { SearchResult, MessageRecord, SearchOptions, PipelineResult } from "../types/index.js";
import { logWarn, logDebug } from "./logger.js";

const TAG = "recall-fallback-pipeline";

/** Minimum time budget (ms) required to attempt the next stage. */
const MIN_STAGE_BUDGET_MS = 50;

/** Common English stop words filtered during keyword extraction. */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "while", "about", "up",
  "it", "its", "he", "she", "they", "them", "his", "her", "my", "your",
  "we", "you", "me", "him", "us", "i", "that", "this", "what", "which",
  "who", "whom", "these", "those",
]);

export type FallbackPipelineConfig = {
  enabled: boolean;
  timeoutMs: number;
  contextMessages: number;
  minTokenLength: number;
  vectorEnabled: boolean;
};

export class RecallFallbackPipeline {
  constructor(
    private readonly memoryManager: MemoryManager,
    private readonly intentDetector: IntentDetector,
    private readonly config: FallbackPipelineConfig,
  ) {}

  /**
   * Execute the recall pipeline for a user message.
   * Runs FTS stages in order, then merges substring search results to catch
   * compound words that FTS5 prefix matching misses. The merged results are
   * deduplicated and reranked. Respects the configured timeout budget.
   */
  async execute(
    userInput: string,
    chatId: number,
    workingMemory: MessageRecord[],
    limit?: number,
  ): Promise<PipelineResult> {
    const startTime = Date.now();
    const searchLimit = limit ?? 3;

    // Analyze intent and temporal references
    const analysis = this.intentDetector.analyze(userInput);

    // Build base search options — inject temporal range if present
    // Request more results than needed to account for filtered context echoes and self-references
    const baseOpts: SearchOptions = { chatId, limit: Math.max(searchLimit * 5, 20) };
    if (analysis.temporalRange) {
      baseOpts.startTime = analysis.temporalRange.startTime;
      baseOpts.endTime = analysis.temporalRange.endTime;
    }

    // When temporal range present but no topic keywords, search time range only
    const effectiveQuery = analysis.temporalRange && !analysis.hasTopicKeywords
      ? ""
      : userInput;
    const strippedOrOriginal = analysis.hasRecallIntent
      ? analysis.strippedQuery
      : effectiveQuery;

    // Disabled mode: single-shot Stage 1 only
    if (!this.config.enabled) {
      return this.runDisabledMode(effectiveQuery, baseOpts);
    }

    let ftsResults: SearchResult[] | null = null;
    let ftsStage: PipelineResult["stage"] = "none";

    // --- Stage 1: Primary FTS5 (skipped if recall intent detected) ---
    if (!analysis.hasRecallIntent) {
      if (this.hasBudget(startTime)) {
        const stage1 = await this.runStage("primary", effectiveQuery, baseOpts, userInput);
        if (stage1 && stage1.length > 0) {
          ftsResults = stage1;
          ftsStage = "primary";
        }
      }
    }

    // --- Stage 2: Context-Augmented FTS5 ---
    if (!ftsResults && this.hasBudget(startTime)) {
      const keywords = this.extractContextKeywords(workingMemory, this.config.contextMessages);
      const queryBase = analysis.hasRecallIntent ? strippedOrOriginal : effectiveQuery;
      const augmentedQuery = keywords.length > 0
        ? `${queryBase} ${keywords.join(" ")}`.trim()
        : queryBase;

      if (augmentedQuery.length > 0) {
        const stage2 = await this.runStage("context", augmentedQuery, baseOpts, userInput);
        if (stage2 && stage2.length > 0) {
          ftsResults = stage2;
          ftsStage = "context";
        }
      }
    }

    // --- Stage 3: Relaxed FTS5 ---
    if (!ftsResults && this.hasBudget(startTime)) {
      const keywords = this.extractContextKeywords(workingMemory, this.config.contextMessages);
      const queryBase = analysis.hasRecallIntent ? strippedOrOriginal : effectiveQuery;
      const augmentedQuery = keywords.length > 0
        ? `${queryBase} ${keywords.join(" ")}`.trim()
        : queryBase;
      const relaxedQuery = this.buildRelaxedQuery(
        augmentedQuery || userInput,
        this.config.minTokenLength,
      );
      if (relaxedQuery.length > 0) {
        const stage3 = await this.runStage("relaxed", relaxedQuery, baseOpts, userInput);
        if (stage3 && stage3.length > 0) {
          ftsResults = stage3;
          ftsStage = "relaxed";
        }
      }
    }

    // --- Stage 4: Substring LIKE search (always runs, merged with FTS results) ---
    // Catches compound words that FTS5 prefix matching misses (e.g. "jelszó" in "faszajelszót")
    if (this.hasBudget(startTime)) {
      const substringResults = this.runSubstringStage(userInput, baseOpts);
      if (substringResults && substringResults.length > 0) {
        if (ftsResults && ftsResults.length > 0) {
          // Merge: deduplicate by timestamp+content, keep higher score
          const merged = this.mergeResults(ftsResults, substringResults);
          logDebug(TAG, `Merged ${ftsResults.length} FTS + ${substringResults.length} substring → ${merged.length} results`);
          return { results: merged.slice(0, searchLimit), stage: ftsStage, isFallback: ftsStage !== "primary" };
        }
        logDebug(TAG, `Stage 4 (substring) returned ${substringResults.length} results`);
        return { results: substringResults.slice(0, searchLimit), stage: "substring", isFallback: true };
      }
    }

    // Return FTS results if we have them (even without substring supplement)
    if (ftsResults && ftsResults.length > 0) {
      logDebug(TAG, `Returning ${ftsResults.length} FTS results from stage ${ftsStage}`);
      return { results: ftsResults.slice(0, searchLimit), stage: ftsStage, isFallback: ftsStage !== "primary" };
    }

    // --- Stage 5: Vector search (if enabled) ---
    if (this.config.vectorEnabled) {
      if (!this.hasBudget(startTime)) {
        return this.emptyResult();
      }
      const stage5 = await this.runStage("vector", userInput, baseOpts, userInput);
      if (stage5 && stage5.length > 0) {
        logDebug(TAG, `Stage 5 (vector) returned ${stage5.length} results`);
        return { results: stage5.slice(0, searchLimit), stage: "vector", isFallback: true };
      }
    }

    logDebug(TAG, "All stages exhausted, returning empty result");
    return this.emptyResult();
  }

  /**
   * Extract keyword tokens from recent working memory messages
   * to augment the search query.
   */
  extractContextKeywords(workingMemory: MessageRecord[], maxMessages: number): string[] {
    const recent = workingMemory.slice(-maxMessages);
    const seen = new Set<string>();
    const keywords: string[] = [];

    for (const msg of recent) {
      const tokens = msg.content.split(/\s+/);
      for (const raw of tokens) {
        // Strip leading/trailing punctuation
        const token = raw.replace(/^[^\w]+|[^\w]+$/g, "").toLowerCase();
        if (token.length < 3) continue;
        if (STOP_WORDS.has(token)) continue;
        if (seen.has(token)) continue;
        seen.add(token);
        keywords.push(token);
      }
    }

    return keywords;
  }

  /**
   * Build a relaxed OR-style FTS5 query by dropping short tokens
   * and joining remaining tokens with OR.
   */
  buildRelaxedQuery(query: string, minTokenLength: number): string {
    const tokens = query.split(/\s+/).filter((t) => t.length >= minTokenLength);
    return tokens.join(" OR ");
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Merge and deduplicate results from FTS and substring stages.
   * When duplicates exist (same timestamp + role), keeps the higher score.
   * Re-applies answer-aware reranking on the merged set.
   */
  private mergeResults(primary: SearchResult[], secondary: SearchResult[]): SearchResult[] {
    const map = new Map<string, SearchResult>();
    for (const r of [...primary, ...secondary]) {
      const key = `${r.record.timestamp}:${r.record.role}`;
      const existing = map.get(key);
      if (!existing || r.score > existing.score) {
        map.set(key, r);
      }
    }
    const merged = [...map.values()];
    // Re-sort by score descending
    merged.sort((a, b) => b.score - a.score);
    return merged;
  }

  /** Check whether enough time budget remains for another stage. */
  private hasBudget(startTime: number): boolean {
    const elapsed = Date.now() - startTime;
    const remaining = this.config.timeoutMs - elapsed;
    if (remaining < MIN_STAGE_BUDGET_MS) {
      logDebug(TAG, `Budget exhausted (${elapsed}ms elapsed, ${remaining}ms remaining)`);
      return false;
    }
    return true;
  }

  /** Run a single search stage with error handling and answer-aware reranking. */
  private async runStage(
    stageName: string,
    query: string,
    opts: SearchOptions,
    originalUserInput?: string,
  ): Promise<SearchResult[] | null> {
    try {
      const results = await this.memoryManager.search(query, opts);
      if (!results) return null;

      const inputNorm = (originalUserInput ?? query).toLowerCase().replace(/[^\w\s]/g, "").trim();
      const queryIsQuestion = /\?/.test(originalUserInput ?? query);

      const filtered = results.filter((r) => {
        // 1. Filter context-echo assistant messages (contain assembled context markers)
        if (r.record.role === "assistant") {
          const c = r.record.content;
          if (c.includes("[INPUT]") || c.startsWith("- [user]") || c.startsWith("- [assistant]")) {
            return false;
          }
        }

        // 2. Filter exact self-echo: skip messages whose normalized content matches the query
        const contentNorm = r.record.content.toLowerCase().replace(/[^\w\s]/g, "").trim();
        if (contentNorm === inputNorm) return false;

        // 3. Filter high-similarity echoes: if >80% of query words appear and message is short
        if (inputNorm.length > 0) {
          const queryWords = inputNorm.split(/\s+/).filter((w) => w.length >= 3);
          if (queryWords.length > 0) {
            const matchCount = queryWords.filter((w) => contentNorm.includes(w)).length;
            const similarity = matchCount / queryWords.length;
            // If the message is mostly just the query repeated (short + high overlap), skip it
            if (similarity > 0.8 && contentNorm.length < inputNorm.length * 1.5) return false;
          }
        }

        return true;
      });

      // 4. Answer-aware reranking: when the user asks a question, deprioritize
      //    other question messages and boost declarative/answer messages
      if (queryIsQuestion && filtered.length > 1) {
        for (const r of filtered) {
          const content = r.record.content;
          const hasQuestion = /\?/.test(content);
          const isLong = content.length > 60;

          // Boost: declarative user messages (no question mark, longer = more info)
          if (r.record.role === "user" && !hasQuestion && isLong) {
            r.score *= 1.5;
          }
          // Boost: clean assistant answers (not context-echoes, already filtered above)
          if (r.record.role === "assistant" && !hasQuestion) {
            r.score *= 1.3;
          }
          // Penalize: user messages that are themselves questions about the same topic
          if (r.record.role === "user" && hasQuestion) {
            r.score *= 0.4;
          }
        }
        // Re-sort by adjusted score (descending)
        filtered.sort((a, b) => b.score - a.score);
      }

      return filtered;
    } catch (err) {
      logWarn(TAG, `Stage "${stageName}" failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Run substring LIKE search with the same filtering/reranking as runStage. */
  private runSubstringStage(
    query: string,
    opts: SearchOptions,
  ): SearchResult[] | null {
    try {
      const results = this.memoryManager.substringSearch(query, opts);
      if (!results || results.length === 0) return null;

      const inputNorm = query.toLowerCase().replace(/[^\w\s]/g, "").trim();
      const queryIsQuestion = /\?/.test(query);

      const filtered = results.filter((r) => {
        if (r.record.role === "assistant") {
          const c = r.record.content;
          if (c.includes("[INPUT]") || c.startsWith("- [user]") || c.startsWith("- [assistant]")) {
            return false;
          }
        }
        const contentNorm = r.record.content.toLowerCase().replace(/[^\w\s]/g, "").trim();
        if (contentNorm === inputNorm) return false;
        if (inputNorm.length > 0) {
          const queryWords = inputNorm.split(/\s+/).filter((w) => w.length >= 3);
          if (queryWords.length > 0) {
            const matchCount = queryWords.filter((w) => contentNorm.includes(w)).length;
            const similarity = matchCount / queryWords.length;
            if (similarity > 0.8 && contentNorm.length < inputNorm.length * 1.5) return false;
          }
        }
        return true;
      });

      if (queryIsQuestion && filtered.length > 1) {
        for (const r of filtered) {
          const content = r.record.content;
          const hasQuestion = /\?/.test(content);
          const isLong = content.length > 60;
          if (r.record.role === "user" && !hasQuestion && isLong) r.score *= 1.5;
          if (r.record.role === "assistant" && !hasQuestion) r.score *= 1.3;
          if (r.record.role === "user" && hasQuestion) r.score *= 0.4;
        }
        filtered.sort((a, b) => b.score - a.score);
      }

      return filtered;
    } catch (err) {
      logWarn(TAG, `Stage "substring" failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Disabled mode: single-shot Stage 1 and return. */
  private async runDisabledMode(
    query: string,
    opts: SearchOptions,
  ): Promise<PipelineResult> {
    const results = await this.runStage("primary", query, opts);
    if (results && results.length > 0) {
      const limit = opts.limit ? Math.ceil(opts.limit / 3) : 3;
      return { results: results.slice(0, limit), stage: "primary", isFallback: false };
    }
    return this.emptyResult();
  }

  /** Return an empty pipeline result. */
  private emptyResult(): PipelineResult {
    return { results: [], stage: "none", isFallback: false };
  }
}
