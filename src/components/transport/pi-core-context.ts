import { createHash } from "node:crypto";
import { logWarn, logError, logDebug } from "../logger.js";
import type { AssistantMessage, ModelApi, PiExecutionContextSeed, AgentMessage, AbtarsCurrentTurnMessage } from "./pi-core-types.js";
import type { DurableContextProjectionInput, DurableContextProjectionResult } from "../memory-runtime.js";

const TAG = "pi-core-context";

/**
 * #1527: read-only durable context provider. Replaces the misleading
 * orchestrator-shaped contract, which implied compaction maintenance that
 * this read path never performed.
 */
export interface PiDurableContextProvider {
  projectContext(input: DurableContextProjectionInput): Promise<DurableContextProjectionResult>;
}

export type DurableContextUnavailableReason =
  | "no_provider"
  | "provider_rejected"
  | "malformed_response";

/** #1527: durable projection failures are execution errors, never degraded success. */
export class DurableContextUnavailableError extends Error {
  readonly reason: DurableContextUnavailableReason;
  constructor(reason: DurableContextUnavailableReason, cause?: unknown) {
    super(`Durable context unavailable: ${reason}`, { cause });
    this.name = "DurableContextUnavailableError";
    this.reason = reason;
  }
}

/**
 * Late-bound shared provider reference. Transport construction and memory
 * negotiation boot in parallel, so the transport captures the holder and the
 * composition point (pipelineDeps) populates it once memory is ready.
 */
export interface DurableContextProviderHolder {
  current: PiDurableContextProvider | null;
}

export function createDurableContextProvider(
  runtime: import("../memory-runtime.js").AbtarsMemoryRuntime,
): PiDurableContextProvider {
  return {
    projectContext: (input: DurableContextProjectionInput) => runtime.projectDurableContext(input),
  };
}

export interface TransformOptions {
  signal?: AbortSignal;
  hostGeneration?: number;
  candidateKeyFn?: () => string;
  candidateModelFn?: (candidateKey: string) => ModelApi | undefined;
  contextProvider?: PiDurableContextProvider;
}

export interface TransformResult {
  messages: AgentMessage[];
  contextDegraded: boolean;
}

/** Bounded, content-free session fingerprint for diagnostics. */
function sessionFingerprint(sessionKey: string): string {
  return createHash("sha256").update(sessionKey, "utf-8").digest("hex").slice(0, 12);
}

export class PiCoreContextProjection {
  readonly seed: PiExecutionContextSeed;
  readonly systemPrompt: string;
  private lastSafeBaseline: AgentMessage[] | null = null;
  private instanceGeneration = 0;

  constructor(seed: PiExecutionContextSeed, systemPrompt: string) {
    this.seed = seed;
    this.systemPrompt = systemPrompt;
  }

  get safeBaseline(): readonly AgentMessage[] | null {
    return this.lastSafeBaseline;
  }

  async transform(
    agentMessages: AgentMessage[],
    options: TransformOptions,
  ): Promise<TransformResult> {
    if (options.signal?.aborted) {
      return this.fallback(agentMessages);
    }

    const generation = ++this.instanceGeneration;

    try {
      const { markers, markerIndex } = this.locateCurrentTurnMarker(agentMessages);
      if (markers === 0) {
        logError(TAG, `No current-turn marker found for execution ${this.seed.executionId}`);
        return this.fallback(agentMessages);
      }
      if (markers > 1) {
        logError(TAG, `${markers} current-turn markers found for execution ${this.seed.executionId}`);
        return this.fallback(agentMessages);
      }

      const suffix = agentMessages.slice(markerIndex);
      let durableMessages: AgentMessage[] = [];
      let contextDegraded = false;

      if (this.seed.source.mode === "durable") {
        if (options.signal?.aborted) return this.fallback(agentMessages);
        if (generation !== this.instanceGeneration) return this.fallback(agentMessages);

        const provider = options.contextProvider;
        if (!provider) {
          // #1527 fail-closed: durable mode without a ready provider is an
          // execution error, never a plausible suffix-only answer.
          logWarn(TAG, "context_projection_failed mode=durable reason=no_provider");
          throw new DurableContextUnavailableError("no_provider");
        }

        try {
          const projected = await this.projectDurable(provider);
          durableMessages = projected.messages;
        } catch (err) {
          // #1527: cancellation of an in-flight provider call retains the
          // non-provider fallback semantics (it starts no new provider call).
          if (options.signal?.aborted) return this.fallback(agentMessages);
          if (err instanceof DurableContextUnavailableError) {
            logWarn(TAG, `context_projection_failed mode=durable reason=${err.reason}`);
            throw err;
          }
          logWarn(TAG, "context_projection_failed mode=durable reason=provider_rejected");
          throw new DurableContextUnavailableError("provider_rejected", err);
        }

        if (options.signal?.aborted) return this.fallback(agentMessages);
        if (generation !== this.instanceGeneration) return this.fallback(agentMessages);
      }

      const result: AgentMessage[] = [...durableMessages, ...suffix];

      if (generation === this.instanceGeneration) {
        this.lastSafeBaseline = result;
      }

      const mode = this.seed.source.mode;
      logDebug(TAG, `context_projection session=${sessionFingerprint(this.seed.source.sessionKey)} mode=${mode} source=${durableMessages.length} suffix=${suffix.length}`);

      return { messages: result, contextDegraded };
    } catch (err) {
      if (err instanceof DurableContextUnavailableError) throw err;
      logWarn(TAG, `Context projection failed for ${this.seed.executionId}: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback(agentMessages);
    }
  }

  private locateCurrentTurnMarker(messages: AgentMessage[]): { markers: number; markerIndex: number } {
    let markerIndex = -1;
    let markers = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === "abtars_current_turn") {
        const marker = m as unknown as AbtarsCurrentTurnMessage;
        if (marker.executionId === this.seed.executionId) {
          markers++;
          if (markerIndex < 0) markerIndex = i;
        }
      }
    }
    return { markers, markerIndex };
  }

  private async projectDurable(provider: PiDurableContextProvider): Promise<{ messages: AgentMessage[] }> {
    const source = this.seed.source;
    if (source.mode !== "durable") return { messages: [] };

    const ctx = await provider.projectContext({
      userId: source.userId,
      sessionId: source.sessionKey,
      beforeMessageId: source.beforeMessageId,
      maxContext: source.maxContext,
    });

    if (!ctx || typeof ctx !== "object" || !Array.isArray(ctx.messages)) {
      throw new DurableContextUnavailableError("malformed_response");
    }

    const messages = (ctx.messages ?? []).map((row): AgentMessage => {
      const r = row as { role?: unknown; content?: unknown; tool_call_id?: unknown; name?: unknown; is_error?: unknown };
      const role = typeof r.role === "string" ? r.role : "user";
      const content = typeof r.content === "string" ? r.content : "";
      const toolCallId = typeof r.tool_call_id === "string" ? r.tool_call_id : undefined;
      const toolName = typeof r.name === "string" ? r.name : undefined;

      if (role === "tool") {
        if (toolCallId && toolName) {
          // Valid tool result: preserve as toolResult for Pi
          return {
            role: "toolResult",
            toolCallId,
            toolName,
            content: [{ type: "text", text: content }],
            isError: r.is_error === true,
            timestamp: Date.now(),
          } as AgentMessage;
        }
        // Historical tool row without valid call ID: render as context text
        return { role: "user", content: `[Historical tool output]: ${content.slice(0, 500)}`, timestamp: Date.now() } as AgentMessage;
      }

      if (role === "assistant") {
        return {
          role: "assistant",
          content: content ? [{ type: "text", text: content }] : [],
          api: "openai-completions",
          provider: "abmind",
          model: "historical",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } satisfies AssistantMessage;
      }
      if (role === "user") return { role: "user", content, timestamp: Date.now() };
      return { role: "user", content: `[Historical ${role} context]: ${content.slice(0, 500)}`, timestamp: Date.now() };
    });

    return { messages };
  }

  private fallback(agentMessages: AgentMessage[]): TransformResult {
    if (this.lastSafeBaseline) {
      // Retain the clean durable prefix, but keep the current call's marker
      // and in-flight suffix when a stale projection completes.
      const { markerIndex } = this.locateCurrentTurnMarker(agentMessages);
      const baselineMarkerIndex = this.lastSafeBaseline.findIndex(
        (message) => message.role === "abtars_current_turn"
          && (message as unknown as AbtarsCurrentTurnMessage).executionId === this.seed.executionId,
      );
      if (markerIndex >= 0 && baselineMarkerIndex >= 0) {
        return {
          messages: [
            ...this.lastSafeBaseline.slice(0, baselineMarkerIndex),
            ...agentMessages.slice(markerIndex),
          ],
          contextDegraded: true,
        };
      }
      return { messages: [...this.lastSafeBaseline], contextDegraded: true };
    }
    // Preserve the in-flight suffix: find the marker and take everything from it onward
    const { markerIndex } = this.locateCurrentTurnMarker(agentMessages);
    if (markerIndex >= 0) {
      const suffix = agentMessages.slice(markerIndex);
      return { messages: suffix, contextDegraded: true };
    }
    // No marker: use seed current turn content
    const marker = this.seed.currentTurn;
    const fallback: AgentMessage[] = [
      { role: "user", content: typeof marker.content === "string" ? marker.content : marker.content, timestamp: marker.timestamp },
    ];
    return { messages: fallback, contextDegraded: true };
  }

  buildSystemPromptFromSeed(): string {
    const parts: string[] = [this.systemPrompt];
    for (const block of this.seed.volatileBlocks) {
      if (block.content) {
        const kind = block.kind.replaceAll('"', "'");
        parts.push(`[${block.kind}]\n<volatile_context kind="${kind}">\n${block.content}\n</volatile_context>`);
      }
    }
    return parts.join("\n\n");
  }
}
