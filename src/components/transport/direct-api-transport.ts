import { getEnv } from "../env-schema.js";
/**
 * Direct API Transport — talks to any OpenAI-compatible endpoint.
 * Implements IKiroTransport with its own agent loop (send → stream → tools → loop).
 */

import { logInfo, logWarn, logDebug } from "../logger.js";
import { withRetry, isFatal } from "../retry.js";
import { ConversationSession, type ToolCall } from "./conversation-session.js";
import { parseSSEStream, type SSEToolCallDelta } from "./sse-parser.js";
import { getToolSchemas, executeToolCall } from "./tool-registry.js";
import { classifyError } from "./model-health-registry.js";
import type { FallbackPolicy } from "./fallback-policy.js";
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
  private _toolCallsSucceeded = 0;
  private _intermediateText = "";
  private _promptStartedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private activeEndpoint: string;
  private activeApiKey?: string;
  private activeModel: string;
  private _lastPromptTokens = 0;
  private _activeSessionKey = "";

  /** Currently active model (may differ from config if on fallback). */
  get currentModel(): string { return this.activeModel; }

  onIntermediateResponse?: (text: string) => void;
  onToolCallStart?: () => void;
  /** Called when fallback model is selected — send notification before response. */
  onFallback?: (model: string, ctxPercent: number, reason?: string) => void;

  /** Context orchestrator — when set, messages are built from DB instead of in-memory session. */
  contextOrchestrator?: import("../context/context-orchestrator.js").ContextOrchestrator;

  private policy: FallbackPolicy | null;
  private emergencyOverride: { endpoint: string; apiKey?: string; model: string; maxContext: number } | null = null;

  /** Activate emergency (hailMary) mode — next prompts bypass the fallback policy. */
  setEmergencyMode(override: { endpoint: string; apiKey?: string; model: string; maxContext: number } | null): void {
    this.emergencyOverride = override;
    if (override) logWarn(TAG, `🚨 EMERGENCY MODE: using ${override.model} (paid) — bypassing fallback chain`);
    else logInfo(TAG, "Emergency mode cleared — fallback chain active");
  }

  /** True if emergency (hailMary) mode is active. */
  get isEmergencyMode(): boolean { return this.emergencyOverride !== null; }

  constructor(config: DirectApiConfig, policy?: FallbackPolicy) {
    this.config = config;
    this.activeEndpoint = config.endpoint;
    this.activeApiKey = config.apiKey;
    this.activeModel = config.model;
    this.policy = policy ?? null;
  }

  async initialize(): Promise<void> {
    const count = this.policy ? this.policy.candidates.length : (this.config.fallbacks?.length ?? 0) + 1;
    const fb = count > 1 ? ` (+${count - 1} fallback${count > 2 ? "s" : ""})` : "";
    logInfo(TAG, `🔌 Direct API transport (${this.config.endpoint}, model: ${this.config.model}${fb})`);
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async sendPrompt(sessionKey: string, message: string): Promise<string> {
    const session = this.getOrCreateSession(sessionKey);
    this._activeSessionKey = sessionKey;

    // If context orchestrator is active, rebuild messages from DB
    if (this.contextOrchestrator) {
      try {
        const ctx = await this.contextOrchestrator.getContext(sessionKey, this.config.maxContext);
        // Replace session messages with DB-backed context + system prompt
        session.messages = [
          { role: "system" as const, content: this.systemPrompt },
          ...ctx.messages.map(m => ({ role: m.role as "user" | "assistant" | "tool", content: m.content })),
        ];
        if (ctx.compacted) logDebug(TAG, `Context compacted for ${sessionKey}`);
      } catch (err) {
        logWarn(TAG, `Context engine failed, falling back to in-memory: ${err}`);
      }
    }

    session.addUser(message);

    this._lastAnswer = "";
    this._toolCallsSucceeded = 0;
    this._intermediateText = "";
    this._promptStartedAt = Date.now();
    this._lastActivityAt = Date.now();

    const ac = new AbortController();
    this.abortControllers.set(sessionKey, ac);

    try {
      if (this.emergencyOverride) return await this.sendEmergency(session, ac.signal);
      if (!this.policy) throw new Error("DirectApiTransport requires a FallbackPolicy");
      return await this.sendWithPolicy(session, ac.signal);
    } finally {
      // AfterPrompt hook — observe-only, fire-and-forget
      const durationMs = Date.now() - (this._promptStartedAt ?? Date.now());
      import("../hooks/hook-system.js").then(({ hasHooks, fire }) => {
        if (!hasHooks("AfterPrompt")) return;
        fire("AfterPrompt", {
          event: "AfterPrompt", timestamp: new Date().toISOString(),
          sessionKey, platform: "", userId: "",
          model: this.activeModel, durationMs,
          inputTokens: this._lastPromptTokens || null,
          outputTokens: null, // not tracked per-prompt in DirectApi
        }).catch(() => {});
      }).catch(() => {});
      this._promptStartedAt = null;
      this.abortControllers.delete(sessionKey);
    }
  }

  private async sendEmergency(session: ConversationSession, signal: AbortSignal): Promise<string> {
    const em = this.emergencyOverride!;
    this.activeEndpoint = em.endpoint;
    this.activeApiKey = em.apiKey;
    this.activeModel = em.model;
    this._lastActivityAt = Date.now();
    logWarn(TAG, `🚨 Emergency mode: using ${em.model}`);
    const result = await this.agentLoop(session, signal);
    this._lastAnswer = result;
    return result;
  }

  private async sendWithPolicy(session: ConversationSession, signal: AbortSignal): Promise<string> {
    const policy = this.policy!;
    const failedAttempts: Array<{ model: string; kind: string; bucket: number }> = [];
    const isPrimary = (m: string): boolean => m === this.config.model;

    // Try each candidate via policy
    let candidate = policy.selectModel(this._lastPromptTokens);
    while (candidate) {
      this.activeEndpoint = candidate.endpoint;
      this.activeApiKey = candidate.apiKey;
      this.activeModel = candidate.model;
      this._lastActivityAt = Date.now();
      logDebug(TAG, `Trying model: ${candidate.model}`);

      if (!isPrimary(candidate.model) && this.onFallback) {
        const ctxPct = candidate.maxContext > 0 ? Math.round((this._lastPromptTokens / candidate.maxContext) * 100) : -1;
        const lastFail = failedAttempts[failedAttempts.length - 1];
        this.onFallback(candidate.model, ctxPct, lastFail?.kind);
      }

      try {
        const result = await this.agentLoop(session, signal);
        this._lastAnswer = result;
        if (!result || !result.trim()) {
          policy.recordError(candidate, "weak");
        } else {
          policy.recordSuccess(candidate);
        }
        return result;
      } catch (err) {
        const status = this.parseErrorStatus(err);
        const kind = classifyError(status);
        const retryAfterMs = this.parseRetryAfter(err);
        policy.recordError(candidate, kind, retryAfterMs);
        const bucket = policy.registry.getBucketLevel(candidate.model, candidate.endpoint);
        failedAttempts.push({ model: candidate.model, kind, bucket });
        session.rollbackToLastUser();
        logWarn(TAG, `${candidate.model} failed (${kind}, bucket: ${bucket}%${retryAfterMs ? `, retry-after: ${Math.round(retryAfterMs / 1000)}s` : ""}): ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
      }

      candidate = policy.selectModel(this._lastPromptTokens);
    }

    // Compaction fallback: pick smallest surviving candidate, truncate to fit
    const surviving = policy.survivingCandidates()
      .filter(c => c.maxContext > 0)
      .sort((a, b) => a.maxContext - b.maxContext);
    const smallest = surviving[0];

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
        const result = await this.agentLoop(session, signal);
        this._lastAnswer = result;
        if (!result || !result.trim()) policy.recordError(smallest, "weak");
        else policy.recordSuccess(smallest);
        return result;
      } catch (err) {
        const status = this.parseErrorStatus(err);
        policy.recordError(smallest, classifyError(status));
        failedAttempts.push({ model: smallest.model, kind: classifyError(status), bucket: policy.registry.getBucketLevel(smallest.model, smallest.endpoint) });
      }
    }

    const summary = failedAttempts.map(a => `  - ${a.model}: ${a.kind} (bucket: ${a.bucket}%)`).join("\n");
    if (policy.lastDecision) {
      logDebug(TAG, `Last decision: ${JSON.stringify(policy.lastDecision)}`);
    }
    throw new Error(`All models exhausted:\n${summary}`);
  }

  private async agentLoop(session: ConversationSession, signal: AbortSignal): Promise<string> {
    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      if (signal.aborted) throw new Error("Aborted");

      const { content, toolCalls, usage } = await this.streamCompletion(session, signal);

      if (usage) {
        session.updateTokens(usage.prompt_tokens);
        this._contextPercent = session.contextPercent;
        this._lastPromptTokens = usage.prompt_tokens;
        // Reactive feedback: if over threshold, flag for next buildContext
        this.contextOrchestrator?.onApiResponse(this._activeSessionKey, usage.prompt_tokens, this.config.maxContext);
      }

      if (toolCalls.length > 0) {
        session.addAssistant(content, toolCalls);
        logDebug(TAG, `Tool calls: ${toolCalls.map(tc => tc.function.name).join(", ")}`);

        for (const tc of toolCalls) {
          if (signal.aborted) throw new Error("Aborted");
          this._lastActivityAt = Date.now();
          this.onToolCallStart?.();

          let args: Record<string, string>;
          try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

          const result = await executeToolCall(tc.function.name, args);
          session.addToolResult(tc.id, tc.function.name, result);
          try { if (!JSON.parse(result).error) this._toolCallsSucceeded++; } catch { this._toolCallsSucceeded++; }
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

  /** Extract Retry-After from error (seconds or date). Returns ms or undefined. */
  private parseRetryAfter(err: unknown): number | undefined {
    const msg = err instanceof Error ? err.message : String(err);
    // Look for retry_after in JSON body: "retry_after":30 or "retry-after":"30"
    const jsonMatch = /retry[_-]after["\s:]+(\d+(?:\.\d+)?)/i.exec(msg);
    if (jsonMatch) return Math.ceil(parseFloat(jsonMatch[1]!) * 1000);
    // Look for x-ratelimit-reset (unix timestamp)
    const resetMatch = /x-ratelimit-reset["\s:]+(\d{10,13})/i.exec(msg);
    if (resetMatch) {
      const ts = parseInt(resetMatch[1]!, 10);
      const ms = ts < 1e12 ? ts * 1000 : ts; // seconds vs milliseconds
      const delta = ms - Date.now();
      return delta > 0 ? delta : undefined;
    }
    return undefined;
  }

  private async streamCompletion(
    session: ConversationSession,
    signal: AbortSignal,
  ): Promise<{ content: string | null; toolCalls: ToolCall[]; usage: { prompt_tokens: number; completion_tokens: number } | null }> {
    // Compose pipeline signal (user /stop) with per-request timeout
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(new Error("model API timeout")), getEnv().modelApiTimeoutMs);
    const composed = AbortSignal.any([signal, timeoutCtrl.signal]);

    try {
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
          signal: composed,
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
          if (/model API timeout/.test(msg)) return false;
          // Don't retry 429/401/402/403 — let the bucket loop handle model switching
          if (/API error (429|401|402|403)/.test(msg)) return false;
          return !isFatal(err);
        },
      },
    );

    let content = "";
    const toolCallAccumulator = new Map<string, { id: string; name: string; arguments: string }>();
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null;

    for await (const event of parseSSEStream(response, composed)) {
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
    } finally {
      clearTimeout(timer);
    }
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
  get toolCallsSucceeded(): number { return this._toolCallsSucceeded; }

  /** Hot-swap the active model. Takes effect on next API call. */
  setModel(model: string): void {
    this.activeModel = model;
    logInfo(TAG, `Model switched (user): ${model}`);
  }

  /** Hot-swap provider+model+policy. Rejects if prompt is in flight. */
  switchProvider(opts: { endpoint: string; apiKey?: string; model: string; maxContext: number; policy: FallbackPolicy }): void {
    if (this._promptStartedAt !== null) {
      throw new Error("Cannot switch provider while a prompt is in progress — try after the response");
    }
    this.activeEndpoint = opts.endpoint;
    this.activeApiKey = opts.apiKey;
    this.activeModel = opts.model;
    (this.config as { maxContext: number }).maxContext = opts.maxContext;
    this.policy = opts.policy;
    logInfo(TAG, `Provider switched: ${opts.model} @ ${opts.endpoint} (maxCtx=${opts.maxContext})`);
  }

  /** Get current active model name. */
  getModel(): string { return this.activeModel; }
  get intermediateDeliveredText(): string { return this._intermediateText; }
  get transportCommands(): string[] { return []; }

  // Watchdog support
  get promptStartedAt(): number | null { return this._promptStartedAt; }
  get lastActivityAt(): number | null { return this._lastActivityAt; }

  private readonly _stuckTimeout = getEnv().watchdogSilentSec * 1000;

  async healthCheck(): Promise<void> {
    if (!this._promptStartedAt) return;
    const idle = Date.now() - (this._lastActivityAt ?? this._promptStartedAt);
    if (idle > this._stuckTimeout) {
      logWarn(TAG, `[transport-health] Prompt stuck (${Math.round(idle / 1000)}s idle) — aborting`);
      await this.sendInterrupt();
    }
  }
}
