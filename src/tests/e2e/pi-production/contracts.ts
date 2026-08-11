/**
 * contracts.ts — #1528 Pi production-composition acceptance contracts.
 *
 * Test-only, versioned contracts shared by the runner, provider, TUI client,
 * and result writers. Nothing here is exported from a production package.
 */

export type PiAcceptanceLane = "local-unix" | "remote-wss";
export type PiAcceptanceProfile = "core" | "full";
export type PiScenarioState = "passed" | "failed" | "blocked";

export interface PiAcceptanceFailure {
  stage: string;
  code: string;
  message: string;
}

export interface PiScenarioResult {
  name: string;
  lane: PiAcceptanceLane;
  profile: PiAcceptanceProfile;
  state: PiScenarioState;
  durationMs: number;
  providerRequestIds: string[];
  failure?: PiAcceptanceFailure;
}

export interface PiLaneResult {
  lane: PiAcceptanceLane;
  profile: PiAcceptanceProfile;
  state: PiScenarioState;
  blockedBy?: string;
  scenarios: PiScenarioResult[];
}

export interface PiAcceptanceMatrixV1 {
  schemaVersion: 1;
  kind: "pi-production-e2e";
  runId: string;
  startedAt: string;
  durationMs: number;
  lanes: PiLaneResult[];
}

// ── Named timeouts (all waits carry a deadline) ─────────────────────────────

export const TIMEOUTS = {
  /** Bridge boot + TUI attach + smoke exchange. */
  bridgeReadinessMs: 120_000,
  /** A single TUI turn (provider round trip + delivery). */
  turnMs: 60_000,
  /** Owner restart / renegotiation wait. */
  ownerRecoveryMs: 60_000,
  /** Child shutdown grace before SIGKILL. */
  childGraceMs: 8_000,
  /** Held provider request (steer/cancel journeys). */
  holdSettleMs: 15_000,
  /** Controller command round trip. */
  controllerCommandMs: 60_000,
  /** Whole-run budget. */
  runMs: 20 * 60_000,
} as const;

// ── Reason codes (identical across lanes so the matrix exposes parity) ──────

export const REASON = {
  timeout: "timeout",
  expectation_failed: "expectation_failed",
  provider_error: "provider_error",
  tui_unavailable: "tui_unavailable",
  bridge_exit: "bridge_exit",
  route_lost: "route_lost",
  cleanup_failed: "cleanup_failed",
  prereq_missing: "prereq_missing",
  unscripted_request: "unscripted_request",
  blocked_lane: "blocked_lane",
} as const;

// ── Provider semantic request assertions ────────────────────────────────────

export interface RequestExpectation {
  /** Model id the request must carry. */
  candidate: string;
  /** Markers that must appear, in order, anywhere in the normalized messages. */
  orderedContains?: readonly string[];
  /** Markers that must appear exactly once in the whole request. */
  exactlyOnce?: readonly string[];
  /** Markers that must not appear at all. */
  excludes?: readonly string[];
  /**
   * The active current-turn marker: the LAST user message must contain it
   * exactly once, and no earlier message may contain it.
   */
  currentTurn?: string;
  /** True when no tool call/result may appear before the current-turn message. */
  noToolBeforeCurrent?: boolean;
}

export type ProviderAction =
  | { kind: "text"; chunks: string[] }
  | { kind: "toolCall"; name: string; arguments: unknown }
  | { kind: "httpError"; status: number; code: string }
  | { kind: "hold"; release: Promise<void> };

export interface ScriptedRequest {
  candidate: string;
  model: string;
  action: ProviderAction["kind"];
  aborted: boolean;
  roleCounts: Record<string, number>;
  toolCalls: string[];
  /** sha256 hashes of the current-turn markers that were present. */
  markerHashes: string[];
}

export interface ProviderScript {
  candidate: string;
  expectation?: RequestExpectation;
  action: ProviderAction;
}

/** Content-free request summary emitted to failure artifacts. */
export interface ProviderSummary {
  seq: number;
  candidate: string;
  action: string;
  aborted: boolean;
  roleCounts: Record<string, number>;
  toolCalls: string[];
  markerHashes: string[];
  /** Bounded synthetic user-message texts for substring marker matching. */
  markerTexts: string[];
}
