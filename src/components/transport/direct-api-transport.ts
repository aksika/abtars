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
import { classifyError, type ErrorKind } from "./model-health-registry.js";
import { normalizeToolCalls, parseErrorStatus, parseRetryAfter, parseUsageLimitCooldown } from "./transport-utils.js";
import { recordUsage } from "../usage-tracker.js";
import { recordCacheTelemetry, stableHash, sessionHash, candidateKeyHash, firstChangedMessageIndex } from "../cache-telemetry.js";
import { clampMaxOutputTokens, estimateTokensFromChars, calculateReserve } from "./token-budget.js";
import type { FallbackPolicy } from "./fallback-policy.js";
import type { IKiroTransport, PromptRequestContext, RuntimeStatusSnapshot, RuntimeUsageSnapshot } from "./kiro-transport.js";
import type { OutputObserver } from "../session-output-feed.js";
import { isCompactable } from "../spin-types.js";
import { ToolLoopGuard, ToolBehaviorError } from "./tool-loop-guard.js";
import { candidateKey } from "./model-candidates.js";
import type { CandidateSpec } from "./model-candidates.js";

const TAG = "direct-api";

export interface PromptToolBudget {
  readonly maxRounds: number;
  roundsUsed: number;
}

export interface AgentLoopPolicy {
  candidateKey: string;
  candidateRoundLimit: number;
  promptBudget: PromptToolBudget;
}

export interface DirectApiConfig {
  route?: import("../transport-config.js").ExecutionRoute;
  provider?: string;
  endpoint: string;
  apiKey?: string;
  model: string;
  maxContext: number;
  maxOutput: number;
  maxTurns: number;
  maxToolRounds?: number;
  maxFallbackToolRounds?: number;
  apiFormat?: "chat" | "responses" | "anthropic";
  /** #1311: route DirectApi through the pi-ai provider engine (L1) when installed. Default off — L0 reptile floor otherwise. */
  useProviderLib?: boolean;
  thinking?:
    | { style: "default" }
    | { style: "effort"; default: "off" | "low" | "medium" | "high" | "xhigh" }
    | { style: "extended"; default: number };
  fallbacks?: Array<{ endpoint: string; apiKey?: string; model: string; maxContext?: number }>;
}


export class DirectApiTransport implements IKiroTransport {
  private readonly config: DirectApiConfig;
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly abortControllers = new Map<string, AbortController>();
  private systemPrompt = "";
  private _contextPercent = -1;
  private _lastAnswer = "";
  private _timeoutOverrideMs: number | null = null;
  private _maxToolRoundsOverride: number | null = null;
  private _toolCallsSucceeded = 0;
  private _intermediateText = "";
  private _promptStartedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private activeProvider: string;
  private activeEndpoint: string;
  private activeApiKey?: string;
  private activeModel: string;
  /** #1295: maxContext of the model currently serving requests. Used for accurate contextPercent. */
  private _activeMaxContext: number;
  /** #1335: previous turn's stable prefix digest for churn detection. */
  private _priorStablePrefixDigest = "";
  /** #1335: previous turn's stable prefix token count for churn detection. */
  private _priorStablePrefixTokens = 0;
  /** #1335 finding #6: per-message digests of the previous stable prefix, used
   *  to locate the first changed message for churn evidence. */
  private _priorStablePrefixMessageDigests: string[] = [];
  private readonly useProviderLib: boolean;
  private _lastPromptTokens = 0;
  private _lastCompletionTokens = 0;
  /** #1311: prompt-cache token totals from the pi-ai path (null on L0 — reptile adapters don't report cache). */
  private _lastCacheRead: number | null = null;
  private _lastCacheWrite: number | null = null;
  private _lastTurnUsage: RuntimeUsageSnapshot | null = null;
  private _activeSessionKey = "";
  private _activeUserId = "master";
  private _outputObserver?: OutputObserver;
  /** #1444: tracks the model/provider a fallback transitioned from (for telemetry). */
  private _fallbackFrom: string | undefined;

  /** Agent name for budget tracking (set by caller). */
  agentLabel = "main";

  /** Currently active model (may differ from config if on fallback). */
  get currentModel(): string { return this.activeModel; }

  /** #1418: Last successful Main candidate — secret-free resolved tuple (provider, model,
   *  endpoint, maxContext). Cleared on rebuild so specialists fall back to configured Main. */
  private _lastSuccessfulCandidate: CandidateSpec | null = null;
  get lastSuccessfulCandidate(): CandidateSpec | null { return this._lastSuccessfulCandidate; }
  clearSuccessfulCandidate(): void { this._lastSuccessfulCandidate = null; }

  onIntermediateResponse?: (text: string) => void;
  onToolCallStart?: (toolName: string) => void;
  onSegmentBreak?: (text: string) => void;
  /** Sandbox policy for tool access control (#681). Set by pipeline before prompt. */
  sandboxPolicy?: import("../tool-sandbox.js").SandboxPolicy;
  /** Called when fallback model is selected — send notification before response. */
  onFallback?: (model: string, ctxPercent: number, reason?: string) => void;
  /** #1296: fired when the primary model succeeds after a fallback episode, so the
   *  notification layer can re-arm and notify again on the next fallback. */
  onPrimaryRestored?: () => void;
  /** #1418: fired after a successful, non-empty Main response — records the working candidate. */
  onMainSuccess?: (candidate: CandidateSpec) => void;
  /** #1418: callback to signal last-successful-Main change to downstream consumers. */
  onLastSuccessfulChanged?: (candidate: CandidateSpec) => void;
  /** Cooperative pause check — if returns true, agent loop breaks between tool calls. */
  isPaused?: () => boolean;
  /** Returns a pending instruction from parent, if any. Consumed once. */
  getPendingInstruction?: () => string | undefined;
  /** #1444: execution telemetry scope — set per sendPrompt from PromptRequestContext. */
  executionTelemetry?: import("../execution-telemetry.js").ExecutionTelemetryScope;

  /** Context orchestrator — when set, messages are built from DB instead of in-memory session. */
  contextOrchestrator?: import("abmind").ContextOrchestrator;

  /** #1335: Checkpoint engine for cache-stable context assembly. */
  checkpointEngine?: import("../checkpoint-engine.js").CheckpointEngine;

  /** Memory backend — used for hydrating sessions after restart (#843). */
  memoryBackend?: { getRecentConversation(userId: string, since: number, limit: number): Array<{ role: string; content: string; timestamp: number }> };

  private policy: FallbackPolicy | null;
  private emergencyOverride: { provider: string; endpoint: string; apiKey?: string; model: string; maxContext: number } | null = null;

  /** Activate emergency (hailMary) mode — next prompts bypass the fallback policy. */
  setEmergencyMode(override: { provider: string; endpoint: string; apiKey?: string; model: string; maxContext: number } | null): void {
    if (!override && !this.emergencyOverride) return;
    if (override) {
      this.emergencyOverride = override;
      this.activateCandidate(override);
      logWarn(TAG, `🚨 EMERGENCY MODE: using ${override.model} (${override.provider}) — bypassing fallback chain`);
    } else {
      this.emergencyOverride = null;
      this.activateCandidate(this.primaryCandidate);
      logInfo(TAG, `Emergency mode cleared — restored ${this.primaryCandidate.model} (${this.primaryCandidate.provider})`);
    }
  }

  /** True if emergency (hailMary) mode is active. */
  get isEmergencyMode(): boolean { return this.emergencyOverride !== null; }

  private primaryCandidate: { provider: string; model: string; endpoint: string; apiKey?: string; maxContext: number };

  constructor(config: DirectApiConfig, policy?: FallbackPolicy) {
    this.config = config;
    this.activeProvider = config.provider ?? "unknown";
    this.activeEndpoint = config.endpoint;
    this.activeApiKey = config.apiKey;
    this.activeModel = config.model;
    this._activeMaxContext = config.maxContext;
    this.useProviderLib = config.useProviderLib ?? false;
    this.policy = policy ?? null;
    this.primaryCandidate = {
      provider: this.activeProvider,
      model: this.activeModel,
      endpoint: this.activeEndpoint,
      apiKey: this.activeApiKey,
      maxContext: this._activeMaxContext,
    };
  }

  private activateCandidate(candidate: { provider: string; model: string; endpoint: string; apiKey?: string; maxContext: number }): void {
    this.activeProvider = candidate.provider;
    this.activeModel = candidate.model;
    this.activeEndpoint = candidate.endpoint;
    this.activeApiKey = candidate.apiKey;
    this._activeMaxContext = candidate.maxContext;
  }

  async initialize(): Promise<void> {
    const count = this.policy ? this.policy.candidates.length : (this.config.fallbacks?.length ?? 0) + 1;
    const fb = count > 1 ? ` (+${count - 1} fallback${count > 2 ? "s" : ""})` : "";
    // #1318: include [pi-ai] tag when the L1 provider engine is the active route.
    logInfo(TAG, `🔌 Direct API transport (${this.config.endpoint}, model: ${this.config.model}${fb}${this.useProviderLib ? " [pi-ai]" : ""})`);
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async sendPrompt(
    sessionKey: string,
    message: string,
    image?: { mime: string; base64: string },
    context?: PromptRequestContext,
  ): Promise<string> {
    const session = this.getOrCreateSession(sessionKey);
    this._activeSessionKey = sessionKey;
    this._activeUserId = context?.userId || "master";
    // #1338: call-local observer for live TUI output mirroring. Invoked
    // alongside transport-wide callbacks; never changes execution/results.
    this._outputObserver = context?.outputObserver;
    this.executionTelemetry = context?.executionTelemetry;

    // If context orchestrator is active, rebuild messages from DB.
    // #1329: when the pipeline hands us the just-inserted current message
    // ID, pass it as the exclusive upper bound so the augmented current
    // turn is appended exactly once (the raw current row in the DB is
    // excluded from the historical snapshot). When absent, behavior
    // matches the pre-fix full-snapshot path.
    if (this.contextOrchestrator) {
      try {
        const ctx = await this.contextOrchestrator.getContext(
          sessionKey,
          this.config.maxContext,
          { beforeMessageId: context?.beforeMessageId },
        );
        // Replace session messages with DB-backed context + system prompt
        session.messages = [
          { role: "system" as const, content: this.systemPrompt },
          ...ctx.messages.map((m: { role: string; content: string }) => ({ role: m.role as "user" | "assistant" | "tool", content: m.content })),
        ];
        if (ctx.compacted) logDebug(TAG, `Context compacted for ${sessionKey}`);
      } catch (err) {
        logWarn(TAG, `Context engine failed, falling back to in-memory: ${err}`);
      }
    }

    // #1335: assign a logical turn ID
    session.currentTurnId = `${Date.now()}-${sessionKey}`;

    // #1335: when structured current turn is available, inject volatile blocks
    // separately and use raw text as the single real user message.
    if (context?.directContextTurn) {
      const { rawUserText, volatileBlocks } = context.directContextTurn;
      // Inject volatile context blocks immediately before the current user turn
      for (const block of volatileBlocks) {
        session.messages.push({ role: "system", content: block.content });
      }
      session.addUser(rawUserText, image);
    } else {
      session.addUser(message, image);
    }

    // #1335: record turn boundary (will get assistant message ID later)
    const userMsgIndex = session.messages.length - 1;
    if (session.currentTurnId) {
      session.turnBoundaries.push({
        turnId: session.currentTurnId,
        userMessageId: context?.beforeMessageId ?? userMsgIndex,
        disposition: "orphaned",
      });
    }

    this._lastAnswer = "";
    this._toolCallsSucceeded = 0;
    this._intermediateText = "";
    this._lastCacheRead = null;
    this._lastCacheWrite = null;
    this._lastTurnUsage = null;
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
      // #832: metrics
      import("../metrics-collector.js").then(({ recordLatency, recordCall }) => {
        recordLatency(`llm:${this.activeModel}`, durationMs);
        recordCall(`llm:${this.activeModel}`, this._lastAnswer.length > 0);
      }).catch(() => {});
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
    // #1444: record emergency fallback transition for telemetry
    if (this.activeModel !== em.model) {
      this._fallbackFrom = this.activeModel;
    }
    this.activeEndpoint = em.endpoint;
    this.activeApiKey = em.apiKey;
    this.activeModel = em.model;
    this._activeMaxContext = em.maxContext;
    this._lastActivityAt = Date.now();
    logWarn(TAG, `🚨 Emergency mode: using ${em.model}`);
    const promptBudget: PromptToolBudget = {
      maxRounds: this._maxToolRoundsOverride ?? this.config.maxToolRounds ?? 25,
      roundsUsed: 0,
    };
    const loopPolicy: AgentLoopPolicy = {
      candidateKey: candidateKey(em.model, em.endpoint),
      candidateRoundLimit: promptBudget.maxRounds,
      promptBudget,
    };
    const result = await this.agentLoop(session, signal, loopPolicy);
    this._lastAnswer = result;
    return result;
  }

  private async sendWithPolicy(session: ConversationSession, signal: AbortSignal): Promise<string> {
    const policy = this.policy!;
    const failedAttempts: Array<{ model: string; kind: string; bucket: number }> = [];
    const isPrimary = (m: string): boolean => m === this.config.model;
    const effectiveMaxToolRounds = this._maxToolRoundsOverride ?? this.config.maxToolRounds ?? 25;
    const maxFallbackRounds = this.config.maxFallbackToolRounds ?? 5;

    // #1386: Create one prompt-wide budget shared across all candidates
    const promptBudget: PromptToolBudget = {
      maxRounds: effectiveMaxToolRounds,
      roundsUsed: 0,
    };

    // Try each candidate via policy
    let candidate = policy.selectModel(this._lastPromptTokens);
    while (candidate) {
      // #1444: record fallback transition for telemetry
      if (this.activeModel !== candidate.model) {
        this._fallbackFrom = this.activeModel;
      }
      this.activateCandidate({ provider: candidate.provider ?? this.config.provider ?? "unknown", model: candidate.model, endpoint: candidate.endpoint, apiKey: candidate.apiKey, maxContext: candidate.maxContext });
      this._lastActivityAt = Date.now();

      if (!isPrimary(candidate.model) && this.onFallback) {
        const ctxPct = candidate.maxContext > 0 ? Math.round((this._lastPromptTokens / candidate.maxContext) * 100) : -1;
        const lastFail = failedAttempts[failedAttempts.length - 1];
        this.onFallback(candidate.model, ctxPct, lastFail?.kind);
      }

      // #1386: Determine candidate round limit
      const isPrimaryCandidate = isPrimary(candidate.model);
      const candidateRoundLimit = isPrimaryCandidate
        ? effectiveMaxToolRounds
        : Math.min(effectiveMaxToolRounds, maxFallbackRounds);

      const loopPolicy: AgentLoopPolicy = {
        candidateKey: candidateKey(candidate.model, candidate.endpoint),
        candidateRoundLimit,
        promptBudget,
      };

      try {
        const result = await this.agentLoop(session, signal, loopPolicy);
        this._lastAnswer = result;
        if (!result || !result.trim()) {
          policy.recordError(candidate, "empty");
        } else {
          policy.recordSuccess(candidate);
          // #1296: notify the phase-transport layer so it can re-arm the fallback notification
          if (isPrimary(candidate.model) && this.onPrimaryRestored) this.onPrimaryRestored();
          // #1418: record successful Main candidate for specialist fallback. Use the
          // candidate's own provider (may differ from config when serving a fallback)
          // so the complete tuple survives provider switching.
          if (result.trim()) {
            const candidateRecord: CandidateSpec = { model: candidate.model, provider: candidate.provider, endpoint: candidate.endpoint, maxContext: candidate.maxContext };
            this._lastSuccessfulCandidate = candidateRecord;
            this.onLastSuccessfulChanged?.(candidateRecord);
            this.onMainSuccess?.(candidateRecord);
          }
        }
        return result;
      } catch (err) {
        if (signal.aborted) { session.rollbackToLastUser(); throw err; }

        // #1386: Handle tool behavior failure (loop, repeated failures, round limits)
        if (err instanceof ToolBehaviorError) {
          session.rollbackToLastUser();
          policy.recordError(candidate, "weak");
          const emKey = candidateKey(candidate.model, candidate.endpoint);
          policy.excludedKeys.add(emKey);
          const bucket = policy.registry.getBucketLevel(candidate.model, candidate.endpoint);
          failedAttempts.push({ model: candidate.model, kind: `behavior_${err.reason}`, bucket });
          logWarn(TAG, `${candidate.model} behavior failure (${err.reason}, rounds: ${err.roundsUsed}, bucket: ${bucket}%) — ${err.message}`);
          candidate = policy.selectModel(this._lastPromptTokens);
          continue;
        }

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
            const imageLoopPolicy: AgentLoopPolicy = {
              candidateKey: loopPolicy.candidateKey,
              candidateRoundLimit: loopPolicy.candidateRoundLimit,
              promptBudget,
            };
            const result = await this.agentLoop(session, signal, imageLoopPolicy);
            this._lastAnswer = result;
            policy.recordSuccess(candidate);
            if (result.trim()) {
              const candidateRecord: CandidateSpec = { model: candidate.model, provider: candidate.provider, endpoint: candidate.endpoint, maxContext: candidate.maxContext };
              this._lastSuccessfulCandidate = candidateRecord;
              this.onLastSuccessfulChanged?.(candidateRecord);
              this.onMainSuccess?.(candidateRecord);
            }
            return result;
          } catch (retryErr) {
            if (retryErr instanceof ToolBehaviorError) {
              session.rollbackToLastUser();
              policy.recordError(candidate, "weak");
              const emKey = candidateKey(candidate.model, candidate.endpoint);
              policy.excludedKeys.add(emKey);
              const bucket = policy.registry.getBucketLevel(candidate.model, candidate.endpoint);
              failedAttempts.push({ model: candidate.model, kind: `behavior_${retryErr.reason}`, bucket });
              logWarn(TAG, `${candidate.model} behavior failure on retry (${retryErr.reason})`);
              candidate = policy.selectModel(this._lastPromptTokens);
              continue;
            }
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            policy.recordError(candidate, this.classifyTransportError(retryErr, retryMsg).kind);
            session.rollbackToLastUser();
            throw retryErr;
          }
        }
        const { kind, retryAfterMs } = this.classifyTransportError(err, errMsg);
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
      // #1444: record fallback transition for compaction survivor telemetry
      if (this.activeModel !== smallest.model) {
        this._fallbackFrom = this.activeModel;
      }
      session.truncateToFit(smallest.maxContext);
      this.activeEndpoint = smallest.endpoint;
      this.activeApiKey = smallest.apiKey;
      this.activeModel = smallest.model;
      this.activeProvider = smallest.provider;
      this._activeMaxContext = smallest.maxContext;
      if (this.onFallback) {
        this.onFallback(`${smallest.model} (compacted)`, Math.round((session.estimateTokens() / smallest.maxContext) * 100));
      }
      try {
        const compactionRoundLimit = Math.min(effectiveMaxToolRounds, maxFallbackRounds);
        const compactionPolicy: AgentLoopPolicy = {
          candidateKey: candidateKey(smallest.model, smallest.endpoint),
          candidateRoundLimit: compactionRoundLimit,
          promptBudget,
        };
        const result = await this.agentLoop(session, signal, compactionPolicy);
        this._lastAnswer = result;
        if (!result || !result.trim()) policy.recordError(smallest, "empty");
        else policy.recordSuccess(smallest);
        return result;
      } catch (err) {
        if (err instanceof ToolBehaviorError) {
          policy.recordError(smallest, "weak");
          failedAttempts.push({ model: smallest.model, kind: `behavior_${err.reason}`, bucket: policy.registry.getBucketLevel(smallest.model, smallest.endpoint) });
        } else {
          const errMsg2 = err instanceof Error ? err.message : String(err);
          const compactionKind = this.classifyTransportError(err, errMsg2).kind;
          policy.recordError(smallest, compactionKind);
          failedAttempts.push({ model: smallest.model, kind: compactionKind, bucket: policy.registry.getBucketLevel(smallest.model, smallest.endpoint) });
        }
      }
    }

    // #1386: If all candidates exhausted (including behavior failures), return a transport-authored message
    // instead of throwing, so the user gets a bounded response without another model call.
    const summary = failedAttempts.map(a => `  - ${a.model}: ${a.kind} (bucket: ${a.bucket}%)`).join("\n");
    if (policy.lastDecision) {
      logDebug(TAG, `Last decision: ${JSON.stringify(policy.lastDecision)}`);
    }
    logWarn(TAG, `All models exhausted:\n${summary}`);
    const exhaustedMsg = `[SYSTEM] All available models failed to produce a valid response. No more fallbacks remain. Try /model change to pick a different provider, or /model health reset to retry.`;
    session.addAssistant(exhaustedMsg);
    this._lastAnswer = exhaustedMsg;
    return exhaustedMsg;
  }

  private async agentLoop(session: ConversationSession, signal: AbortSignal, loopPolicy?: AgentLoopPolicy): Promise<string> {
    let zeroTokenRetries = 0;
    const loopStart = Date.now();
    const guard = new ToolLoopGuard();
    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      if (signal.aborted) return signal.reason === "timeout" ? "Response timed out." : "Interrupted.";
      if (this.isPaused?.()) return "⏸ Session paused. Use `/session resume` to continue.";

      // #1386: Check prompt-wide budget first
      const promptBudget = loopPolicy?.promptBudget;
      if (promptBudget && promptBudget.roundsUsed >= promptBudget.maxRounds) {
        throw new ToolBehaviorError("prompt_round_limit", promptBudget.roundsUsed);
      }

      // #1386: Check candidate-local budget
      if (loopPolicy && guard.roundsUsed >= loopPolicy.candidateRoundLimit) {
        throw new ToolBehaviorError("candidate_round_limit", guard.roundsUsed);
      }

      // #1386: Also enforce the static circuit breaker as a safety net (matches old behavior)
      if (turn >= (this._maxToolRoundsOverride ?? this.config.maxToolRounds ?? 25)) {
        if (promptBudget) promptBudget.roundsUsed = Math.max(promptBudget.roundsUsed, turn + 1);
        throw new ToolBehaviorError("prompt_round_limit", turn + 1);
      }

      const pendingInstruction = this.getPendingInstruction?.();
      if (pendingInstruction) session.addUser(pendingInstruction);

      // #1444: one provider call per streamCompletion invocation
      const fallbackFrom = this._fallbackFrom;
      this._fallbackFrom = undefined;
      const pcHandle = this.executionTelemetry?.beginProviderCall({
        provider: this.activeProvider,
        model: this.activeModel,
        candidate: this.activeProvider ? `${this.activeProvider}/${this.activeModel}` : this.activeModel,
        fallbackFrom,
        startedAt: Date.now(),
      });
      let streamResult: { content: string | null; toolCalls: ToolCall[]; usage: { prompt_tokens: number; completion_tokens: number } | null };
      try {
        streamResult = await this.streamCompletion(session, signal);
      } catch (streamErr) {
        pcHandle?.end({ result: "failure", endedAt: Date.now() });
        throw streamErr;
      }
      const { content, toolCalls, usage } = streamResult;
      if (usage && usage.prompt_tokens != null) {
        pcHandle?.end({
          result: "success",
          endedAt: Date.now(),
          input: usage.prompt_tokens,
          output: usage.completion_tokens ?? 0,
          cacheRead: this._lastCacheRead ?? undefined,
          cacheWrite: this._lastCacheWrite ?? undefined,
        });
      } else {
        pcHandle?.end({ result: "success", endedAt: Date.now() });
      }

      // #1335: Record cache telemetry after each stream completion
      if (usage) {
        this.recordContextTelemetry(session, usage);
      }

      if (usage) {
        session.updateTokens(usage.prompt_tokens);
        this._contextPercent = this._activeMaxContext > 0
          ? Math.round((usage.prompt_tokens / this._activeMaxContext) * 100)
          : session.contextPercent;
        this._lastPromptTokens = usage.prompt_tokens;
        this._lastCompletionTokens = usage.completion_tokens ?? 0;
        const turn = this._lastTurnUsage ?? { input: 0, output: 0 };
        turn.input += usage.prompt_tokens;
        turn.output += usage.completion_tokens ?? 0;
        if (this._lastCacheRead != null) turn.cacheRead = (turn.cacheRead ?? 0) + this._lastCacheRead;
        if (this._lastCacheWrite != null) turn.cacheWrite = (turn.cacheWrite ?? 0) + this._lastCacheWrite;
        this._lastTurnUsage = turn;
        // #1022: compaction fires only for A/C session types.
        if (isCompactable(this._activeSessionKey)) {
          this.contextOrchestrator?.onApiResponse(this._activeSessionKey, usage.prompt_tokens, this.config.maxContext);
        }
        logTrace(TAG, `${this.activeModel} — ${usage.prompt_tokens}→${usage.completion_tokens ?? 0} tokens, ${Date.now() - (this._lastActivityAt ?? Date.now())}ms`);
        const correlation = pcHandle ? {
          schemaVersion: 2 as const,
          sessionId: this._activeSessionKey,
          executionId: this.executionTelemetry?.executionId ?? "",
          providerCallId: pcHandle.providerCallId,
          ordinal: pcHandle.ordinal,
          provider: this.activeProvider,
          candidate: this.activeProvider ? `${this.activeProvider}/${this.activeModel}` : this.activeModel,
          latencyMs: Date.now() - (this._promptStartedAt ?? Date.now()),
          result: "success" as const,
          fallbackFrom: fallbackFrom ?? undefined,
        } : undefined;
        recordUsage(this.activeModel, usage.prompt_tokens, usage.completion_tokens ?? 0, this.agentLabel,
          { cacheRead: this._lastCacheRead ?? undefined, cacheWrite: this._lastCacheWrite ?? undefined }, correlation);
      }

      if (toolCalls.length > 0) {
        // #1386: increment prompt budget and guard rounds for this tool-calling round
        if (promptBudget) promptBudget.roundsUsed++;

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

        // #1386: Tool call processing with loop guard
        for (let ti = 0; ti < toolCalls.length; ti++) {
          const tc = toolCalls[ti]!;
          if (signal.aborted) {
            // #1003: inject cancelled results for remaining tools — keeps conversation valid
            for (const remaining of toolCalls.slice(ti)) {
              session.addToolResult(remaining.id, remaining.function.name,
                `[SYSTEM] Cancelled — ${remaining.function.name} skipped due to user interrupt`);
            }
            return signal.reason === "timeout" ? "Response timed out." : "Interrupted.";
          }
          this._lastActivityAt = Date.now();

          // #948: drain /wait between batched tool calls
          const mid = this.getPendingInstruction?.();
          if (mid) session.addUser(mid);

          this.onToolCallStart?.(tc.function.name ?? "tool");
          this._outputObserver?.onToolStart?.({ name: tc.function.name ?? "tool" });

          let args: Record<string, string>;
          try { args = JSON.parse(tc.function.arguments); } catch {
            // #1133: Reject malformed args — never execute with broken arguments
            const errMsg = `Tool call rejected: malformed arguments (JSON parse error). Reformat and retry.`;
            logWarn(TAG, `Malformed tool args for ${tc.function.name}: ${tc.function.arguments.slice(0, 80)}`);
            session.addToolResult(tc.id, tc.function.name, JSON.stringify({ error: errMsg }));
            continue;
          }

          // #1386: Loop guard — detect exact-repeat before execution
          try {
            guard.observeCall(tc.function.name, tc.function.arguments);
          } catch (err) {
            if (err instanceof ToolBehaviorError) {
              session.addToolResult(tc.id, tc.function.name, JSON.stringify({ error: `[SYSTEM] ${err.message}. Stop retrying and provide a final text response.` }));
              // Inject cancellation results for remaining batched calls
              for (const remaining of toolCalls.slice(ti + 1)) {
                session.addToolResult(remaining.id, remaining.function.name,
                  JSON.stringify({ error: `[SYSTEM] Cancelled — ${remaining.function.name} skipped due to loop detection` }));
              }
              throw err;
            }
            throw err;
          }

          const result = await executeToolCall(tc.function.name, args, { userId: this._activeUserId, signal, sandboxPolicy: this.sandboxPolicy });
          session.addToolResult(tc.id, tc.function.name, result);

          // #1386: Loop guard — classify outcome and detect repeated failures
          try {
            guard.observeOutcome(tc.function.name, result);
          } catch (err) {
            if (err instanceof ToolBehaviorError) {
              for (const remaining of toolCalls.slice(ti + 1)) {
                session.addToolResult(remaining.id, remaining.function.name,
                  JSON.stringify({ error: `[SYSTEM] Cancelled — ${remaining.function.name} skipped due to consecutive failures` }));
              }
              throw err;
            }
            throw err;
          }

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
      // Budget-aware backoff on 0→0 token response (#732)
      if (!answer && usage && usage.prompt_tokens === 0) {
        const elapsed = Date.now() - loopStart;
        const remaining = (this._timeoutOverrideMs ?? getEnv().modelApiTimeoutMs) - elapsed;
        const retryDelay = 5000 + (zeroTokenRetries * 3000);
        if (remaining > retryDelay + 5000) {
          zeroTokenRetries++;
          logWarn(TAG, `API returned 0 tokens — retry #${zeroTokenRetries} after ${retryDelay / 1000}s (${Math.round(remaining / 1000)}s left)`);
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
      }
      session.addAssistant(answer);
      // #1335: complete the current turn boundary. The durable assistant
      // transcript ID is assigned by abmind when the final response is
      // persisted (#1406 wires it); do NOT store a token count as a message
      // ID (#1335 finding #5). Mark the turn complete by disposition only.
      if (session.currentTurnId) {
        const lastBoundary = session.turnBoundaries[session.turnBoundaries.length - 1];
        if (lastBoundary && lastBoundary.turnId === session.currentTurnId) {
          lastBoundary.disposition = "complete";
        }
        session.currentTurnId = null;
      }
      // #1335: record atomic growth and trigger background compaction if needed
      if (usage) {
        session.recordAtomicGrowth(usage.prompt_tokens);
        if (this.checkpointEngine && isCompactable(this._activeSessionKey)) {
          this.maybeCompactBackground(this._activeSessionKey, session);
        }
      }
      return answer;
    }

    logWarn(TAG, `Max turns (${this.config.maxTurns}) reached`);
    const last = session.messages.at(-1)?.content;
    return (typeof last === "string" ? last : null) ?? "(max turns reached)";
  }

  /** #1335: Fire background compaction if headroom requires it.
   *  NOTE: the durable abmind transcript IDs that the checkpoint store keys on
   *  are supplied by #1406's production wiring. This path stays dormant until
   *  `checkpointEngine` is assigned. */
  private async maybeCompactBackground(sessionKey: string, session: ConversationSession): Promise<void> {
    if (!this.checkpointEngine) return;
    try {
      // Build raw messages list from the session (excluding system/volatile).
      // Durable abmind message IDs are threaded here once #1406 wires the
      // engine; until then this path does not execute.
      const rawMessages = session.messages
        .filter(m => m.role !== "system")
        .map((m, i) => ({
          id: i,
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }));

      // #1335 finding #2: measure the actual stable-context size (checkpoint +
      // verbatim suffix) rather than the budget, so compaction is requested
      // only when the real prefix plus growth reserve overflows the budget.
      const stableContextTokens = Math.ceil(rawMessages.reduce(
        (s, m) => s + estimateTokensFromChars(m.content.length), 0,
      ));

      const reserve = calculateReserve({
        contextWindow: this._activeMaxContext,
        configuredMaxOutput: this.config.maxOutput,
        clampedMaxOutput: this.config.maxOutput,
        safetyMargin: 4096,
        stableSystemTokens: estimateTokensFromChars(this.systemPrompt.length),
        toolSchemaTokens: 2000,
        volatileContextTokens: 500,
        currentTurnTokens: 100,
        inFlightTokens: 0,
        stableContextTokens,
        recentAtomicGrowthTokens: session.recentAtomicGrowth,
      });
      if (!reserve.compactionDue) return;

      await this.checkpointEngine.maybeCompact(sessionKey, rawMessages, {
        maxHistoryTokens: reserve.historyBudget,
        minRecentTokens: Math.max(2000, Math.floor(reserve.historyBudget * 0.15)),
        reason: "headroom",
        activeModel: this.activeModel,
      });
      logDebug(TAG, `Background compaction completed for ${sessionKey}`);
    } catch (err) {
      logWarn(TAG, `Background compaction failed for ${sessionKey}: ${err}`);
    }
  }

  /** #1335: Record context cache telemetry for the baseline and A/B gate. */
  private recordContextTelemetry(session: ConversationSession, usage: { prompt_tokens: number; completion_tokens: number }): void {
    // Compute stable prefix digest from system + all messages except the current turn
    const prefixMessages = session.messages.slice(0, -1); // exclude just-appended user/assistant
    const prefixStr = prefixMessages.map(m => `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n");
    const stablePrefixTokens = Math.ceil(prefixStr.length / 4);
    const digest = stableHash(prefixStr);
    const priorDigest = this._priorStablePrefixDigest;
    const priorTokens = this._priorStablePrefixTokens;

    // #1335 finding #6: per-message digests of the current prefix, compared
    // against the allowlisted prior sequence to find the first changed message.
    // The old code compared each prefix message against itself, so a changed
    // prefix never produced a meaningful index.
    const currentMessageDigests = prefixMessages.map(m =>
      stableHash(`${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`),
    );
    const firstChangedIndex = priorDigest && digest !== priorDigest
      ? firstChangedMessageIndex(currentMessageDigests, this._priorStablePrefixMessageDigests)
      : undefined;

    recordCacheTelemetry({
      version: 1,
      sessionHash: sessionHash(this._activeSessionKey),
      logicalTurnId: `${Date.now()}-${this._activeSessionKey}`,
      candidateKeyHash: candidateKeyHash(this.activeEndpoint, this.activeModel),
      contextWindow: this._activeMaxContext,
      reservedOutput: this.config.maxOutput,
      safetyMargin: 4096,
      estimatedInput: usage.prompt_tokens,
      measuredInput: usage.prompt_tokens,
      cacheRead: this._lastCacheRead ?? undefined,
      cacheWrite: this._lastCacheWrite ?? undefined,
      stablePrefixTokens,
      stablePrefixDigest: digest,
      priorCommonPrefixTokens: priorTokens > 0 ? priorTokens : undefined,
      firstChangedMessageIndex: firstChangedIndex,
      latencyMs: Date.now() - (this._promptStartedAt ?? Date.now()),
      rendererVersion: "abm-l-v2-baseline",
    });

    this._priorStablePrefixDigest = digest;
    this._priorStablePrefixTokens = stablePrefixTokens;
    this._priorStablePrefixMessageDigests = currentMessageDigests;
  }

  private parseErrorStatus(err: unknown): number { return parseErrorStatus(err); }

  /** Extract Retry-After from error (seconds or date). Returns ms or undefined. */
  private parseRetryAfter(err: unknown): number | undefined { return parseRetryAfter(err); }

  /**
   * #1425 — Classify a transport error for L2 health/rotation.
   *
   * The pi-ai adapter tags errors it raises with `piKind`/`piRetryAfterMs`
   * ("pi classifies, abtars decides"). We honor the `context_exceeded` tag — the
   * one kind `classifyError(status)` is structurally unable to express, since an
   * HTTP 400 context-overflow maps to `transient` there. Without honoring it, a
   * healthy model's bucket would be filled for our own oversized request.
   *
   * For every other kind, `classifyError(status)` already reproduces the
   * adapter's intent AND encodes abtars-specific policy the adapter's coarse
   * mapping doesn't know about (e.g. the sticky `credits` bucket on 402, and
   * auth demotion on 401/403). So the status-based classification stays
   * authoritative there; only `context_exceeded` is taken from the tag.
   * `piRetryAfterMs` is always honored when present (it is the same value the
   * text-based parse would yield). The L0 reptile-floor path raises plain Errors
   * with no tags, so it falls through unchanged.
   */
  private classifyTransportError(err: unknown, errMsg: string): { kind: ErrorKind; retryAfterMs?: number } {
    const tagged = err as Error & { piKind?: ErrorKind; piRetryAfterMs?: number };
    const status = this.parseErrorStatus(err);
    const kind: ErrorKind = tagged?.piKind === "context_exceeded" ? "context_exceeded" : classifyError(status, errMsg);
    const retryAfterMs = tagged?.piRetryAfterMs ?? this.parseRetryAfter(err) ?? parseUsageLimitCooldown(errMsg);
    return { kind, retryAfterMs };
  }

  private async streamCompletion(
    session: ConversationSession,
    signal: AbortSignal,
  ): Promise<{ content: string | null; toolCalls: ToolCall[]; usage: { prompt_tokens: number; completion_tokens: number } | null }> {
    // Compose pipeline signal (user /stop) with per-request timeout (silence-based)
    const timeoutCtrl = new AbortController();
    const timeoutMs = this._timeoutOverrideMs ?? getEnv().modelApiTimeoutMs;
    this._lastActivityAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - (this._lastActivityAt ?? 0) > timeoutMs) {
        clearInterval(timer);
        timeoutCtrl.abort(new Error("model API timeout"));
      }
    }, 5000);
    const composed = AbortSignal.any([signal, timeoutCtrl.signal]);

    try {
    // #1326: clamp maxOutput so input + output fits the model's context window.
    // Computed ONCE per request — do not re-serialize messages/tools at each
    // body builder. `_activeMaxContext` reflects the actual serving model
    // (updated by L2 fallback / setEmergencyMode), so the clamp targets the
    // model that's actually running, not the original config's primary model.
    const _toolSchemas = getToolSchemas(this.sandboxPolicy);
    const estimatedInputTokens = estimateTokensFromChars(
      JSON.stringify(session.messages).length + JSON.stringify(_toolSchemas).length,
    );
    const clampedMaxOutput = clampMaxOutputTokens(this.config.maxOutput, this._activeMaxContext, estimatedInputTokens);

    // #1311 — L1: pi-ai provider engine. Flag on + non-emergency only.
    // Load failure (pi absent/broken) → fall through to the L0 reptile floor.
    // Request failure → propagate to L2 (sendWithPolicy) for rotation, unchanged.
    if (this.useProviderLib && !this.emergencyOverride) {
      try {
        return await this.consumePiAi(session, composed, clampedMaxOutput);
      } catch (err) {
        if (err instanceof Error && err.name === "PiAiUnavailableError") {
          // #1318: include the throwing function name from the adapter (if it tagged the error).
          const fn = (err as Error & { piFunction?: string }).piFunction;
          logWarn(TAG, `pi-ai unavailable — using L0 reptile floor: ${err.message}${fn ? ` [from ${fn}]` : ""}`);
          // fall through to L0 branches below
        } else {
          throw err;
        }
      }
    }

    // Responses API format (#465, streaming #472)
    if (this.config.apiFormat === "responses") {
      const { toResponsesRequest } = await import("./responses-adapter.js");
      const { parseResponsesSSE } = await import("./sse-parser-responses.js");
      const msgs = session.messages.map(m => ({ role: m.role, content: m.content ?? "" as string | ContentPart[] }));
      const reqBody = { ...toResponsesRequest(this.activeModel, msgs, _toolSchemas, clampedMaxOutput), stream: true };
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
        if (event.type === "chunk") { content += event.content; this._intermediateText += event.content; this.onIntermediateResponse?.(event.content); this._outputObserver?.onDelta?.({ kind: "text", text: event.content }); }
        else if (event.type === "tool_call_delta") { this.accumulateToolCall(toolCallAcc, event); }
        else if (event.type === "done") { usage = event.usage; }
      }
      clearInterval(timer);
      const toolCalls = this.finalizeToolCalls(toolCallAcc);
      return { content: content || null, toolCalls, usage };
    }

    // Anthropic Messages API format (#467, streaming #472)
    if (this.config.apiFormat === "anthropic") {
      const { toAnthropicRequest, buildAnthropicHeaders } = await import("./anthropic-adapter.js");
      const { parseAnthropicSSE } = await import("./sse-parser-anthropic.js");
      const msgs = session.messages.map(m => ({ role: m.role, content: m.content ?? "" as string | ContentPart[], tool_call_id: m.tool_call_id }));
      const reqBody = { ...toAnthropicRequest(this.activeModel, msgs, clampedMaxOutput, _toolSchemas), stream: true };
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
        if (event.type === "chunk") { content += event.content; this._intermediateText += event.content; this.onIntermediateResponse?.(event.content); this._outputObserver?.onDelta?.({ kind: "text", text: event.content }); }
        else if (event.type === "tool_call_delta") { this.accumulateToolCall(toolCallAcc, event); }
        else if (event.type === "done") { usage = event.usage; }
      }
      clearInterval(timer);
      const toolCalls = this.finalizeToolCalls(toolCallAcc);
      return { content: content || null, toolCalls, usage };
    }

    const body: Record<string, unknown> = {
      model: this.activeModel,
      messages: session.messages,
      tools: _toolSchemas,
      max_tokens: clampedMaxOutput,
      stream: true,
      stream_options: { include_usage: true },
    };

    // #466: inject thinking/reasoning parameters
    // #1311 + #1276: "default" style → don't set reasoning_effort (model default).
    if (this.config.thinking) {
      if (this.config.thinking.style === "effort") {
        body.reasoning_effort = this.config.thinking.default;
      } else if (this.config.thinking.style === "extended") {
        body.thinking = { type: "enabled", budget_tokens: this.config.thinking.default };
      }
      // "default" falls through — no reasoning_effort in body → model uses its own default.
    }
    // #869 / #1276: session-level reasoning override (from /effort or /thinking).
    // BUDGET_MAP matches pi-ai's per-level token hints (see pi-ai-adapter.ts EFFORT_LEVELS).
    if (session.reasoningEffort && session.reasoningEffort !== "off") {
      const BUDGET_MAP: Record<string, number> = { low: 1024, medium: 4096, high: 16384, xhigh: 32768 };
      if ((this.config.apiFormat as string) === "anthropic") {
        body.thinking = { type: "enabled", budget_tokens: BUDGET_MAP[session.reasoningEffort] ?? 4096 };
      } else {
        body.reasoning_effort = session.reasoningEffort;
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
          this._outputObserver?.onDelta?.({ kind: "text", text: event.content });
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
      clearInterval(timer);
    }
  }

  /**
   * #1311 — L1 execution: stream one completion through pi-ai, translating events
   * into the same internal contract the L0 branches produce. Throws
   * PiAiUnavailableError on load failure (→ L0 fallback) or Error("API error …")
   * on request failure (→ L2 rotation). See pi-ai-adapter.ts.
   */
  private async consumePiAi(
    session: ConversationSession,
    signal: AbortSignal,
    clampedMaxOutput?: number,
  ): Promise<{ content: string | null; toolCalls: ToolCall[]; usage: { prompt_tokens: number; completion_tokens: number } | null }> {
    const { streamPiAiCompletion } = await import("./pi-ai-adapter.js");
    const candidate = {
      model: this.activeModel,
      endpoint: this.activeEndpoint,
      apiKey: this.activeApiKey,
      apiFormat: this.config.apiFormat,
      maxOutput: clampedMaxOutput ?? this.config.maxOutput,
      contextWindow: this._activeMaxContext,
      thinking: this.config.thinking,
      reasoningEffort: session.reasoningEffort,
      sessionId: this._activeSessionKey,
    };
    const toolSchemas = getToolSchemas(this.sandboxPolicy);
    // #1318: dispatch entry — debug noise at LOG_LEVEL=debug, full candidate detail at trace.
    // #1326: trace the *actual* maxOutput being sent (post-clamp), not the original
    // config value — the clamp may have reduced it from 262144 to a sane number,
    // and a future debugger needs to see what was actually emitted.
    logDebug(TAG, `pi-ai dispatch: model=${this.activeModel} endpoint=${this.activeEndpoint}`);
    logTrace(TAG, `pi-ai candidate: model=${this.activeModel} endpoint=${this.activeEndpoint} apiFormat=${this.config.apiFormat ?? "chat"} maxOutput=${candidate.maxOutput} contextWindow=${candidate.contextWindow ?? 0} reasoningEffort=${session.reasoningEffort ?? "none"} thinking=${JSON.stringify(this.config.thinking)} sessionId=${this._activeSessionKey} msgs=${session.messages.length} tools=${toolSchemas.length}`);
    const events = streamPiAiCompletion(
      candidate,
      { messages: session.messages, tools: toolSchemas },
      signal,
    );

    let content = "";
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
    const toolCallAcc = new Map<string, { id: string; name: string; arguments: string }>();
    for await (const event of events) {
      this._lastActivityAt = Date.now();
      // #1318: per-event trace — TRACE only; this is the flood path. One line per event.
      logTrace(TAG, `pi-ai event: ${event.type}${event.type === "chunk" ? ` +${event.content.length}ch` : event.type === "thinking" ? ` +${event.content.length}ch(think)` : event.type === "tool_call_delta" ? ` tool=${event.name ?? "?"} argsΔ=${(event.arguments ?? "").length}` : event.type === "done" ? ` usage=${JSON.stringify(event.usage)} cacheR=${event.cacheRead ?? 0} cacheW=${event.cacheWrite ?? 0}` : ""}`);
      if (event.type === "chunk") {
        content += event.content;
        this._intermediateText += event.content;
        this.onIntermediateResponse?.(event.content);
        this._outputObserver?.onDelta?.({ kind: "text", text: event.content });
      } else if (event.type === "thinking") {
        // Reasoning streams to the user but is never folded into the final answer.
        this.onIntermediateResponse?.(event.content);
        this._outputObserver?.onDelta?.({ kind: "thinking", text: event.content });
      } else if (event.type === "tool_call_delta") {
        this.accumulateToolCall(toolCallAcc, event);
      } else if (event.type === "done") {
        usage = event.usage;
        this._lastCacheRead = event.cacheRead ?? null;
        this._lastCacheWrite = event.cacheWrite ?? null;
      }
    }
    // #1318: stream-drained trace (terminal) + done debug line.
    logTrace(TAG, `pi-ai stream drained: contentLen=${content.length} toolCalls=${toolCallAcc.size} usage=${JSON.stringify(usage)}`);
    if (usage) logDebug(TAG, `pi-ai done: input=${usage.prompt_tokens} output=${usage.completion_tokens} cacheRead=${this._lastCacheRead ?? 0} cacheWrite=${this._lastCacheWrite ?? 0}`);
    return { content: content || null, toolCalls: this.finalizeToolCalls(toolCallAcc), usage };
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

  async sendInterrupt(reason?: string): Promise<void> {
    for (const ac of this.abortControllers.values()) ac.abort(reason ?? "user");
  }

  destroy(): void {
    for (const ac of this.abortControllers.values()) ac.abort();
    this.sessions.clear();
    this.abortControllers.clear();
  }

  get isReady(): boolean { return true; }
  get contextPercent(): number { return this._contextPercent; }
  get answerOnly(): string { return this._lastAnswer; }
  getActiveSession(): ConversationSession | null { return this.sessions.get(this._activeSessionKey) ?? null; }
  get toolCallsSucceeded(): number { return this._toolCallsSucceeded; }

  lastUsage(): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
    if (!this._lastPromptTokens && !this._lastCompletionTokens) return null;
    const out: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = {
      input: this._lastPromptTokens, output: this._lastCompletionTokens,
    };
    if (this._lastCacheRead != null) out.cacheRead = this._lastCacheRead;
    if (this._lastCacheWrite != null) out.cacheWrite = this._lastCacheWrite;
    return out;
  }

  getRuntimeStatus(): RuntimeStatusSnapshot {
    const session = this.sessions.get(this._activeSessionKey);
    return {
      route: this.config.route,
      provider: this.activeProvider,
      model: this.activeModel,
      contextPercent: this._contextPercent >= 0 ? this._contextPercent : undefined,
      contextWindow: this._activeMaxContext > 0 ? this._activeMaxContext : undefined,
      autoCompaction: !!this.contextOrchestrator,
      reasoning: session?.reasoningEffort && session.reasoningEffort !== "off" ? session.reasoningEffort : "off",
      lastTurnUsage: this._lastTurnUsage ? { ...this._lastTurnUsage } : undefined,
    };
  }

  /** Hot-swap the active model. Takes effect on next API call. */
  setModel(model: string): void {
    this.activeModel = model;
    this.primaryCandidate.model = model;
    (this.config as { model: string }).model = model;
    logInfo(TAG, `Model switched (user): ${model}`);
  }

  /** Hot-swap provider+model+policy. Rejects if prompt is in flight. #1418: also
   *  accepts the provider name so the complete candidate tuple is preserved. */
  switchProvider(opts: { provider?: string; endpoint: string; apiKey?: string; model: string; maxContext: number; policy: FallbackPolicy }): void {
    if (this._promptStartedAt !== null) {
      throw new Error("Cannot switch provider while a prompt is in progress — try after the response");
    }
    const provider = opts.provider ?? this.config.provider ?? "unknown";
    this.activateCandidate({ provider, model: opts.model, endpoint: opts.endpoint, apiKey: opts.apiKey, maxContext: opts.maxContext });
    (this.config as { model: string; maxContext: number }).model = opts.model;
    (this.config as { maxContext: number }).maxContext = opts.maxContext;
    if (opts.provider) (this.config as { provider?: string }).provider = opts.provider;
    this.primaryCandidate = { provider, model: opts.model, endpoint: opts.endpoint, apiKey: opts.apiKey, maxContext: opts.maxContext };
    this._lastSuccessfulCandidate = null;
    this.policy = opts.policy;
    logInfo(TAG, `Provider switched: ${opts.model} @ ${opts.endpoint} via ${provider} (maxCtx=${opts.maxContext})`);
  }

  /** Get current active model name. */
  getModel(): string { return this.activeModel; }
  get intermediateDeliveredText(): string { return this._intermediateText; }
  get transportCommands(): string[] { return []; }

  // Watchdog support
  get promptStartedAt(): number | null { return this._promptStartedAt; }
  setTimeoutOverride(ms: number | null): void { this._timeoutOverrideMs = ms; }
  setMaxToolRoundsOverride(n: number | null): void { this._maxToolRoundsOverride = n; }

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
