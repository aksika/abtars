import { getEnv } from "../env-schema.js";
/**
 * Direct API Transport — talks to any OpenAI-compatible endpoint.
 * Implements IKiroTransport with its own agent loop (send → stream → tools → loop).
 */

import { logInfo, logWarn, logDebug, logTrace } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { withRetry, isFatal } from "../retry.js";
import { ConversationSession, type ToolCall, type ContentPart } from "./conversation-session.js";
import { parseSSEStream, type SSEToolCallDelta } from "./sse-parser.js";
import { getToolSchemas, executeToolCall } from "./tool-registry.js";
import { classifyError } from "./model-health-registry.js";
import { normalizeToolCalls, parseErrorStatus, parseRetryAfter, parseUsageLimitCooldown } from "./transport-utils.js";
import { recordUsage } from "../usage-tracker.js";
import type { FallbackPolicy } from "./fallback-policy.js";
import type { IKiroTransport } from "./kiro-transport.js";

const TAG = "direct-api";


export interface DirectApiConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  maxContext: number;
  maxOutput: number;
  maxTurns: number;
  apiFormat?: "chat" | "responses" | "anthropic";
  thinking?: { style: "effort"; default: string } | { style: "extended"; default: number };
  fallbacks?: Array<{ endpoint: string; apiKey?: string; model: string; maxContext?: number }>;
}

export { normalizeToolCalls } from "./transport-utils.js";

export class DirectApiTransport implements IKiroTransport {
  private readonly config: DirectApiConfig;
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly abortControllers = new Map<string, AbortController>();
  private systemPrompt = "";
  private _contextPercent = -1;
  private _lastAnswer = "";
  private _timeoutOverrideMs: number | null = null;
  private _toolCallsSucceeded = 0;
  private _intermediateText = "";
  private _promptStartedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private activeEndpoint: string;
  private activeApiKey?: string;
  private activeModel: string;
  private _lastPromptTokens = 0;
  private _activeSessionKey = "";
  private _activeUserId = "master";

  /** Currently active model (may differ from config if on fallback). */
  get currentModel(): string { return this.activeModel; }

  onIntermediateResponse?: (text: string) => void;
  onToolCallStart?: (toolName: string) => void;
  onSegmentBreak?: (text: string) => void;
  /** Sandbox policy for tool access control (#681). Set by pipeline before prompt. */
  sandboxPolicy?: import("../tool-sandbox.js").SandboxPolicy;
  /** Called when fallback model is selected — send notification before response. */
  onFallback?: (model: string, ctxPercent: number, reason?: string) => void;
  /** Cooperative pause check — if returns true, agent loop breaks between tool calls. */
  isPaused?: () => boolean;
  /** Returns a pending instruction from parent, if any. Consumed once. */
  getPendingInstruction?: () => string | undefined;

  /** Context orchestrator — when set, messages are built from DB instead of in-memory session. */
  contextOrchestrator?: import("abmind").ContextOrchestrator;

  private policy: FallbackPolicy | null;
  private emergencyOverride: { endpoint: string; apiKey?: string; model: string; maxContext: number } | null = null;

  /** Activate emergency (hailMary) mode — next prompts bypass the fallback policy. */
  setEmergencyMode(override: { endpoint: string; apiKey?: string; model: string; maxContext: number } | null): void {
    if (!override && !this.emergencyOverride) return; // no-op if already off
    this.emergencyOverride = override;
    if (override) logWarn(TAG, `🚨 EMERGENCY MODE: using ${override.model} (paid) — bypassing fallback chain`);
    else { this.activeModel = this.config.model; logInfo(TAG, `Emergency mode cleared — restored ${this.config.model}`); }
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

  async sendPrompt(sessionKey: string, message: string, image?: { mime: string; base64: string }, userId?: string): Promise<string> {
    const session = this.getOrCreateSession(sessionKey);
    this._activeSessionKey = sessionKey;
    this._activeUserId = userId || "master";

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

    session.addUser(message, image);

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
        }).catch(err => logAndSwallow(TAG, "fire AfterPrompt", err));
      }).catch(err => logAndSwallow(TAG, "import hook-system", err));
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
        if (signal.aborted) { session.rollbackToLastUser(); throw err; }
        const errMsg = err instanceof Error ? err.message : String(err);
        // Capability miss — strip image and retry text-only (#670)
        if (errMsg.includes("does not support image input") || errMsg.includes("No endpoints found that support image")) {
          session.rollbackToLastUser();
          // Strip image parts from session, retry same model text-only
          for (const m of session.messages) {
            if (Array.isArray(m.content)) {
              const textParts = (m.content as Array<{ type: string; text?: string }>).filter(p => p.type === "text");
              m.content = textParts.map(p => p.text ?? "").join("\n") || "User sent an image (not supported by this model).";
            }
          }
          logWarn(TAG, `${candidate.model} doesn't support images — retrying text-only`);
          if (this.onIntermediateResponse) this.onIntermediateResponse("⚠️ Model doesn't support images via this provider. Sending text-only.\n");
          try {
            const result = await this.agentLoop(session, signal);
            this._lastAnswer = result;
            policy.recordSuccess(candidate);
            return result;
          } catch (retryErr) {
            const retryStatus = this.parseErrorStatus(retryErr);
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            policy.recordError(candidate, classifyError(retryStatus, retryMsg));
            session.rollbackToLastUser();
            throw retryErr;
          }
        }
        const status = this.parseErrorStatus(err);
        const kind = classifyError(status, errMsg);
        const retryAfterMs = this.parseRetryAfter(err) ?? parseUsageLimitCooldown(errMsg);
        policy.recordError(candidate, kind, retryAfterMs);
        const bucket = policy.registry.getBucketLevel(candidate.model, candidate.endpoint);
        failedAttempts.push({ model: candidate.model, kind, bucket });
        session.rollbackToLastUser();
        logWarn(TAG, `${candidate.model} failed (${kind}, bucket: ${bucket}%${retryAfterMs ? `, retry-after: ${Math.round(retryAfterMs / 1000)}s` : ""}): ${errMsg.slice(0, 100)}`);
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
        const errMsg2 = err instanceof Error ? err.message : String(err);
        policy.recordError(smallest, classifyError(status, errMsg2));
        failedAttempts.push({ model: smallest.model, kind: classifyError(status, errMsg2), bucket: policy.registry.getBucketLevel(smallest.model, smallest.endpoint) });
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
      if (this.isPaused?.()) return "⏸ Session paused. Use `/session resume` to continue.";

      const pendingInstruction = this.getPendingInstruction?.();
      if (pendingInstruction) session.addUser(pendingInstruction);

      const { content, toolCalls, usage } = await this.streamCompletion(session, signal);

      if (usage) {
        session.updateTokens(usage.prompt_tokens);
        this._contextPercent = session.contextPercent;
        this._lastPromptTokens = usage.prompt_tokens;
        this.contextOrchestrator?.onApiResponse(this._activeSessionKey, usage.prompt_tokens, this.config.maxContext);
        logTrace(TAG, `${this.activeModel} — ${usage.prompt_tokens}→${usage.completion_tokens ?? 0} tokens, ${Date.now() - (this._lastActivityAt ?? Date.now())}ms`);
        recordUsage(this.activeModel, usage.prompt_tokens, usage.completion_tokens ?? 0);
      }

      if (toolCalls.length > 0) {
        session.addAssistant(content, toolCalls);
        logDebug(TAG, `Tool calls: ${toolCalls.map(tc => tc.function.name).join(", ")}`);
        logTrace(TAG, `Tool args: ${toolCalls.map(tc => {
          // #621: redact abmind_store args based on classification
          if ((tc.function.name === "abmind_store" || tc.function.name === "memory_store") && /class(?:ification)?[":\s]+[23]/.test(tc.function.arguments)) {
            return `${tc.function.name}([REDACTED])`;
          }
          return `${tc.function.name}(${tc.function.arguments})`;
        }).join(", ")}`);

        // Deliver pre-tool text immediately (segment break)
        if (content?.trim()) {
          this.onSegmentBreak?.(content.trim());
        }

        for (const tc of toolCalls) {
          if (signal.aborted) throw new Error("Aborted");
          this._lastActivityAt = Date.now();
          this.onToolCallStart?.(tc.function.name ?? "tool");

          let args: Record<string, string>;
          try { args = JSON.parse(tc.function.arguments); } catch (err) { logAndSwallow(TAG, "JSON.parse tool args", err); args = {}; }

          const result = await executeToolCall(tc.function.name, args, { userId: this._activeUserId, signal, sandboxPolicy: this.sandboxPolicy });
          session.addToolResult(tc.id, tc.function.name, result);

          // #621: scrub secret values from conversation history after store
          if ((tc.function.name === "abmind_store" || tc.function.name === "memory_store") && parseInt(args.classification ?? args.class ?? "1", 10) >= 2) {
            const secretValue = args.content ?? args.value ?? args.translated;
            if (secretValue && secretValue.length > 4) {
              session.scrubFromHistory(secretValue);
            }
          }

          try { if (!JSON.parse(result).error) this._toolCallsSucceeded++; } catch (err) { logAndSwallow(TAG, "JSON.parse tool result", err); this._toolCallsSucceeded++; }
        }
        continue;
      }

      // No tool calls — final response
      const answer = content ?? "";
      session.addAssistant(answer);
      return answer;
    }

    logWarn(TAG, `Max turns (${this.config.maxTurns}) reached`);
    const last = session.messages.at(-1)?.content;
    return (typeof last === "string" ? last : null) ?? "(max turns reached)";
  }

  private parseErrorStatus(err: unknown): number { return parseErrorStatus(err); }

  /** Extract Retry-After from error (seconds or date). Returns ms or undefined. */
  private parseRetryAfter(err: unknown): number | undefined { return parseRetryAfter(err); }

  private async streamCompletion(
    session: ConversationSession,
    signal: AbortSignal,
  ): Promise<{ content: string | null; toolCalls: ToolCall[]; usage: { prompt_tokens: number; completion_tokens: number } | null }> {
    // Compose pipeline signal (user /stop) with per-request timeout
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(new Error("model API timeout")), this._timeoutOverrideMs ?? getEnv().modelApiTimeoutMs);
    const composed = AbortSignal.any([signal, timeoutCtrl.signal]);

    try {
    // Responses API format (#465, streaming #472)
    if (this.config.apiFormat === "responses") {
      const { toResponsesRequest } = await import("./responses-adapter.js");
      const { parseResponsesSSE } = await import("./sse-parser-responses.js");
      const msgs = session.messages.map(m => ({ role: m.role, content: m.content ?? "" as string | ContentPart[] }));
      const reqBody = { ...toResponsesRequest(this.activeModel, msgs, getToolSchemas(this.sandboxPolicy), this.config.maxOutput), stream: true };
      const hdrs: Record<string, string> = { "Content-Type": "application/json" };
      if (this.activeApiKey) hdrs["Authorization"] = `Bearer ${this.activeApiKey}`;
      const res = await fetch(`${this.activeEndpoint}/responses`, {
        method: "POST", headers: hdrs, body: JSON.stringify(reqBody), signal: composed,
      });
      if (!res.ok) { const text = await res.text().catch(err => { logAndSwallow(TAG, "read error body", err); return ""; }); throw new Error(`API error ${res.status}: ${text.slice(0, 500)}`); }

      let content = "";
      let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
      const toolCallAcc = new Map<string, { id: string; name: string; arguments: string }>();
      for await (const event of parseResponsesSSE(res, composed)) {
        this._lastActivityAt = Date.now();
        if (event.type === "chunk") { content += event.content; this._intermediateText += event.content; this.onIntermediateResponse?.(event.content); }
        else if (event.type === "tool_call_delta") { this.accumulateToolCall(toolCallAcc, event); }
        else if (event.type === "done") { usage = event.usage; }
      }
      clearTimeout(timer);
      const toolCalls = this.finalizeToolCalls(toolCallAcc);
      return { content: content || null, toolCalls, usage };
    }

    // Anthropic Messages API format (#467, streaming #472)
    if (this.config.apiFormat === "anthropic") {
      const { toAnthropicRequest, buildAnthropicHeaders } = await import("./anthropic-adapter.js");
      const { parseAnthropicSSE } = await import("./sse-parser-anthropic.js");
      const msgs = session.messages.map(m => ({ role: m.role, content: m.content ?? "" as string | ContentPart[], tool_call_id: m.tool_call_id }));
      const reqBody = { ...toAnthropicRequest(this.activeModel, msgs, this.config.maxOutput, getToolSchemas(this.sandboxPolicy)), stream: true };
      const hdrs = buildAnthropicHeaders(this.activeApiKey ?? "");
      const res = await fetch(`${this.activeEndpoint}/messages`, {
        method: "POST", headers: hdrs, body: JSON.stringify(reqBody), signal: composed,
      });
      if (!res.ok) { const text = await res.text().catch(err => { logAndSwallow(TAG, "read error body", err); return ""; }); throw new Error(`API error ${res.status}: ${text.slice(0, 500)}`); }

      let content = "";
      let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
      const toolCallAcc = new Map<string, { id: string; name: string; arguments: string }>();
      for await (const event of parseAnthropicSSE(res, composed)) {
        this._lastActivityAt = Date.now();
        if (event.type === "chunk") { content += event.content; this._intermediateText += event.content; this.onIntermediateResponse?.(event.content); }
        else if (event.type === "tool_call_delta") { this.accumulateToolCall(toolCallAcc, event); }
        else if (event.type === "done") { usage = event.usage; }
      }
      clearTimeout(timer);
      const toolCalls = this.finalizeToolCalls(toolCallAcc);
      return { content: content || null, toolCalls, usage };
    }

    const body: Record<string, unknown> = {
      model: this.activeModel,
      messages: session.messages,
      tools: getToolSchemas(this.sandboxPolicy),
      max_tokens: this.config.maxOutput,
      stream: true,
      stream_options: { include_usage: true },
    };

    // #466: inject thinking/reasoning parameters
    if (this.config.thinking) {
      if (this.config.thinking.style === "effort") {
        body.reasoning_effort = this.config.thinking.default;
      } else if (this.config.thinking.style === "extended") {
        body.thinking = { type: "enabled", budget_tokens: this.config.thinking.default };
      }
    }

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
          const text = await res.text().catch(err => { logAndSwallow(TAG, "read error body", err); return ""; });
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

    const toolCalls = this.finalizeToolCalls(toolCallAccumulator);

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

  /**
   * Convert accumulated tool call map → normalized ToolCall array.
   * Handles model fragmentation: some models (nemotron, mistral-free) split a
   * single tool call across multiple SSE entries with different indices/IDs.
   * Pattern: [name="execute_bash" args="{}"], [name="" args=""], [name="" args='{"command":"..."}']
   * Fix: merge adjacent unnamed entries' args into the preceding named entry.
   */
  private finalizeToolCalls(acc: Map<string, { id: string; name: string; arguments: string }>): ToolCall[] {
    const raw: ToolCall[] = [...acc.values()].map(tc => ({
      id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments },
    }));
    return normalizeToolCalls(raw);
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
    (this.config as { model: string }).model = model;
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
    (this.config as { model: string; maxContext: number }).model = opts.model;
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
  setTimeoutOverride(ms: number | null): void { this._timeoutOverrideMs = ms; }

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
