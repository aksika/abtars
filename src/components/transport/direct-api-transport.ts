/**
 * Direct API Transport — talks to any OpenAI-compatible endpoint.
 * Implements IKiroTransport with its own agent loop (send → stream → tools → loop).
 */

import { logInfo, logWarn, logDebug } from "../logger.js";
import { withRetry, isFatal } from "../retry.js";
import { ConversationSession, type ToolCall } from "./conversation-session.js";
import { parseSSEStream, type SSEToolCallDelta } from "./sse-parser.js";
import { getToolSchemas, executeToolCall } from "./tool-registry.js";
import { shouldSkip, recordError, classifyError, getBucketLevel } from "./leaky-bucket.js";
import type { IKiroTransport } from "./kiro-transport.js";

const TAG = "direct-api";

export interface DirectApiConfig {
  endpoint: string;       // e.g. http://localhost:20128/v1
  apiKey?: string;
  model: string;
  maxContext: number;      // token budget
  maxOutput: number;       // max output tokens per response
  maxTurns: number;        // max tool-calling iterations per prompt
  fallbacks?: Array<{ endpoint: string; apiKey?: string; model: string; maxContext?: number }>;
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
  private _lastPromptTokens = 0;

  /** Currently active model (may differ from config if on fallback). */
  get currentModel(): string { return this.activeModel; }

  onIntermediateResponse?: (text: string) => void;
  /** Called when fallback model is selected — send notification before response. */
  onFallback?: (model: string, ctxPercent: number) => void;

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
      // Build candidate list: user override first, then primary + fallbacks
      const allCandidates = [
        { endpoint: this.config.endpoint, apiKey: this.config.apiKey, model: this.config.model, maxContext: this.config.maxContext },
        ...(this.config.fallbacks ?? []).map(fb => ({ ...fb, maxContext: fb.maxContext ?? this.config.maxContext })),
      ];

      // If user manually switched model, put it first
      if (this._userModelOverride) {
        const idx = allCandidates.findIndex(c => c.model === this._userModelOverride);
        if (idx >= 0) {
          const [override] = allCandidates.splice(idx, 1);
          allCandidates.unshift(override!);
        } else {
          // Model not in config — add it using primary endpoint
          allCandidates.unshift({ endpoint: this.activeEndpoint, apiKey: this.activeApiKey, model: this._userModelOverride, maxContext: this.config.maxContext });
        }
      }
      const candidates = allCandidates;

      const isPrimary = (c: typeof candidates[0]): boolean => c.model === this.config.model && c.endpoint === this.config.endpoint;

      for (const candidate of candidates) {
        const bucketKey = `${candidate.endpoint}|${candidate.model}`;
        if (shouldSkip(bucketKey)) {
          logDebug(TAG, `Skipping ${candidate.model} (bucket: ${getBucketLevel(bucketKey)}%)`);
          continue;
        }

        // Context fit check — skip if conversation won't fit
        if (this._lastPromptTokens > 0 && candidate.maxContext > 0 && this._lastPromptTokens > candidate.maxContext * 0.95) {
          logWarn(TAG, `Skipping ${candidate.model} — context too large (${this._lastPromptTokens} tokens > ${candidate.maxContext} limit)`);
          continue;
        }

        this.activeEndpoint = candidate.endpoint;
        this.activeApiKey = candidate.apiKey;
        this.activeModel = candidate.model;
        this._lastActivityAt = Date.now();
        logDebug(TAG, `Trying model: ${candidate.model}`);

        // Notify user on fallback
        if (!isPrimary(candidate) && this.onFallback) {
          const ctxPct = candidate.maxContext > 0 ? Math.round((this._lastPromptTokens / candidate.maxContext) * 100) : -1;
          this.onFallback(candidate.model, ctxPct);
        }

        try {
          const result = await this.agentLoop(session, ac.signal);
          this._lastAnswer = result;
          return result;
        } catch (err) {
          const status = this.parseErrorStatus(err);
          const kind = classifyError(status);
          recordError(bucketKey, kind);
          session.rollbackToLastUser(); // clean slate for fallback model
          logWarn(TAG, `${candidate.model} failed (${kind}, bucket: ${getBucketLevel(bucketKey)}%): ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
        }
      }

      // All models failed — try compacting session to fit smallest available model
      const smallest = candidates
        .filter(c => !shouldSkip(`${c.endpoint}|${c.model}`) && c.maxContext > 0)
        .sort((a, b) => a.maxContext - b.maxContext)[0];

      if (smallest && this._lastPromptTokens > smallest.maxContext * 0.95) {
        logWarn(TAG, `Compacting session to fit ${smallest.model} (${smallest.maxContext} tokens)`);
        session.truncateToFit(smallest.maxContext);
        this.activeEndpoint = smallest.endpoint;
        this.activeApiKey = smallest.apiKey;
        this.activeModel = smallest.model;
        if (this.onFallback) {
          this.onFallback(`${smallest.model} (compacted)`, Math.round((session.estimateTokens() / smallest.maxContext) * 100));
        }
        try {
          const result = await this.agentLoop(session, ac.signal);
          this._lastAnswer = result;
          return result;
        } catch (err) {
          const status = this.parseErrorStatus(err);
          recordError(`${smallest.endpoint}|${smallest.model}`, classifyError(status));
        }
      }

      throw new Error("All models exhausted");
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
        this._lastPromptTokens = usage.prompt_tokens;
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

  private parseErrorStatus(err: unknown): number {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /API error (\d+)/.exec(msg);
    return m ? parseInt(m[1]!, 10) : 0;
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
      {
        attempts: 3, minDelayMs: 3000,
        isRecoverable: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Don't retry 429/401/402/403 — let the bucket loop handle model switching
          if (/API error (429|401|402|403)/.test(msg)) return false;
          return !isFatal(err);
        },
      },
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
  private _userModelOverride: string | null = null;

  setModel(model: string): void {
    this.activeModel = model;
    this._userModelOverride = model;
    logInfo(TAG, `Model switched (user): ${model}`);
  }

  /** Get current active model name. */
  getModel(): string { return this.activeModel; }
  get intermediateDeliveredText(): string { return this._intermediateText; }
  get transportCommands(): string[] { return []; }

  // Watchdog support
  get promptStartedAt(): number | null { return this._promptStartedAt; }
  get lastActivityAt(): number | null { return this._lastActivityAt; }
}
