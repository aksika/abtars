import type { MemoryManager } from "./memory-manager.js";
import type { MemoryConfig } from "./memory-config.js";
import type { RecallFallbackPipeline } from "./recall-fallback-pipeline.js";
import type { ContextWindowMonitor } from "./context-window-monitor.js";
import type { AssembledContext, MessageRecord, SearchResult } from "../types/index.js";
import { logWarn } from "./logger.js";

/**
 * Builds the LLM context window from tiered memory sources with fixed token budgets.
 *
 * Assembly order (priority):
 * 1. Soul + User Core Facts (system prompt + user_core_facts.md)
 * 2. (removed)
 * 3. Recalled Memories (top-3 hybrid search results)
 * 4. Working Memory (last N raw messages)
 * 5. New Input (user's latest query)
 *
 * Token estimation uses `chars / 4` heuristic.
 */
export class ContextAssembler {
  private readonly memoryManager: MemoryManager;
  private readonly config: MemoryConfig;
  private llmCall: ((prompt: string, content: string) => Promise<string>) | null = null;
  private rollingSummaries: Map<string, string> = new Map();
  private pipeline: RecallFallbackPipeline | null = null;
  private sessionInjectionState: Map<string, boolean> = new Map();
  private contextWindowMonitor: ContextWindowMonitor | null = null;

  constructor(memoryManager: MemoryManager, config: MemoryConfig) {
    this.memoryManager = memoryManager;
    this.config = config;
  }

  /** Inject the recall fallback pipeline (only when recallFallback.enabled is true). */
  setPipeline(pipeline: RecallFallbackPipeline): void {
    this.pipeline = pipeline;
  }

  /** Register the LLM callback for rolling summary generation. */
  setLlmCall(llmCall: (prompt: string, content: string) => Promise<string>): void {
    this.llmCall = llmCall;
  }

  /** Mark a session as needing re-injection (called on staleness reset). */
  resetSessionInjection(channelKey: string): void {
    this.sessionInjectionState.delete(channelKey);
  }

  /** Inject the context window monitor for async compression scheduling. */
  setContextWindowMonitor(monitor: ContextWindowMonitor): void {
    this.contextWindowMonitor = monitor;
  }

  /**
   * Incrementally update the rolling summary when messages fall out of the buffer window.
   * Uses LlmCall to compress displaced messages into the existing summary.
   * Returns empty string if LlmCall is unavailable (fallback handled by caller).
   */
  async updateRollingSummary(params: {
    channelKey: string;
    displacedMessages: MessageRecord[];
    existingSummary: string;
  }): Promise<string> {
    const { channelKey, displacedMessages, existingSummary } = params;

    if (!this.llmCall) {
      return "";
    }

    if (displacedMessages.length === 0) {
      return existingSummary;
    }

    const formattedMessages = displacedMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const prompt =
      "You are a conversation summarizer. Incorporate the following new messages into the existing summary. " +
      "Produce a concise, updated summary IN ENGLISH that preserves all important information, regardless of the language used in the conversation. " +
      "If the existing summary is empty, create a new summary from the messages.";

    const content = existingSummary
      ? `Existing summary:\n${existingSummary}\n\nNew messages to incorporate:\n${formattedMessages}`
      : `Messages to summarize:\n${formattedMessages}`;

    try {
      const updatedSummary = await this.llmCall(prompt, content);
      this.rollingSummaries.set(channelKey, updatedSummary);
      return updatedSummary;
    } catch (err) {
      logWarn("ctx-assembler", `Rolling summary LLM call failed, retaining previous summary: ${err}`);
      return existingSummary || "";
    }
  }

  /** Estimate token count using chars / 4 heuristic. */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Truncate text to fit within a token budget. */
  private truncateToTokenBudget(text: string, budget: number): string {
    const maxChars = budget * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
  }

  /**
   * Assemble the full context for an LLM call.
   *
   * Each tier is capped at its configured token budget.
   * Empty sections are omitted from the output.
   */
  async assemble(params: {
    chatId: number;
    channelKey: string;
    userInput: string;
    systemPrompt: string;
    workingMemory: MessageRecord[];
    isSessionStart?: boolean;
  }): Promise<AssembledContext> {
    const { chatId, channelKey, userInput, systemPrompt, workingMemory, isSessionStart } = params;
    const budget = this.config.contextBudget;

    // Determine whether to inject CoreFacts + RollingSummary for this message.
    // Inject on first message of session (isSessionStart=true) or when state is unknown (fail-safe).
    const shouldInjectSessionContext =
      isSessionStart === true || !this.sessionInjectionState.has(channelKey);

    const sections: string[] = [];
    const usage = {
      soul: 0,
      recalled: 0,
      working: 0,
      input: 0,
      total: 0,
      rollingSummary: 0,
    };

    // 1. Soul + User Core Facts (CoreFacts omitted on subsequent messages in same session)
    const soulSection = this.buildSoulSection(chatId, systemPrompt, budget.soul, shouldInjectSessionContext);
    if (soulSection.text) {
      sections.push(soulSection.text);
      usage.soul = soulSection.tokens;
    }

    // 2. Last Session Summary (session-start only)
    if (shouldInjectSessionContext) {
      const summarySection = this.buildLastSessionSummary(chatId, budget.recalled);
      if (summarySection.text) {
        sections.push(summarySection.text);
        usage.recalled = summarySection.tokens;
      }
    }

    // 3b. Recalled Memories (active recall based on user input)
    if (!shouldInjectSessionContext || usage.recalled === 0) {
      const recalledSection = await this.buildRecalledSection(chatId, userInput, budget.recalled - usage.recalled, workingMemory);
      if (recalledSection.text) {
        sections.push(recalledSection.text);
        usage.recalled += recalledSection.tokens;
      }
    }

    // 4. Working Memory — with rolling summary for long conversations
    let rollingSummaryText = "";
    let recentMessages = workingMemory;

    if (workingMemory.length > this.config.rollingBufferSize) {
      const bufferSize = this.config.rollingBufferSize;
      recentMessages = workingMemory.slice(-bufferSize);
      const displacedMessages = workingMemory.slice(0, -bufferSize);
      const summaryChannelKey = String(chatId);

      // Try to generate/update rolling summary via LLM
      const existingSummary = this.rollingSummaries.get(summaryChannelKey) ?? "";
      rollingSummaryText = await this.updateRollingSummary({
        channelKey: summaryChannelKey,
        displacedMessages,
        existingSummary,
      });

      // If updateRollingSummary returned empty (LlmCall unavailable), fall back to
      // simple truncation — just use the recent messages that fit the budget
      if (!rollingSummaryText) {
        rollingSummaryText = "";
      }
    } else {
      // Conversation fits within buffer — use cached summary if available
      const summaryChannelKey = String(chatId);
      rollingSummaryText = this.rollingSummaries.get(summaryChannelKey) ?? "";
    }

    // Omit rolling summary on subsequent messages in the same session
    if (!shouldInjectSessionContext) {
      rollingSummaryText = "";
    }

    const workingSection = this.buildWorkingMemorySection(
      recentMessages,
      budget.working,
      rollingSummaryText,
    );
    if (workingSection.text) {
      // Prepend session-start timestamp to give the LLM a temporal anchor
      const sessionMarker = `[SESSION START — ${new Date().toISOString()}]`;
      sections.push(`${sessionMarker}\n${workingSection.text}`);
      usage.working = workingSection.tokens;
      usage.rollingSummary = workingSection.rollingSummaryTokens;
    }

    // 5. New Input
    const inputSection = `[INPUT]\n${userInput}`;
    usage.input = this.estimateTokens(inputSection);
    sections.push(inputSection);

    usage.total = usage.soul + usage.recalled + usage.working + usage.input;

    // Check context window usage and schedule async compression if needed
    if (this.contextWindowMonitor) {
      try {
        const maxTokens = budget.soul + budget.recalled + budget.working;
        if (this.contextWindowMonitor.shouldCompress(usage.total, maxTokens)) {
          this.contextWindowMonitor.scheduleCompression(channelKey);
        }
      } catch (err) {
        logWarn("ctx-assembler", `Context window monitor failed, proceeding without compression: ${err}`);
      }
    }

    // Mark this channel as having received session context injection
    this.sessionInjectionState.set(channelKey, true);

    return { text: sections.join("\n\n"), usage };
  }

  private buildSoulSection(
    _chatId: number,
    systemPrompt: string,
    budget: number,
    includeCoreFacts: boolean = true,
  ): { text: string; tokens: number } {
    const parts: string[] = [];

    if (systemPrompt) parts.push(`[SYSTEM]\n${systemPrompt}`);
    if (includeCoreFacts) {
      const knowledge = this.memoryManager.readCoreKnowledge();
      if (knowledge) parts.push(`[CORE KNOWLEDGE]\n${knowledge}`);
    }

    if (parts.length === 0) return { text: "", tokens: 0 };

    const raw = parts.join("\n\n");
    const truncated = this.truncateToTokenBudget(raw, budget);
    return { text: truncated, tokens: this.estimateTokens(truncated) };
  }

  /**
   * Build a timestamped last-session summary for session-start injection.
   * Fetches the latest daily compaction and formats it with an "ended at" timestamp.
   */
  private buildLastSessionSummary(
    chatId: number,
    budget: number,
  ): { text: string; tokens: number } {
    try {
      const compaction = this.memoryManager.getLatestCompaction(chatId);
      if (!compaction) return { text: "", tokens: 0 };

      const endedAt = new Date(compaction.timestamp).toISOString();
      const raw = `[LAST SESSION SUMMARY — ended ${endedAt}]
${compaction.summary}`;
      const truncated = this.truncateToTokenBudget(raw, budget);
      return { text: truncated, tokens: this.estimateTokens(truncated) };
    } catch {
      return { text: "", tokens: 0 };
    }
  }

  private async buildRecalledSection(
    chatId: number,
    userInput: string,
    budget: number,
    workingMemory: MessageRecord[],
  ): Promise<{ text: string; tokens: number }> {
    try {
      let results: SearchResult[];
      let isFallback = false;

      if (this.pipeline) {
        // Delegate to the recall fallback pipeline
        const pipelineResult = await this.pipeline.execute(userInput, chatId, workingMemory, 10);
        results = pipelineResult.results;
        isFallback = pipelineResult.isFallback;
      } else {
        // Fallback disabled or pipeline not injected — single-shot search
        results = (await this.memoryManager.search(userInput, { chatId, limit: 3 })) ?? [];
      }

      if (results.length === 0) return { text: "", tokens: 0 };

      const snippets: string[] = [];
      let totalChars = "[RECALLED MEMORIES]\n".length;
      const maxChars = budget * 4;

      for (const result of results) {
        const label = isFallback ? `[FALLBACK] [${result.record.role}]` : `[${result.record.role}]`;
        const snippet = `- ${label} ${result.record.content}`;
        if (totalChars + snippet.length + 1 > maxChars) break;
        snippets.push(snippet);
        totalChars += snippet.length + 1; // +1 for newline
      }

      if (snippets.length === 0) return { text: "", tokens: 0 };

      const raw = `[RECALLED MEMORIES]\n${snippets.join("\n")}`;
      return { text: raw, tokens: this.estimateTokens(raw) };
    } catch {
      return { text: "", tokens: 0 };
    }
  }

  /**
   * Merge and deduplicate search results from primary and fallback sources.
   * Prefers higher scores when duplicates (same timestamp + content) exist.
   */
  // @ts-expect-error reserved for future use when both primary and fallback results need merging
  private mergeAndDedup(primary: SearchResult[], fallback: SearchResult[]): SearchResult[] {
    const map = new Map<string, SearchResult>();
    for (const r of [...primary, ...fallback]) {
      const key = `${r.record.timestamp}:${r.record.content}`;
      const existing = map.get(key);
      if (!existing || r.score > existing.score) {
        map.set(key, r);
      }
    }
    return [...map.values()].sort((a, b) => b.score - a.score);
  }

  private buildWorkingMemorySection(
    workingMemory: MessageRecord[],
    budget: number,
    rollingSummary?: string,
  ): { text: string; tokens: number; rollingSummaryTokens: number } {
    if (!workingMemory || workingMemory.length === 0) {
      return { text: "", tokens: 0, rollingSummaryTokens: 0 };
    }

    const header = "[CONVERSATION]\n";
    const maxChars = budget * 4;
    let rollingSummaryTokens = 0;
    let summaryBlock = "";

    // If rolling summary exists, prepend it and count against the working memory budget
    if (rollingSummary) {
      summaryBlock = `[ROLLING SUMMARY (English)]\n${rollingSummary}\n\n`;
      const summaryChars = summaryBlock.length;

      if (summaryChars >= maxChars) {
        // Summary alone exceeds budget — truncate it and return with no messages
        const truncated = this.truncateToTokenBudget(summaryBlock, budget);
        rollingSummaryTokens = this.estimateTokens(truncated);
        return { text: truncated, tokens: rollingSummaryTokens, rollingSummaryTokens };
      }

      rollingSummaryTokens = this.estimateTokens(summaryBlock);
    }

    // Remaining budget after rolling summary
    const remainingChars = maxChars - summaryBlock.length;

    // Format all messages
    const formatted = workingMemory.map(
      (m) => `${m.role}: ${m.content}`,
    );

    // Calculate total size for messages + header
    const fullSize = formatted.reduce((sum, line) => sum + line.length + 1, 0) + header.length;

    if (fullSize <= remainingChars) {
      // Everything fits
      const raw = summaryBlock + header + formatted.join("\n");
      return { text: raw, tokens: this.estimateTokens(raw), rollingSummaryTokens };
    }

    // Truncate oldest messages first — keep most recent
    const kept: string[] = [];
    let totalChars = header.length;

    for (let i = formatted.length - 1; i >= 0; i--) {
      const line = formatted[i]!;
      if (totalChars + line.length + 1 > remainingChars) break;
      kept.unshift(line);
      totalChars += line.length + 1;
    }

    if (kept.length === 0 && !summaryBlock) {
      return { text: "", tokens: 0, rollingSummaryTokens: 0 };
    }

    const messagePart = kept.length > 0 ? header + kept.join("\n") : "";
    const raw = summaryBlock ? summaryBlock + messagePart : messagePart;
    return { text: raw, tokens: this.estimateTokens(raw), rollingSummaryTokens };
  }
}
