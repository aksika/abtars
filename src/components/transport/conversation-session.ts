/**
 * Per-session conversation state for DirectApiTransport.
 * Manages message history and token tracking.
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export class ConversationSession {
  messages: ChatMessage[] = [];
  totalPromptTokens = 0;
  private readonly maxContext: number;

  constructor(systemPrompt: string, maxContext: number) {
    this.maxContext = maxContext;
    this.messages.push({ role: "system", content: systemPrompt });
  }

  addUser(content: string): void {
    this.messages.push({ role: "user", content });
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
}
