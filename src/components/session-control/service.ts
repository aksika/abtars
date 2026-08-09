/**
 * session-control/service.ts — dispatch to exactly one adapter by target kind
 * (#1406). No adapter fallback is attempted after selection; authorization is
 * enforced both at target resolution and again at the backend boundary.
 */

import { logInfo } from "../logger.js";
import type {
  SessionControlAdapter, SessionControlRequest, SessionControlResult,
  SessionControlTarget, SessionCompactionTelemetryV1,
} from "./types.js";

const TAG = "session-control";

export interface SessionControlServiceDeps {
  /** Optional content-free telemetry sink. */
  onTelemetry?: (event: SessionCompactionTelemetryV1) => void;
}

export class SessionControlService {
  private readonly adapters = new Map<SessionControlTarget["kind"], SessionControlAdapter>();
  /** Automatic-request dedupe: one automatic compaction per session in flight. */
  private readonly autoInFlight = new Set<string>();
  private readonly deps: SessionControlServiceDeps;

  constructor(deps: SessionControlServiceDeps = {}) {
    this.deps = deps;
  }

  register<T extends SessionControlTarget>(adapter: SessionControlAdapter<T>): void {
    this.adapters.set(adapter.targetKind, adapter);
  }

  supports(target: SessionControlTarget): boolean {
    return this.adapters.has(target.kind);
  }

  /**
   * Execute one control request against exactly one adapter. Automatic
   * requests are deduplicated per target while one is in flight; manual
   * requests bypass dedupe but never the backend's own ownership, complete
   * turn, size, or CAS checks.
   */
  async execute(
    target: SessionControlTarget,
    request: SessionControlRequest,
  ): Promise<SessionControlResult> {
    const startedAt = Date.now();
    const adapter = this.adapters.get(target.kind);
    if (!adapter) {
      return this.finish({ status: "unsupported", targetKind: target.kind, message: `No backend supports ${target.kind}` }, request, startedAt);
    }
    if (!adapter.supports(request)) {
      return this.finish({ status: "unsupported", targetKind: target.kind, message: `Operation not supported by ${target.kind} backend` }, request, startedAt);
    }

    const dedupeKey = `${target.kind}:${target.kind === "durable_conversation" ? target.sessionId : target.runId}`;
    if (request.reason === "automatic") {
      if (this.autoInFlight.has(dedupeKey)) {
        return this.finish({ status: "busy", targetKind: target.kind, message: "Automatic maintenance already in flight for this session" }, request, startedAt);
      }
      this.autoInFlight.add(dedupeKey);
      try {
        const result = await adapter.execute(target, request);
        return this.finish(result, request, startedAt);
      } catch {
        return this.finish({ status: "failed", targetKind: target.kind, message: "Session control operation failed" }, request, startedAt);
      } finally {
        this.autoInFlight.delete(dedupeKey);
      }
    }

    try {
      const result = await adapter.execute(target, request);
      return this.finish(result, request, startedAt);
    } catch {
      return this.finish({ status: "failed", targetKind: target.kind, message: "Session control operation failed" }, request, startedAt);
    }
  }

  private finish(
    result: SessionControlResult,
    request: SessionControlRequest,
    startedAt: number,
  ): SessionControlResult {
    const durationMs = Date.now() - startedAt;
    this.emitTelemetry(result, request, durationMs);
    return result;
  }

  private emitTelemetry(
    result: SessionControlResult,
    request: SessionControlRequest,
    durationMs: number,
  ): void {
    const event: SessionCompactionTelemetryV1 = {
      targetKind: result.targetKind,
      reason: request.reason,
      status: result.status,
      generation: result.generation,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      savingsPct:
        result.tokensBefore && result.tokensAfter
          ? Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)
          : undefined,
      provider: result.provider,
      model: result.model,
      durationMs,
    };
    logInfo(TAG, `compaction ${event.targetKind} reason=${event.reason} status=${event.status}${event.generation !== undefined ? ` gen=${event.generation}` : ""}${event.tokensBefore !== undefined ? ` before=${event.tokensBefore} after=${event.tokensAfter ?? "?"} savings=${event.savingsPct ?? "?"}%` : ""} duration=${durationMs}ms`);
    try {
      this.deps.onTelemetry?.(event);
    } catch { /* telemetry must never break control */ }
  }
}
