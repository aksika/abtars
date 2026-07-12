/**
 * SubagentRuntime — unified LLM access for all subagents.
 * Replaces manual createSubagentTransport() calls.
 * Caches transports per agent, handles session lifecycle + fallback.
 */

import { logAndSwallow } from "./log-and-swallow.js";
import type { IKiroTransport, PromptRequestContext, RuntimeUsageSnapshot } from "./transport/kiro-transport.js";
import { logInfo, logDebug, logWarn } from "./logger.js";
import { randomBytes } from "node:crypto";

import type { ModelHealthRegistry } from "./transport/model-health-registry.js";

const TAG = "runtime";

export type AgentName = "professor" | "dreamy" | "browsie" | "coding" | "task";

export interface AgentOpts {
  /** Override default session strategy for this call. */
  session?: "fresh" | "reuse";
  /** Context passed to tool executor (userId, metadata). */
  context?: Record<string, unknown>;
  /** Override model API timeout for this call (ms). */
  timeoutMs?: number;
  /** Override session type (default: derived from agent name). */
  sessionType?: import("./spin-types.js").SessionType;
  /** Override tool-loop circuit breaker limit for this call. */
  maxToolRounds?: number;
  /** #1338: call-local observer for live TUI output mirroring. Forwarded to the transport. */
  outputObserver?: import("./session-output-feed.js").OutputObserver;
}

/** #1361: Per-execution handle for one-shot or continuation-capable LLM calls. */
export interface RuntimeExecution {
  send(prompt: string, image?: { mime: string; base64: string }, context?: PromptRequestContext): Promise<string>;
  close(): Promise<void>;
  readonly transport: IKiroTransport;
  readonly sessionKey: string;
  readonly ephemeral: boolean;
  lastUsage(): RuntimeUsageSnapshot | null;
}

/** Persistent transport handle for multi-turn callers. */
export interface AgentSession {
  sendPrompt(sessionKey: string, prompt: string, image?: { mime: string; base64: string }): Promise<string>;
  destroy(): Promise<void>;
  readonly isReady: boolean;
  /** Underlying transport — used to set sandboxPolicy for peer sessions (#678). */
  readonly transport?: IKiroTransport;
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
  task: "fresh",
};

const DEFAULT_SPAWN_TIMEOUT_MS = 600_000; // 10 min

export class SubagentRuntime {
  private readonly cache = new Map<AgentName, CachedAgent>();
  private readonly activeSpawns = new Map<string, { abort: AbortController; startedAt: number }>();
  private _registry: ModelHealthRegistry | null = null;
  private _mainTransport: IKiroTransport | null = null;
  private _lastUsage: RuntimeUsageSnapshot | null = null;

  /** Token usage from last complete() call. */
  get lastUsage(): RuntimeUsageSnapshot | null { return this._lastUsage; }
  private _sessionManager: import("./spin.js").Spin | null = null;
  private _sandboxEnabled = false;

  /** Set shared model health registry (from boot ctx). */
  setRegistry(registry: ModelHealthRegistry): void { this._registry = registry; }

  /** Set main transport reference for currentModel reads. */
  setMainTransport(transport: IKiroTransport): void { this._mainTransport = transport; }

  /** Set session manager for auto-spawn sub-session creation (#510). */
  setSessionManager(mgr: import("./spin.js").Spin): void { this._sessionManager = mgr; }

  /** Get session manager (may be null before boot completes). */
  get sessionManager(): import("./spin.js").Spin | null { return this._sessionManager; }

  /** Enable Docker sandbox for W/B/C sessions (#478). */
  setSandboxEnabled(enabled: boolean): void { this._sandboxEnabled = enabled; }

  /** Send a prompt to a named agent and get the response. */
  async complete(agent: AgentName, prompt: string, opts?: AgentOpts): Promise<string> {
    const exec = await this.openExecution(agent, agent, opts);
    try {
      const response = await exec.send(prompt, undefined, { outputObserver: opts?.outputObserver });
      this._lastUsage = exec.lastUsage();
      return response ?? "";
    } catch (err) {
      logWarn(TAG, `${agent} complete failed: ${err instanceof Error ? err.message : String(err)}`);
      this.cache.delete(agent);
      throw err;
    } finally {
      await exec.close();
    }
  }

  /** #1361: Open a uniquely-keyed execution handle. Key must be unique per concurrent
   *  execution (use ManagedSession ID for one-shot sessions, not the agent name alone). */
  async openExecution(agent: AgentName, key: string, opts?: AgentOpts): Promise<RuntimeExecution> {
    const { checkBudget, sendBudgetNotification } = await import("./budget.js");
    const budgetCheck = checkBudget(agent);
    if (!budgetCheck.allowed) {
      const reason = budgetCheck.remaining.tokens <= 0 ? "token" : "call";
      void sendBudgetNotification(agent, reason);
      throw new Error(`Daily ${reason} budget exceeded for ${agent}. Resets at midnight.`);
    }

    const sessionStrategy = opts?.session ?? DEFAULT_SESSION[agent] ?? "fresh";

    const cached = this.cache.get(key as AgentName);
    if (cached && sessionStrategy === "fresh") {
      await cached.transport.resetSession?.(cached.sessionKey);
      (await import("./transport/tool-registry.js")).resetStoreCounter();
    }

    const cacheKey = key as AgentName;
    const entry = this.cache.get(cacheKey) ?? await this.createAgent(agent, opts?.sessionType, key);
    const { transport, model } = entry;
    const sessionKey = entry.sessionKey;

    // Per-call timeout override
    if (opts?.timeoutMs && transport.setTimeoutOverride) {
      transport.setTimeoutOverride(opts.timeoutMs);
    }
    // Per-call tool-round circuit breaker override
    if (opts?.maxToolRounds != null && transport.setMaxToolRoundsOverride) {
      transport.setMaxToolRoundsOverride(opts.maxToolRounds);
    }

    let closed = false;
    const start = Date.now();

    const exec: RuntimeExecution = {
      transport,
      sessionKey,
      ephemeral: sessionStrategy === "fresh",
      lastUsage: () => transport.lastUsage?.() ?? null,

      send: async (prompt, image, context) => {
        const response = await transport.sendPrompt(sessionKey, prompt, image, context);
        logDebug(TAG, `${key} exec.send: ${prompt.length}ch → ${response?.length ?? 0}ch (${model})`);
        return response ?? "";
      },

      close: async () => {
        if (closed) return;
        closed = true;

        // Reset overrides — transport stays in cache (cleaned by shutdown())
        if (opts?.timeoutMs && transport.setTimeoutOverride) {
          transport.setTimeoutOverride(null);
        }
        if (opts?.maxToolRounds != null && transport.setMaxToolRoundsOverride) {
          transport.setMaxToolRoundsOverride(null);
        }

        const elapsed = Date.now() - start;
        logDebug(TAG, `${key} exec closed (${elapsed}ms, ${model})`);
      },
    };

    return exec;
  }

  /** Get a persistent session handle for multi-turn callers. */
  async session(agent: AgentName, key?: string): Promise<AgentSession> {
    const cacheKey = key ? `${agent}:${key}` : agent;
    const cached = this.cache.get(cacheKey as AgentName) ?? await this.createAgent(agent, undefined, cacheKey);
    return {
      sendPrompt: (sessionKey: string, prompt: string) => cached.transport.sendPrompt(sessionKey, prompt),
      destroy: async () => {
        try { cached.transport.destroy(); } catch (err) { logAndSwallow("subagent_runtime", "op", err); }
        this.cache.delete(cacheKey as AgentName);
        logInfo(TAG, `${cacheKey} session destroyed`);
      },
      get isReady() { return cached.transport.isReady; },
      get transport() { return cached.transport; },
    };
  }

  /** Fire-and-forget: run complete() in background, deliver result via callback. */
  async spawn(agent: AgentName, prompt: string, opts?: SpawnOpts): Promise<SpawnResult> {
    const taskId = randomBytes(4).toString("hex");
    const abort = new AbortController();
    this.activeSpawns.set(taskId, { abort, startedAt: Date.now() });

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
      try { cached.transport.destroy(); } catch (err) { logAndSwallow("subagent_runtime", "op", err); }
      logInfo(TAG, `${name} transport closed`);
    }
    this.cache.clear();
  }

  /** Active registry: list running background spawns. */
  listActive(): Array<{ taskId: string; startedAt: number }> {
    return [...this.activeSpawns.entries()].map(([taskId, entry]) => ({
      taskId,
      startedAt: (entry as any).startedAt ?? 0,
    }));
  }

  /** Interrupt a specific spawn by taskId. Returns true if found. */
  interruptSpawn(taskId: string): boolean {
    const entry = this.activeSpawns.get(taskId);
    if (!entry) return false;
    entry.abort.abort();
    this.activeSpawns.delete(taskId);
    logInfo(TAG, `spawn ${taskId} interrupted`);
    return true;
  }

  private async createAgent(agent: AgentName, sessionType?: import("./spin-types.js").SessionType, cacheKey?: string): Promise<CachedAgent> {
    const typeMap: Partial<Record<AgentName, import("./spin-types.js").SessionType>> = { browsie: "B", coding: "C", task: "T" };
    const resolvedType = sessionType || typeMap[agent];
    const sandboxTypes = new Set(["B", "C", "W"]);

    // #478: Route to Docker container for sandboxed session types
    if (this._sandboxEnabled && resolvedType && sandboxTypes.has(resolvedType)) {
      const { logInfo } = await import("./logger.js");
      logInfo("subagent", `Sandbox spawn: ${agent} (type=${resolvedType}) → Docker container`);
      // TODO (#478-integration): spawn container, connect socket, return proxy transport
      // For now, fall through to in-process (container-side agent code not yet implemented)
    }

    const { createSubagentTransport } = await import("./agent-registry.js");
    const role = AGENT_TO_ROLE[agent];
    const mainModel = this._mainTransport && "currentModel" in this._mainTransport
      ? (this._mainTransport as unknown as { currentModel: string }).currentModel
      : undefined;
    const { transport, model } = await createSubagentTransport(role, this._registry ?? undefined, mainModel);

    // #1290: attribute per-turn budget to the agent Spin resolved for this session.
    // DirectApi only — ACP transport uses its own this.agentName. The "professor"
    // default in direct-api-transport.ts stays correct for the main boot transport
    // (phase-transport.ts), which bypasses createAgent.
    if ("agentLabel" in transport) {
      (transport as { agentLabel: string }).agentLabel = agent;
    }

    // #1012: Track PID so boot-time cleanup finds orphans
    if ((transport as any).agent?.pid) {
      import("./transport/bridge-lock-transport.js").then(({ trackAcpPid }) => trackAcpPid((transport as any).agent.pid)).catch(() => {});
    }

    // Inject session-type-appropriate SOUL bundle (#744)
    if (resolvedType && "setSystemPrompt" in transport && typeof (transport as any).setSystemPrompt === "function") {
      const { buildSoulBundle } = await import("./soul-bundle.js");
      const bundle = buildSoulBundle(resolvedType);
      if (bundle) (transport as any).setSystemPrompt(bundle);
    }

    const sessionKey = `system:${cacheKey ?? agent}`;
    const entry: CachedAgent = { transport, model, sessionKey };
    this.cache.set((cacheKey ?? agent) as AgentName, entry);
    (await import("./transport/tool-registry.js")).resetStoreCounter();
    return entry;
  }
}

const AGENT_TO_ROLE: Record<AgentName, import("./agent-registry.js").SubagentRole> = {
  professor: "task",
  dreamy: "sleep",
  browsie: "browse",
  coding: "coding",
  task: "task",
};
