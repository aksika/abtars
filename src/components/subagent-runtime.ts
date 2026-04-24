/**
 * SubagentRuntime — unified LLM access for all subagents.
 * Replaces manual createSubagentTransport() calls.
 * Caches transports per agent, handles session lifecycle + fallback.
 */

import type { IKiroTransport } from "./transport/kiro-transport.js";
import { logInfo, logWarn } from "./logger.js";
import { randomBytes } from "node:crypto";

import type { ModelHealthRegistry } from "./transport/model-health-registry.js";

const TAG = "runtime";

export type AgentName = "professor" | "dreamy" | "browsie" | "coding" | "cron";

export interface AgentOpts {
  /** Override default session strategy for this call. */
  session?: "fresh" | "reuse";
  /** Context passed to tool executor (userId, metadata). */
  context?: Record<string, unknown>;
}

/** Persistent transport handle for multi-turn callers. */
export interface AgentSession {
  sendPrompt(sessionKey: string, prompt: string): Promise<string>;
  destroy(): Promise<void>;
  readonly isReady: boolean;
}

export interface SpawnResult {
  taskId: string;
}

export interface SpawnOpts {
  onComplete?: (taskId: string, result: string) => void;
  onError?: (taskId: string, error: Error) => void;
  timeoutMs?: number;
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

const DEFAULT_SPAWN_TIMEOUT_MS = 600_000; // 10 min

export class SubagentRuntime {
  private readonly cache = new Map<AgentName, CachedAgent>();
  private readonly activeSpawns = new Map<string, { abort: AbortController }>();
  private _registry: ModelHealthRegistry | null = null;

  /** Set shared model health registry (from boot ctx). */
  setRegistry(registry: ModelHealthRegistry): void { this._registry = registry; }

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
      this.cache.delete(agent);
      throw err;
    }
  }

  /** Get a persistent session handle for multi-turn callers. */
  async session(agent: AgentName): Promise<AgentSession> {
    const cached = this.cache.get(agent) ?? await this.createAgent(agent);
    return {
      sendPrompt: (sessionKey: string, prompt: string) => cached.transport.sendPrompt(sessionKey, prompt),
      destroy: async () => {
        try { cached.transport.destroy(); } catch { /* best effort */ }
        this.cache.delete(agent);
        logInfo(TAG, `${agent} session destroyed`);
      },
      get isReady() { return cached.transport.isReady; },
    };
  }

  /** Fire-and-forget: run complete() in background, deliver result via callback. */
  async spawn(agent: AgentName, prompt: string, opts?: SpawnOpts): Promise<SpawnResult> {
    const taskId = randomBytes(4).toString("hex");
    const abort = new AbortController();
    this.activeSpawns.set(taskId, { abort });

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    // Fire and forget — don't await
    void (async () => {
      try {
        const result = await this.complete(agent, prompt);
        if (!abort.signal.aborted) opts?.onComplete?.(taskId, result);
      } catch (err) {
        if (!abort.signal.aborted) opts?.onError?.(taskId, err instanceof Error ? err : new Error(String(err)));
      } finally {
        clearTimeout(timer);
        this.activeSpawns.delete(taskId);
      }
    })();

    logInfo(TAG, `${agent} spawned: taskId=${taskId}, timeout=${timeoutMs}ms`);
    return { taskId };
  }

  /** Shut down all cached transports and abort active spawns. */
  async shutdown(): Promise<void> {
    for (const [id, { abort }] of this.activeSpawns) {
      abort.abort();
      logInfo(TAG, `spawn ${id} aborted`);
    }
    this.activeSpawns.clear();

    for (const [name, cached] of this.cache) {
      try { cached.transport.destroy(); } catch { /* best effort */ }
      logInfo(TAG, `${name} transport closed`);
    }
    this.cache.clear();
  }

  private async createAgent(agent: AgentName): Promise<CachedAgent> {
    const { createSubagentTransport } = await import("./agent-registry.js");
    const role = AGENT_TO_ROLE[agent];
    const { transport, model } = await createSubagentTransport(role, this._registry ?? undefined);
    const sessionKey = `system:${agent}`;
    const entry: CachedAgent = { transport, model, sessionKey };
    this.cache.set(agent, entry);
    return entry;
  }
}

const AGENT_TO_ROLE: Record<AgentName, import("./agent-registry.js").SubagentRole> = {
  professor: "cron",
  dreamy: "sleep",
  browsie: "browse",
  coding: "coding",
  cron: "cron",
};
