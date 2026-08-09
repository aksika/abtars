/**
 * session-control/types.ts — backend-neutral session control contracts
 * (#1406).
 *
 * Callers select an exact target and submit a typed operation; the service
 * dispatches to exactly one registered adapter by target kind. `compact` is
 * the first operation; future operations extend the discriminated request
 * union when their first consumer lands.
 */

export type SessionControlTarget =
  | {
      kind: "durable_conversation";
      principalId: string;
      sessionId: string;
      beforeMessageId?: number;
    }
  | {
      kind: "local_pi_run";
      principalId: string;
      runId: string;
      generation: number;
    };

export type SessionControlRequest = {
  kind: "compact";
  reason: "manual" | "automatic";
  customInstructions?: string;
  /** Optional cancellation signal (manual callers may pass one). */
  signal?: AbortSignal;
};

export type SessionControlStatus =
  | "completed"
  | "nothing_to_compact"
  | "busy"
  | "unsupported"
  | "stale"
  | "failed";

export interface SessionControlResult {
  status: SessionControlStatus;
  targetKind: SessionControlTarget["kind"];
  tokensBefore?: number;
  tokensAfter?: number;
  generation?: number;
  message: string;
}

export interface SessionControlAdapter<T extends SessionControlTarget = SessionControlTarget> {
  readonly targetKind: T["kind"];
  supports(request: SessionControlRequest): boolean;
  execute(target: T, request: SessionControlRequest): Promise<SessionControlResult>;
}

/** Bounded content-free compaction telemetry (one event per request). */
export interface SessionCompactionTelemetryV1 {
  targetKind: SessionControlTarget["kind"];
  reason: "manual" | "automatic";
  status: SessionControlStatus;
  generation?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  savingsPct?: number;
  provider?: string;
  model?: string;
  durationMs: number;
}
