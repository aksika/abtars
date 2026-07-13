/**
 * Per-session conversation state for DirectApiTransport.
 * Manages message history and token tracking.
 */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// #1335: durable turn boundary for checkpoint selection
export interface DurableTurnBoundary {
  turnId: string;
  userMessageId: number;
  assistantMessageId?: number;
  disposition: "complete" | "interrupted" | "orphaned";
}

// #1335: atomic conversation unit for tool-exchange integrity
export type ConversationUnit =
  | { kind: "message"; start: number; end: number }
  | { kind: "tool_exchange"; start: number; end: number; callIds: string[] };

export class ConversationSession {
  messages: ChatMessage[] = [];
  totalPromptTokens = 0;
  /** #1335: current logical turn identity (set at user message time). */
  currentTurnId: string | null = null;
  /** #1335: durable turn boundaries for checkpoint selection. */
  turnBoundaries: DurableTurnBoundary[] = [];
  /** #1335: recent atomic growth measurements for reserve calculation. */
  recentAtomicGrowth: number[] = [];
  // #1276: align with pi-ai's effort level set (off|low|medium|high|xhigh). "off"
  // disables reasoning for the session; "xhigh" is pi-ai's max level.
  reasoningEffort: "off" | "low" | "medium" | "high" | "xhigh" | null = null;
  showReasoning = false;
  private readonly maxContext: number;

  constructor(systemPrompt: string, maxContext: number) {
    this.maxContext = maxContext;
    this.messages.push({ role: "system", content: systemPrompt });
  }

  addUser(content: string, image?: { mime: string; base64: string }): void {
    if (image) {
      this.messages.push({ role: "user", content: [
        { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } },
        { type: "text", text: content },
      ]});
    } else {
      this.messages.push({ role: "user", content });
    }
  }

  addAssistant(content: string | null, toolCalls?: ToolCall[]): void {
    const msg: ChatMessage = { role: "assistant", content };
    if (toolCalls?.length) msg.tool_calls = toolCalls;
    this.messages.push(msg);
  }

  addToolResult(toolCallId: string, name: string, content: string): void {
    this.messages.push({ role: "tool", content, tool_call_id: toolCallId, name });
  }

  updateTokens(promptTokens: number): void {
    this.totalPromptTokens = promptTokens;
  }

  get contextPercent(): number {
    if (this.maxContext <= 0) return 0;
    return Math.round((this.totalPromptTokens / this.maxContext) * 100);
  }

  reset(systemPrompt: string): void {
    this.messages = [{ role: "system", content: systemPrompt }];
    this.totalPromptTokens = 0;
    this.reasoningEffort = null;
    this.showReasoning = false;
  }

  /** Roll back to last user message — remove everything after it for clean fallback. */
  rollbackToLastUser(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === "user") {
        this.messages.splice(i + 1);
        return;
      }
    }
  }

  /** Rough token estimate: ~4 chars per token. */
  estimateTokens(): number {
    return Math.round(this.messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0) / 4);
  }

  /** Drop oldest non-system messages until estimated tokens fit within limit. */
  truncateToFit(maxTokens: number): void {
    while (this.messages.length > 2 && this.estimateTokens() > maxTokens * 0.85) {
      this.messages.splice(1, 1); // remove oldest after system prompt
    }
    this.totalPromptTokens = this.estimateTokens();
  }

  /** #621: Replace a literal secret value with [REDACTED] across all messages. */
  scrubFromHistory(value: string): void {
    for (const msg of this.messages) {
      if (typeof msg.content === "string" && msg.content.includes(value)) {
        msg.content = msg.content.replaceAll(value, "[REDACTED]");
      }
    }
  }

  /** #1335: Scan messages for atomic tool-exchange units. */
  scanAtomicUnits(): ConversationUnit[] {
    const units: ConversationUnit[] = [];
    let i = 0;
    while (i < this.messages.length) {
      const msg = this.messages[i]!;
      // Skip system messages
      if (msg.role === "system") { i++; continue; }

      if (msg.role === "assistant" && msg.tool_calls?.length) {
        // Tool exchange: collect assistant + all following tool results,
        // then the subsequent assistant continuation if any
        const start = i;
        const callIds = msg.tool_calls.map(tc => tc.id);
        i++;
        while (i < this.messages.length && this.messages[i]?.role === "tool") {
          const toolMsg = this.messages[i]!;
          if (toolMsg.tool_call_id && !callIds.includes(toolMsg.tool_call_id)) {
            break;
          }
          i++;
        }
        // Include subsequent assistant continuation if present
        if (i < this.messages.length && this.messages[i]?.role === "assistant") {
          i++;
        }
        units.push({ kind: "tool_exchange", start, end: i - 1, callIds });
      } else {
        units.push({ kind: "message", start: i, end: i });
        i++;
      }
    }
    return units;
  }

  /** #1335: Check if there's an in-flight incomplete tool exchange. */
  hasIncompleteToolExchange(): boolean {
    // Walk backwards from end: if the last non-system message is an assistant
    // with tool_calls and the following messages don't complete the exchange,
    // it's incomplete.
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      if (msg.role === "system") continue;
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        // Check if there's a subsequent assistant continuation
        for (let j = i + 1; j < this.messages.length; j++) {
          const next = this.messages[j]!;
          if (next.role === "assistant" && !next.tool_calls?.length) return false;
        }
        return true;
      }
      if (msg.role === "assistant") return false;
      break;
    }
    return false;
  }

  /** #1335: Record growth from the last turn (token delta). */
  recordAtomicGrowth(currentTokens: number): void {
    const prevTokens = this.totalPromptTokens;
    if (prevTokens > 0) {
      const growth = currentTokens - prevTokens;
      if (growth > 0) {
        this.recentAtomicGrowth.push(growth);
        if (this.recentAtomicGrowth.length > 20) this.recentAtomicGrowth.shift();
      }
    }
  }
}
