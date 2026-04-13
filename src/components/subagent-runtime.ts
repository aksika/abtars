/**
 * SubagentRuntime — unified LLM access for all subagents.
 * Replaces manual createSubagentTransport() calls.
 * Caches transports per agent, handles session lifecycle + fallback.
 */

import type { IKiroTransport } from "./transport/kiro-transport.js";
import { logInfo, logWarn } from "./logger.js";

const TAG = "runtime";

export type AgentName = "professor" | "dreamy" | "browsie" | "coding" | "cron";

export interface AgentOpts {
  /** Override default session strategy for this call. */
  session?: "fresh" | "reuse";
  /** Context passed to tool executor (userId, metadata). */
  context?: Record<string, unknown>;
}

interface CachedAgent {
  transport: IKiroTransport;
  model: string;
  sessionKey: string;
}

const DEFAULT_SESSION: Record<AgentName, "fresh" | "reuse"> = {
  professor: "reuse",
  dreamy: "fresh",
  browsie: "fresh",
  coding: "reuse",
  cron: "fresh",
};

export class SubagentRuntime {
  private readonly cache = new Map<AgentName, CachedAgent>();

  /** Send a prompt to a named agent and get the response. */
  async complete(agent: AgentName, prompt: string, opts?: AgentOpts): Promise<string> {
    const sessionStrategy = opts?.session ?? DEFAULT_SESSION[agent] ?? "fresh";
    const start = Date.now();

    const cached = this.cache.get(agent);
    if (cached && sessionStrategy === "fresh") {
      await cached.transport.resetSession?.(cached.sessionKey);
    }

    const { transport, model, sessionKey } = cached ?? await this.createAgent(agent);

    try {
      const response = await transport.sendPrompt(sessionKey, prompt);
      const elapsed = Date.now() - start;
      logInfo(TAG, `${agent} complete: ${prompt.length}ch → ${response?.length ?? 0}ch (${elapsed}ms, ${model})`);
      return response ?? "";
    } catch (err) {
      logWarn(TAG, `${agent} complete failed: ${err instanceof Error ? err.message : String(err)}`);
      // Evict on failure so next call creates fresh transport
      this.cache.delete(agent);
      throw err;
    }
  }

  /** Shut down all cached transports. */
  async shutdown(): Promise<void> {
    for (const [name, cached] of this.cache) {
      try { cached.transport.destroy(); } catch { /* best effort */ }
      logInfo(TAG, `${name} transport closed`);
    }
    this.cache.clear();
  }

  private async createAgent(agent: AgentName): Promise<CachedAgent> {
    const { createSubagentTransport } = await import("./agent-registry.js");
    const role = AGENT_TO_ROLE[agent];
    const { transport, model } = await createSubagentTransport(role);
    const sessionKey = `system:${agent}`;
    const entry: CachedAgent = { transport, model, sessionKey };
    this.cache.set(agent, entry);
    return entry;
  }
}

const AGENT_TO_ROLE: Record<AgentName, import("./agent-registry.js").SubagentRole> = {
  professor: "cron",  // professor subagent uses cron role (inherits professor config)
  dreamy: "sleep",
  browsie: "browse",
  coding: "coding",
  cron: "cron",
};
