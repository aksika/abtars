import { logWarn, logError, logDebug } from "../logger.js";
import type { PiExecutionContextSeed, AgentMessage, AbtarsCurrentTurnMessage } from "./pi-core-types.js";

const TAG = "pi-core-context";

export interface TransformOptions {
  signal?: AbortSignal;
  hostGeneration?: number;
  orchestrator?: {
    getRows?(sessionKey: string, maxContext: number, opts: { beforeMessageId: number }): unknown[];
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
      const markerIndex = this.locateCurrentTurnMarker(agentMessages);
      if (markerIndex < 0) {
        logError(TAG, `No current-turn marker found for execution ${this.seed.executionId}`);
        return this.fallback(agentMessages);
      }

      const suffix = agentMessages.slice(markerIndex);
      let durableMessages: AgentMessage[] = [];

      if (this.seed.source.mode === "durable") {
        if (options.signal?.aborted) return { messages: this.lastSafeBaseline ?? suffix, contextDegraded: true };

        durableMessages = await this.projectDurable(options);

        if (options.signal?.aborted) return { messages: this.lastSafeBaseline ?? suffix, contextDegraded: true };
      }

      const result: AgentMessage[] = [...durableMessages, ...suffix];

      if (generation === this.instanceGeneration) {
        this.lastSafeBaseline = result;
      }

      const marker = agentMessages[markerIndex] as unknown as AbtarsCurrentTurnMessage;
      logDebug(TAG, `Transform complete: ${durableMessages.length} durable + ${suffix.length} suffix (marker: ${marker.executionId})`);

      return { messages: result, contextDegraded: false };
    } catch (err) {
      logWarn(TAG, `Context projection failed for ${this.seed.executionId}: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback(agentMessages);
    }
  }

  private locateCurrentTurnMarker(messages: AgentMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === "abtars_current_turn") {
        const marker = m as unknown as AbtarsCurrentTurnMessage;
        if (marker.executionId === this.seed.executionId) return i;
      }
    }
    return -1;
  }

  private async projectDurable(options: TransformOptions): Promise<AgentMessage[]> {
    const source = this.seed.source;
    if (source.mode !== "durable") return [];

    if (!options.orchestrator) {
      logWarn(TAG, "Durable mode requested but no orchestrator available — returning empty projection");
      return [];
    }

    const rows = options.orchestrator.getRows
      ? options.orchestrator.getRows(source.sessionKey, source.maxContext, { beforeMessageId: source.beforeMessageId })
      : [];

    const limited = (rows as Array<Record<string, unknown>>).slice(-MAX_CONTEXT_ROWS);

    return limited.map((row: Record<string, unknown>) => {
      const role = String(row.role ?? "user");
      const content = String(row.content ?? "");
      const toolCallId = row.tool_call_id ? String(row.tool_call_id) : undefined;
      const toolName = row.name ? String(row.name) : undefined;

      if (role === "tool") {
        if (toolCallId && toolName) {
          return { role: "tool", content, tool_call_id: toolCallId, name: toolName, timestamp: Date.now() } as AgentMessage & { tool_call_id: string; name: string };
        }
        return { role: "user", content: `[Historical tool output]: ${content.slice(0, 500)}`, timestamp: Date.now() } as AgentMessage;
      }

      return { role, content, timestamp: Date.now() } as AgentMessage;
    });
  }

  private fallback(_agentMessages: AgentMessage[]): TransformResult {
    if (this.lastSafeBaseline) {
      return { messages: [...this.lastSafeBaseline], contextDegraded: true };
    }
    const marker = this.seed.currentTurn;
    const fallback: AgentMessage[] = [
      { role: "user", content: marker.content, timestamp: marker.timestamp },
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
