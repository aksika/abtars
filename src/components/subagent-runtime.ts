/**
 * SubagentRuntime — unified LLM access for all subagents.
 * Replaces manual createSubagentTransport() calls.
 * Caches transports per agent, handles session lifecycle + fallback.
 */

import { logAndSwallow } from "./log-and-swallow.js";
import type { IKiroTransport, PromptRequestContext, RuntimeUsageSnapshot } from "./transport/kiro-transport.js";
import { logInfo, logDebug, logWarn } from "./logger.js";
import { profileCarriesSoulBundle } from "./spin-profiles.js";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ToolExecutionScope } from "./tasks/task-package.js";

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
  /** #1935: generation-owned cancellation; aborts acquisition and execution. */
  signal?: AbortSignal;
}

/** #1361: Per-execution handle for one-shot or continuation-capable LLM calls. */
export interface RuntimeExecution {
  send(prompt: string, image?: { mime: string; base64: string }, context?: PromptRequestContext): Promise<string>;
  cancel(reason: import("./swarm-executor-types.js").CancelReason): Promise<void>;
  close(): Promise<void>;
  readonly transport: IKiroTransport;
  readonly sessionKey: string;
  readonly executionId: string;
  readonly ephemeral: boolean;
  /** #1364: Per-execution abort signal. Abort the controller to cancel the execution. */
  readonly abortSignal?: AbortSignal;
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
  /** #1611: immutable candidate policy captured at transport creation. */
  candidatePolicy?: import("./spin-types.js").CandidatePolicy;
  /** #1807: immutable canonical cwd attested at transport creation. Absent
   *  means created without a scope — unverified, never a match. */
  cwdBinding?: string;
}

/**
 * #1807: canonicalize an execution cwd. Throws when the directory is
 * unavailable — callers fail the invocation instead of inheriting daemon cwd.
 */
export function canonicalizeCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    throw new Error(`sleep execution cwd unavailable: ${cwd}`);
  }
}

const DEFAULT_SESSION: Record<AgentName, "fresh" | "reuse"> = {
  professor: "reuse",
  dreamy: "fresh",
  browsie: "fresh",
  coding: "reuse",
  task: "fresh",
};

const DEFAULT_SPAWN_TIMEOUT_MS = 15 * 60_000; // 15 min

export class SubagentRuntime {
  private readonly cache = new Map<string, CachedAgent>();
  private readonly activeSpawns = new Map<string, { abort: AbortController; startedAt: number }>();
  private _lastUsage: RuntimeUsageSnapshot | null = null;

  /** Token usage from last complete() call. */
  get lastUsage(): RuntimeUsageSnapshot | null { return this._lastUsage; }
  private _sessionManager: import("./spin.js").Spin | null = null;
  private _sandboxEnabled = false;

  /** Set session manager for auto-spawn sub-session creation (#510). */
  setSessionManager(mgr: import("./spin.js").Spin): void { this._sessionManager = mgr; }

  /** Get session manager (may be null before boot completes). */
  get sessionManager(): import("./spin.js").Spin | null { return this._sessionManager; }

  /** #1552: late-bound memory-tool dependencies holder; lazy transports
   *  created after boot composition receive the shared holder. */
  private _memoryToolDeps: import("./memory-store-quota.js").MemoryToolDependenciesHolder = { current: null };
  setMemoryToolDependencies(holder: import("./memory-store-quota.js").MemoryToolDependenciesHolder): void {
    this._memoryToolDeps = holder;
  }

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
      const detail = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `${agent} complete failed (error_chars=${detail.length})`);
      this.cache.delete(agent);
      throw err;
    } finally {
      await exec.close();
    }
  }

  /** #1361: Open a uniquely-keyed execution handle. Key must be unique per concurrent
   *  execution (use ManagedSession ID for one-shot sessions, not the agent name alone). */
  async openExecution(agent: AgentName, key: string, opts?: AgentOpts): Promise<RuntimeExecution> {
    // #1935: the per-call deadline starts at call entry, covering the budget
    // check, transport acquisition and execution. A call aborted during
    // acquisition disposes the acquired transport before any send.
    const start = Date.now();
    let deadlineExpired = false;
    let exec: RuntimeExecution | null = null;
    let acquiredEntry: CachedAgent | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        deadlineExpired = true;
        void exec?.cancel("deadline");
      }, Math.max(1, opts.timeoutMs));
      timeoutHandle.unref?.();
    }
    const failIfStopped = (): void => {
      if (!deadlineExpired && !opts?.signal?.aborted) return;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      throw new Error(deadlineExpired ? "Execution deadline exceeded" : "Execution cancelled");
    };
    try {
      failIfStopped();
      const { checkBudget, sendBudgetNotification } = await import("./budget.js");
      const budgetCheck = checkBudget(agent);
      if (!budgetCheck.allowed) {
        const reason = budgetCheck.remaining.tokens <= 0 ? "token" : "call";
        void sendBudgetNotification(agent, reason);
        throw new Error(`Daily ${reason} budget exceeded for ${agent}. Resets at midnight.`);
      }

      const sessionStrategy = opts?.session ?? DEFAULT_SESSION[agent] ?? "fresh";

      const cached = this.cache.get(key);
      if (cached && sessionStrategy === "fresh") {
        await cached.transport.resetSession?.(cached.sessionKey);
      }

      const cacheKey = key;
      const existingEntry = this.cache.get(cacheKey);
      const entry = existingEntry ?? await this.createAgent(agent, opts?.sessionType, key);
      const acquiredHere = existingEntry === undefined;
      acquiredEntry = acquiredHere ? entry : undefined;
      failIfStopped();
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
      let cancelled = false;
      const execId = `runtime_${sessionKey}_${Date.now()}_${randomBytes(4).toString("hex")}`;

      exec = {
        transport,
        sessionKey,
        executionId: execId,
        ephemeral: sessionStrategy === "fresh",
        lastUsage: () => transport.lastUsage?.() ?? null,

        send: async (prompt, image, context) => {
          if (cancelled || deadlineExpired) throw new Error("Execution cancelled");
          const response = await transport.sendPrompt(sessionKey, prompt, image, {
            ...context,
            executionId: context?.executionId ?? execId,
          });
          if (cancelled || deadlineExpired) throw new Error("Execution cancelled");
          logDebug(TAG, `${key} exec.send: ${prompt.length}ch → ${response?.length ?? 0}ch (${model})`);
          return response ?? "";
        },

        cancel: async (reason: import("./swarm-executor-types.js").CancelReason) => {
          if (closed || cancelled) return;
          cancelled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          logDebug(TAG, `${key} exec.cancel (${reason})`);
          // Each open execution has a unique cache key, so interrupting this
          // transport cannot cancel a sibling execution. This is required for
          // ACP and tmux, which do not implement setTimeoutOverride().
          try {
            await transport.sendInterrupt(reason);
          } catch (err) {
            logAndSwallow(TAG, "exec.cancel", err);
          }
        },

        close: async () => {
          if (closed) return;
          closed = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);

          if (sessionStrategy === "fresh") {
            // Interrupt if still active, destroy transport, remove cache entry
            if (!cancelled) {
              try { await transport.sendInterrupt?.("execution_closed"); } catch { /* best effort */ }
            }
            try { transport.destroy(); } catch { /* best effort */ }
            this.cache.delete(cacheKey);
            logDebug(TAG, `${key} ephemeral exec closed — transport destroyed, cache removed`);
          } else {
            // Reset overrides — persistent transport stays in cache
            if (opts?.timeoutMs && transport.setTimeoutOverride) {
              transport.setTimeoutOverride(null);
            }
            if (opts?.maxToolRounds != null && transport.setMaxToolRoundsOverride) {
              transport.setMaxToolRoundsOverride(null);
            }
            logDebug(TAG, `${key} exec closed (${Date.now() - start}ms, ${model})`);
          }
        },
      };
      failIfStopped();
      return exec;
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Acquisition may have completed while the call was already aborted:
      // dispose a transport created for this call before the caller can use it.
      if (acquiredEntry && (deadlineExpired || opts?.signal?.aborted)) {
        try { acquiredEntry.transport.destroy(); } catch { /* best effort */ }
        this.cache.delete(key);
      }
      throw err;
    }
  }

  /** Get a persistent session handle for multi-turn callers. */
  async session(agent: AgentName, key?: string, opts?: { candidatePolicy?: import("./spin-types.js").CandidatePolicy; executionScope?: ToolExecutionScope; sessionType?: import("./spin-types.js").SessionType }): Promise<AgentSession> {
    const cacheKey = key ? `${agent}:${key}` : agent;
    // #1807: a requested scope must match the transport's recorded creation
    // binding. Mismatch or unverified binding fails before any provider/tool
    // work — never falls back, never re-roots in place.
    const requestedCwd = opts?.executionScope ? canonicalizeCwd(opts.executionScope.cwd) : undefined;
    const existing = this.cache.get(cacheKey);
    if (existing) {
      if (requestedCwd !== undefined) {
        if (existing.cwdBinding === undefined) {
          throw new Error(`sleep transport ${cacheKey} has no recorded cwd binding — refusing unverified reuse`);
        }
        if (existing.cwdBinding !== requestedCwd) {
          throw new Error(`sleep transport ${cacheKey} bound to ${existing.cwdBinding}, requested ${requestedCwd} — refusing reuse`);
        }
      }
    } else {
      await this.createAgent(agent, opts?.sessionType, cacheKey, opts?.candidatePolicy, requestedCwd);
    }
    const cached = this.cache.get(cacheKey)!;
    // #1611: the candidate policy is immutable per attached transport. A
    // conflicting request fails closed — it must never silently broaden a
    // configured-only session into a fallback chain.
    const policy = opts?.candidatePolicy;
    if (policy && cached.candidatePolicy && cached.candidatePolicy !== policy) {
      throw new Error(`Session ${cacheKey} is attached with candidate policy ${cached.candidatePolicy}; refusing conflicting reuse (${policy})`);
    }
    return {
      sendPrompt: (sessionKey: string, prompt: string) => cached.transport.sendPrompt(sessionKey, prompt),
      destroy: async () => {
        try { cached.transport.destroy(); } catch (err) { logAndSwallow("subagent_runtime", "op", err); }
        // #1807: identity-fenced release — a stale callback must not evict a
        // newer entry under the same key or affect another session.
        if (this.cache.get(cacheKey) === cached) this.cache.delete(cacheKey);
        logInfo(TAG, `${cacheKey} session destroyed`);
      },
      get isReady() { return cached.transport.isReady; },
      get transport() { return cached.transport; },
    };
  }

  /**
   * #1807: read the recorded canonical cwd binding for a cached transport.
   * Returns undefined when absent (no entry, or entry created without scope).
   * Spin uses this on the already-attached reuse path; absent is unverified,
   * never a match.
   */
  verifyTransportBinding(agent: AgentName, key?: string): string | undefined {
    const cacheKey = key ? `${agent}:${key}` : agent;
    return this.cache.get(cacheKey)?.cwdBinding;
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

  private async createAgent(agent: AgentName, sessionType?: import("./spin-types.js").SessionType, cacheKey?: string, candidatePolicy?: import("./spin-types.js").CandidatePolicy, workingDir?: string): Promise<CachedAgent> {
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
    // #1418: pass the complete last-successful Main candidate (secret-free tuple)
    // into specialist construction so fallback ordering reuses the exact Main
    // candidate that last produced a non-empty response.
    // #1611: configured-only restricts transport construction to the configured
    // candidate — applied before the first Dreamy prompt, never after the fact.
    const { transport, model } = await createSubagentTransport(role, this._memoryToolDeps, candidatePolicy, workingDir);

    // #1290: attribute per-turn budget to the agent Spin resolved for this session.
    // External ACP keeps its own agent label; embedded Pi uses this label when
    // the transport exposes the optional capability.
    if ("agentLabel" in transport) {
      (transport as { agentLabel: string }).agentLabel = agent;
    }

    // #1012: Track PID so boot-time cleanup finds orphans
    if ((transport as any).agent?.pid) {
      import("./transport/bridge-lock-transport.js").then(({ trackAcpPid }) => trackAcpPid((transport as any).agent.pid)).catch(err => logAndSwallow(TAG, "track ACP pid in bridge lock", err));
    }

    // #744/#1940: inject the session-type SOUL bundle into the Pi session
    // system prompt. Only types whose profile owns a bundle (registry
    // `soulBundle`) receive one; A/K/S/D keep their existing prompts. The
    // type must be the real Spin type — inferring from the agent name gives
    // professor types no bundle and gives browsie's W/O the B identity.
    if (resolvedType && "setSystemPrompt" in transport && typeof (transport as any).setSystemPrompt === "function") {
      if (profileCarriesSoulBundle(resolvedType)) {
        const { buildSoulBundle } = await import("./soul-bundle.js");
        const bundle = buildSoulBundle(resolvedType);
        if (bundle) (transport as any).setSystemPrompt(bundle);
      }
    }

    const sessionKey = `system:${cacheKey ?? agent}`;
    const entry: CachedAgent = { transport, model, sessionKey, candidatePolicy, cwdBinding: workingDir };
    this.cache.set(cacheKey ?? agent, entry);
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
