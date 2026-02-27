import type { MemoryManager } from "./memory-manager.js";
import type { MemoryConfig } from "./memory-config.js";
import type { AssembledContext, MessageRecord } from "../types/index.js";

/**
 * Builds the LLM context window from tiered memory sources with fixed token budgets.
 *
 * Assembly order (priority):
 * 1. Soul + User Core Facts (system prompt + user_core_facts.md)
 * 2. Scratchpad
 * 3. Recalled Memories (top-3 hybrid search results)
 * 4. Working Memory (last N raw messages)
 * 5. New Input (user's latest query)
 *
 * Token estimation uses `chars / 4` heuristic.
 */
export class ContextAssembler {
  private readonly memoryManager: MemoryManager;
  private readonly config: MemoryConfig;

  constructor(memoryManager: MemoryManager, config: MemoryConfig) {
    this.memoryManager = memoryManager;
    this.config = config;
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
    userInput: string;
    systemPrompt: string;
    workingMemory: MessageRecord[];
  }): Promise<AssembledContext> {
    const { chatId, userInput, systemPrompt, workingMemory } = params;
    const budget = this.config.contextBudget;

    const sections: string[] = [];
    const usage = { soul: 0, scratchpad: 0, recalled: 0, working: 0, input: 0, total: 0 };

    // 1. Soul + User Core Facts
    const soulSection = this.buildSoulSection(chatId, systemPrompt, budget.soul);
    if (soulSection.text) {
      sections.push(soulSection.text);
      usage.soul = soulSection.tokens;
    }

    // 2. Scratchpad
    const scratchpadSection = this.buildScratchpadSection(chatId, budget.scratchpad);
    if (scratchpadSection.text) {
      sections.push(scratchpadSection.text);
      usage.scratchpad = scratchpadSection.tokens;
    }

    // 3. Recalled Memories (async — hybrid search)
    const recalledSection = await this.buildRecalledSection(chatId, userInput, budget.recalled);
    if (recalledSection.text) {
      sections.push(recalledSection.text);
      usage.recalled = recalledSection.tokens;
    }

    // 4. Working Memory
    const workingSection = this.buildWorkingMemorySection(workingMemory, budget.working);
    if (workingSection.text) {
      sections.push(workingSection.text);
      usage.working = workingSection.tokens;
    }

    // 5. New Input
    const inputSection = `[INPUT]\n${userInput}`;
    usage.input = this.estimateTokens(inputSection);
    sections.push(inputSection);

    usage.total = usage.soul + usage.scratchpad + usage.recalled + usage.working + usage.input;

    return { text: sections.join("\n\n"), usage };
  }

  private buildSoulSection(
    chatId: number,
    systemPrompt: string,
    budget: number,
  ): { text: string; tokens: number } {
    const userFacts = this.memoryManager.readUserCoreFacts(chatId);
    const parts: string[] = [];

    if (systemPrompt) parts.push(`[SYSTEM]\n${systemPrompt}`);
    if (userFacts) parts.push(`[USER FACTS]\n${userFacts}`);

    if (parts.length === 0) return { text: "", tokens: 0 };

    const raw = parts.join("\n\n");
    const truncated = this.truncateToTokenBudget(raw, budget);
    return { text: truncated, tokens: this.estimateTokens(truncated) };
  }

  private buildScratchpadSection(
    chatId: number,
    budget: number,
  ): { text: string; tokens: number } {
    const scratchpad = this.memoryManager.readScratchpad(chatId);
    if (!scratchpad) return { text: "", tokens: 0 };

    const raw = `[SCRATCHPAD]\n${scratchpad}`;
    const truncated = this.truncateToTokenBudget(raw, budget);
    return { text: truncated, tokens: this.estimateTokens(truncated) };
  }

  private async buildRecalledSection(
    chatId: number,
    userInput: string,
    budget: number,
  ): Promise<{ text: string; tokens: number }> {
    try {
      const results = await this.memoryManager.search(userInput, { chatId, limit: 3 });
      if (!results || results.length === 0) return { text: "", tokens: 0 };

      const snippets: string[] = [];
      let totalChars = "[RECALLED MEMORIES]\n".length;
      const maxChars = budget * 4;

      for (const result of results) {
        const snippet = `- [${result.record.role}] ${result.record.content}`;
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

  private buildWorkingMemorySection(
    workingMemory: MessageRecord[],
    budget: number,
  ): { text: string; tokens: number } {
    if (!workingMemory || workingMemory.length === 0) return { text: "", tokens: 0 };

    const header = "[CONVERSATION]\n";
    const maxChars = budget * 4;
    let totalChars = header.length;

    // Format all messages
    const formatted = workingMemory.map(
      (m) => `${m.role}: ${m.content}`,
    );

    // Calculate total size
    const fullSize = formatted.reduce((sum, line) => sum + line.length + 1, 0) + header.length;

    if (fullSize <= maxChars) {
      // Everything fits
      const raw = header + formatted.join("\n");
      return { text: raw, tokens: this.estimateTokens(raw) };
    }

    // Truncate oldest messages first — keep most recent
    const kept: string[] = [];
    totalChars = header.length;

    for (let i = formatted.length - 1; i >= 0; i--) {
      const line = formatted[i]!;
      if (totalChars + line.length + 1 > maxChars) break;
      kept.unshift(line);
      totalChars += line.length + 1;
    }

    if (kept.length === 0) return { text: "", tokens: 0 };

    const raw = header + kept.join("\n");
    return { text: raw, tokens: this.estimateTokens(raw) };
  }
}
