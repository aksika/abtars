/**
 * spin.ts — Session lifecycle orchestrator (#894).
 * Single gateway for all non-Main session creation.
 * Fire-and-forget: dispatch returns cardId immediately, session runs autonomously.
 */

import { logInfo, logWarn, logTrace } from "./logger.js";
import { kanbanEnqueue, kanbanRunning, kanbanComplete, kanbanFail, kanbanList } from "./tasks/kanban-board.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import type { SessionType } from "./session-manager.js";
import type { SandboxPolicy } from "./tool-sandbox.js";

const TAG = "spin";

export interface SpinRequest {
  type: SessionType;
  goal: string;
  source: "task" | "user" | "agent" | "peer";
  cardId?: number;
  parentCardId?: number;
  deliveryMode?: "silent" | "announce";
  priority?: string;
  tools?: SandboxPolicy;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000; // 30 min

/** Concurrency limits per session type. */
const MAX_CONCURRENT: Partial<Record<SessionType, number>> = {
  T: 1, O: 1, B: 1, D: 1, H: 1, W: 3,
};

export class Spin {
  private running = new Map<SessionType, Set<number>>(); // type → active cardIds
  private runtime: SubagentRuntime | null = null;

  setRuntime(runtime: SubagentRuntime): void {
    this.runtime = runtime;
  }

  /**
   * Dispatch a session. Fire-and-forget.
   * Returns cardId immediately. Session runs autonomously.
   */
  dispatch(request: SpinRequest): number {
    const cardId = request.cardId ?? kanbanEnqueue(request.goal, request.source, undefined, {
      priority: request.priority ?? "MEDIUM",
      type: request.type,
      parent_id: request.parentCardId,
    });

    if (!this.canDispatch(request.type, cardId)) {
      logInfo(TAG, `${request.type} card:${cardId} queued (concurrency gate)`);
      return cardId;
    }

    this.markRunning(request.type, cardId);
    kanbanRunning(cardId);
    logTrace(TAG, `dispatch ${request.type} card:${cardId} source=${request.source} goal="${request.goal.slice(0, 80)}"`);

    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.execute(request, cardId, timeout)
      .then((result) => {
        logTrace(TAG, `done ${request.type} card:${cardId} result=${result.length} chars`);
        kanbanComplete(cardId, null, result.slice(0, 500));
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn(TAG, `${request.type} card:${cardId} failed: ${msg}`);
        kanbanFail(cardId, msg.slice(0, 1000));
      })
      .finally(() => {
        this.markDone(request.type, cardId);
        this.drainQueued();
      });

    return cardId;
  }

  /**
   * Dispatch and await result. For callers that need the response (e.g. task post-processing).
   * Caller owns kanban completion/failure updates.
   */
  async dispatchAwait(request: SpinRequest): Promise<{ cardId: number; result: string }> {
    const cardId = request.cardId ?? kanbanEnqueue(request.goal, request.source, undefined, {
      priority: request.priority ?? "MEDIUM",
      type: request.type,
      parent_id: request.parentCardId,
    });

    this.markRunning(request.type, cardId);
    kanbanRunning(cardId);

    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await this.execute(request, cardId, timeout);
      return { cardId, result };
    } finally {
      this.markDone(request.type, cardId);
      this.drainQueued();
    }
  }

  /** Only callable by O-session — spawn child workers. */
  spawnChild(parentCardId: number, request: Omit<SpinRequest, "type"> & { type?: SessionType }): number {
    if (request.type === "O") throw new Error("Cannot nest orchestrators");
    return this.dispatch({ ...request, type: "W", parentCardId });
  }

  /** Check queued cards and dispatch any that fit concurrency limits. */
  private drainQueued(): void {
    const queued = kanbanList("queued");
    for (const card of queued) {
      const type = (card.type as SessionType) ?? "T";
      if (this.canDispatch(type, card.id)) {
        this.dispatch({ type, goal: card.title, source: (card.source as SpinRequest["source"]) ?? "task", cardId: card.id });
      }
    }
  }

  private canDispatch(type: SessionType, _cardId: number): boolean {
    const max = MAX_CONCURRENT[type] ?? 5;
    const active = this.running.get(type)?.size ?? 0;
    logTrace(TAG, `gate ${type}: active=${active} max=${max}`);
    return active < max;
  }

  private markRunning(type: SessionType, cardId: number): void {
    if (!this.running.has(type)) this.running.set(type, new Set());
    this.running.get(type)!.add(cardId);
  }

  private markDone(type: SessionType, cardId: number): void {
    this.running.get(type)?.delete(cardId);
  }

  private async execute(request: SpinRequest, cardId: number, timeoutMs: number): Promise<string> {
    if (!this.runtime) throw new Error("Spin: runtime not set");

    const agentName = request.type === "O" ? "professor" :
                      request.type === "B" ? "browsie" :
                      "task";

    logInfo(TAG, `▶ ${request.type} card:${cardId} agent=${agentName}`);
    logTrace(TAG, `execute card:${cardId} timeout=${Math.round(timeoutMs / 1000)}s goal="${request.goal.slice(0, 120)}"`);

    const timer = setTimeout(() => {
      logWarn(TAG, `⏱️ ${request.type} card:${cardId} timed out (${Math.round(timeoutMs / 60000)}min)`);
      this.runtime?.interruptSpawn(`spin-${cardId}`);
    }, timeoutMs);

    try {
      const { buildSoulBundle } = await import("./soul-bundle.js");
      const bundle = buildSoulBundle(request.type);
      const fullPrompt = bundle ? `${bundle}\n\n---\n\n${request.goal}` : request.goal;

      const result = await this.runtime.complete(agentName, fullPrompt, {
        timeoutMs,
        session: "fresh",
      });
      return result || "(no output)";
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Singleton instance. */
export const spin = new Spin();
