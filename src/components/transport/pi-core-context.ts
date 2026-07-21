import { logWarn, logError, logDebug } from "../logger.js";
import type { PiExecutionContextSeed, AgentMessage, AbtarsCurrentTurnMessage } from "./pi-core-types.js";

const TAG = "pi-core-context";

export interface TransformOptions {
  signal?: AbortSignal;
  hostGeneration?: number;
  candidateKeyFn?: () => string;
  orchestrator?: {
    getContext(sessionKey: string, maxContext: number, opts: { beforeMessageId?: number }): Promise<{
      messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }>;
      compacted?: boolean;
    }>;
  };
}

export interface TransformResult {
  messages: AgentMessage[];
  contextDegraded: boolean;
}

const MAX_CONTEXT_ROWS = 200;

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
      return { messages: this.lastSafeBaseline ?? agentMessages, contextDegraded: true };
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
        if (options.signal?.aborted) return { messages: this.lastSafeBaseline ?? suffix, contextDegraded: true };

        if (!options.orchestrator) {
          logWarn(TAG, "Durable mode requested but no orchestrator — returning degraded suffix");
          durableMessages = [];
          contextDegraded = true;
        } else {
          durableMessages = await this.projectDurable(options);
        }

        if (options.signal?.aborted) return { messages: this.lastSafeBaseline ?? suffix, contextDegraded: true };
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

  private async projectDurable(options: TransformOptions): Promise<AgentMessage[]> {
    const source = this.seed.source;
    if (source.mode !== "durable") return [];

    try {
      const orch = options.orchestrator as NonNullable<typeof options.orchestrator>;
      const ctx = await orch.getContext(
        source.sessionKey,
        source.maxContext,
        { beforeMessageId: source.beforeMessageId },
      );

      const rows = (ctx.messages ?? []).slice(-MAX_CONTEXT_ROWS);

      return rows.map((row) => {
        const role = String(row.role ?? "user");
        const content = String(row.content ?? "");
        const toolCallId = row.tool_call_id ? String(row.tool_call_id) : undefined;
        const toolName = row.name ? String(row.name) : undefined;

        if (role === "tool") {
          if (toolCallId && toolName) {
            // Valid tool result: preserve as toolResult for Pi
            return {
              role: "toolResult",
              content,
              tool_call_id: toolCallId,
              name: toolName,
              timestamp: Date.now(),
            } as unknown as AgentMessage & { tool_call_id: string; name: string };
          }
          // Historical tool row without valid call ID: render as context text
          return { role: "user", content: `[Historical tool output]: ${content.slice(0, 500)}`, timestamp: Date.now() } as AgentMessage;
        }

        return { role, content, timestamp: Date.now() } as AgentMessage;
      });
    } catch (err) {
      logWarn(TAG, `Abmind projection failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private fallback(agentMessages: AgentMessage[]): TransformResult {
    if (this.lastSafeBaseline) {
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
      { role: "user", content: typeof marker.content === "string" ? marker.content : "", timestamp: marker.timestamp },
    ];
    return { messages: fallback, contextDegraded: true };
  }

  buildSystemPromptFromSeed(): string {
    const parts: string[] = [this.systemPrompt];
    for (const block of this.seed.volatileBlocks) {
      if (block.content) {
        parts.push(`[${block.kind}]:\n${block.content}`);
      }
    }
    return parts.join("\n\n");
  }
}
