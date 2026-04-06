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

  /** Remove trailing incomplete tool exchange (assistant requested tools but results missing/partial). */
  stripPendingToolCalls(): void {
    if (this.messages.length < 2) return;
    const last = this.messages[this.messages.length - 1]!;
    // Only strip if last message is an assistant with tool_calls (no results yet)
    if (last.role === "assistant" && last.tool_calls?.length) {
      this.messages.pop();
      return;
    }
    // Check if we have a partial tool result set (some results missing)
    // Find last assistant with tool_calls
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
        const gotIds = new Set<string>();
        for (let j = i + 1; j < this.messages.length; j++) {
          if (this.messages[j]!.role === "tool" && this.messages[j]!.tool_call_id) gotIds.add(this.messages[j]!.tool_call_id!);
        }
        if (gotIds.size < expectedIds.size) {
          // Incomplete — strip from the assistant message onwards
          this.messages.splice(i);
        }
        break;
      }
      if (msg.role === "user") break; // reached previous user turn, stop
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
