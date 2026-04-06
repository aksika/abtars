/**
 * Direct API Transport — talks to any OpenAI-compatible endpoint.
 * Implements IKiroTransport with its own agent loop (send → stream → tools → loop).
 */

import { logInfo, logWarn, logDebug } from "../logger.js";
import { withRetry } from "../retry.js";
import { ConversationSession, type ToolCall } from "./conversation-session.js";
import { parseSSEStream, type SSEToolCallDelta } from "./sse-parser.js";
import { getToolSchemas, executeToolCall } from "./tool-registry.js";
import type { IKiroTransport } from "./kiro-transport.js";

const TAG = "direct-api";

export interface DirectApiConfig {
  endpoint: string;       // e.g. http://localhost:20128/v1
  apiKey?: string;
  model: string;
  maxContext: number;      // token budget
  maxOutput: number;       // max output tokens per response
  maxTurns: number;        // max tool-calling iterations per prompt
  fallbacks?: Array<{ endpoint: string; apiKey?: string; model: string }>;
}

export class DirectApiTransport implements IKiroTransport {
  private readonly config: DirectApiConfig;
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly abortControllers = new Map<string, AbortController>();
  private systemPrompt = "";
  private _contextPercent = -1;
  private _lastAnswer = "";
  private _intermediateText = "";
  private _promptStartedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private activeEndpoint: string;
  private activeApiKey?: string;
  private activeModel: string;

  onIntermediateResponse?: (text: string) => void;

  constructor(config: DirectApiConfig) {
    this.config = config;
    this.activeEndpoint = config.endpoint;
    this.activeApiKey = config.apiKey;
    this.activeModel = config.model;
  }

  async initialize(): Promise<void> {
    const fb = this.config.fallbacks?.length ? ` (+${this.config.fallbacks.length} fallback${this.config.fallbacks.length > 1 ? "s" : ""})` : "";
    logInfo(TAG, `🔌 Direct API transport (${this.config.endpoint}, model: ${this.config.model}${fb})`);
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async sendPrompt(sessionKey: string, message: string): Promise<string> {
    const session = this.getOrCreateSession(sessionKey);
    session.addUser(message);

    this._lastAnswer = "";
    this._intermediateText = "";
    this._promptStartedAt = Date.now();
    this._lastActivityAt = Date.now();

    const ac = new AbortController();
    this.abortControllers.set(sessionKey, ac);

    try {
      const result = await this.agentLoop(session, ac.signal);
      this._lastAnswer = result;
      // Restore primary on success (in case we fell back)
      this.activeEndpoint = this.config.endpoint;
      this.activeApiKey = this.config.apiKey;
      this.activeModel = this.config.model;
      return result;
    } catch (err) {
      // Try fallbacks
      if (this.config.fallbacks?.length && !ac.signal.aborted) {
        for (const fb of this.config.fallbacks) {
          logWarn(TAG, `Primary failed (${err instanceof Error ? err.message : String(err)}), trying fallback: ${fb.endpoint} / ${fb.model}`);
          this.activeEndpoint = fb.endpoint;
          this.activeApiKey = fb.apiKey;
          this.activeModel = fb.model;
          try {
            const result = await this.agentLoop(session, ac.signal);
            this._lastAnswer = result;
            return result;
          } catch (fbErr) {
            logWarn(TAG, `Fallback ${fb.model} failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
          }
        }
      }
      throw err;
    } finally {
      this._promptStartedAt = null;
      this.abortControllers.delete(sessionKey);
    }
  }

  private async agentLoop(session: ConversationSession, signal: AbortSignal): Promise<string> {
    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      if (signal.aborted) throw new Error("Aborted");

      const { content, toolCalls, usage } = await this.streamCompletion(session, signal);

      if (usage) {
        session.updateTokens(usage.prompt_tokens);
        this._contextPercent = session.contextPercent;
      }

      if (toolCalls.length > 0) {
        session.addAssistant(content, toolCalls);
        logDebug(TAG, `Tool calls: ${toolCalls.map(tc => tc.function.name).join(", ")}`);

        for (const tc of toolCalls) {
          if (signal.aborted) throw new Error("Aborted");
          this._lastActivityAt = Date.now();

          let args: Record<string, string>;
          try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

          const result = await executeToolCall(tc.function.name, args);
          session.addToolResult(tc.id, tc.function.name, result);
        }
        continue;
      }

      // No tool calls — final response
      const answer = content ?? "";
      session.addAssistant(answer);
      return answer;
    }

    logWarn(TAG, `Max turns (${this.config.maxTurns}) reached`);
    return session.messages.at(-1)?.content ?? "(max turns reached)";
  }

  private async streamCompletion(
    session: ConversationSession,
    signal: AbortSignal,
  ): Promise<{ content: string | null; toolCalls: ToolCall[]; usage: { prompt_tokens: number; completion_tokens: number } | null }> {
    const body = {
      model: this.activeModel,
      messages: session.messages,
      tools: getToolSchemas(),
      max_tokens: this.config.maxOutput,
      stream: true,
      stream_options: { include_usage: true },
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.activeApiKey) headers["Authorization"] = `Bearer ${this.activeApiKey}`;

    const response = await withRetry(
      async () => {
        const res = await fetch(`${this.activeEndpoint}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`API error ${res.status}: ${text.slice(0, 500)}`);
        }
        return res;
      },
      { attempts: 3, minDelayMs: 3000 },
    );

    let content = "";
    const toolCallAccumulator = new Map<string, { id: string; name: string; arguments: string }>();
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null;

    for await (const event of parseSSEStream(response, signal)) {
      this._lastActivityAt = Date.now();

      switch (event.type) {
        case "chunk":
          content += event.content;
          this._intermediateText += event.content;
          this.onIntermediateResponse?.(event.content);
          break;

        case "tool_call_delta":
          this.accumulateToolCall(toolCallAccumulator, event);
          break;

        case "done":
          usage = event.usage;
          break;
      }
    }

    const toolCalls: ToolCall[] = [...toolCallAccumulator.values()].map(tc => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));

    return { content: content || null, toolCalls, usage };
  }

  /** Accumulate streaming tool call deltas by ID (Ollama-safe: tracks by ID not index). */
  private accumulateToolCall(
    acc: Map<string, { id: string; name: string; arguments: string }>,
    delta: SSEToolCallDelta,
  ): void {
    // Use ID if available, fall back to index-based key
    const key = delta.id ?? `idx:${delta.index}`;
    const existing = acc.get(key);
    if (existing) {
      if (delta.arguments) existing.arguments += delta.arguments;
    } else {
      acc.set(key, { id: delta.id ?? `call_${acc.size}`, name: delta.name ?? "", arguments: delta.arguments ?? "" });
    }
  }

  private getOrCreateSession(sessionKey: string): ConversationSession {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = new ConversationSession(this.systemPrompt, this.config.maxContext);
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  async resetSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (session) session.reset(this.systemPrompt);
    else this.sessions.delete(sessionKey);
    logInfo(TAG, `Session ${sessionKey} reset`);
  }

  async sendInterrupt(): Promise<void> {
    for (const ac of this.abortControllers.values()) ac.abort();
  }

  destroy(): void {
    for (const ac of this.abortControllers.values()) ac.abort();
    this.sessions.clear();
    this.abortControllers.clear();
  }

  get isReady(): boolean { return true; }
  get contextPercent(): number { return this._contextPercent; }
  get answerOnly(): string { return this._lastAnswer; }

  /** Hot-swap the active model. Takes effect on next API call. */
  setModel(model: string): void {
    this.activeModel = model;
    logInfo(TAG, `Model switched to: ${model}`);
  }

  /** Get current active model name. */
  getModel(): string { return this.activeModel; }
  get intermediateDeliveredText(): string { return this._intermediateText; }
  get transportCommands(): string[] { return []; }

  // Watchdog support
  get promptStartedAt(): number | null { return this._promptStartedAt; }
  get lastActivityAt(): number | null { return this._lastActivityAt; }
}
