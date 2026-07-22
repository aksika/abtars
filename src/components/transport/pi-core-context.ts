import { logWarn, logError, logDebug } from "../logger.js";
import type { AssistantMessage, ModelApi, PiExecutionContextSeed, AgentMessage, AbtarsCurrentTurnMessage } from "./pi-core-types.js";

const TAG = "pi-core-context";

export interface TransformOptions {
  signal?: AbortSignal;
  hostGeneration?: number;
  candidateKeyFn?: () => string;
  candidateModelFn?: (candidateKey: string) => ModelApi | undefined;
  orchestrator?: {
    getContext(sessionKey: string, maxContext: number, opts: { beforeMessageId?: number }): Promise<{
      messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string; is_error?: boolean }>;
      compacted?: boolean;
    }>;
  };
}

export interface TransformResult {
  messages: AgentMessage[];
  contextDegraded: boolean;
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

        if (!options.orchestrator) {
          logWarn(TAG, "Durable mode requested but no orchestrator — returning degraded suffix");
          durableMessages = [];
          contextDegraded = true;
        } else {
          const projected = await this.projectDurable(options);
          durableMessages = projected.messages;
          contextDegraded = projected.degraded;
        }

        if (options.signal?.aborted) return this.fallback(agentMessages);
        if (generation !== this.instanceGeneration) return this.fallback(agentMessages);
      }

      const result: AgentMessage[] = [...durableMessages, ...suffix];

      if (generation === this.instanceGeneration) {
        this.lastSafeBaseline = result;
      }

      const marker = agentMessages[markerIndex] as unknown as AbtarsCurrentTurnMessage;
      logDebug(TAG, `Transform complete: ${durableMessages.length} durable + ${suffix.length} suffix (marker: ${marker.executionId})`);

      return { messages: result, contextDegraded };
    } catch (err) {
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

  private async projectDurable(options: TransformOptions): Promise<{ messages: AgentMessage[]; degraded: boolean }> {
    const source = this.seed.source;
    if (source.mode !== "durable") return { messages: [], degraded: false };

    try {
      const orch = options.orchestrator as NonNullable<typeof options.orchestrator>;
      const ctx = await orch.getContext(
        source.sessionKey,
        source.maxContext,
        { beforeMessageId: source.beforeMessageId },
      );

      const rows = ctx.messages ?? [];

      const messages = rows.map((row): AgentMessage => {
        const role = String(row.role ?? "user");
        const content = String(row.content ?? "");
        const toolCallId = row.tool_call_id ? String(row.tool_call_id) : undefined;
        const toolName = row.name ? String(row.name) : undefined;

        if (role === "tool") {
          if (toolCallId && toolName) {
            // Valid tool result: preserve as toolResult for Pi
            return {
              role: "toolResult",
              toolCallId,
              toolName,
              content: [{ type: "text", text: content }],
              isError: Boolean(row.is_error),
              timestamp: Date.now(),
            };
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
      return { messages, degraded: false };
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : "unknown";
      logWarn(TAG, `Abmind projection failed (${errorClass}) for ${this.seed.executionId}`);
      return { messages: [], degraded: true };
    }
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
