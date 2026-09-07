/**
 * pi-port.ts — #1577 abtars-owned Pi port vocabulary.
 *
 * Product-owned types for the Pi integration boundary, expressed entirely in
 * abtars terms. This module MUST NOT import any `@earendil-works/*` package
 * (enforced by `pi-boundary.test.ts`): a port file that references Pi types
 * is not a port. Rich upstream shapes (Context, Provider, streams) stay in
 * the integration area (`pi-core-types.ts` and siblings); conversion between
 * these product types and Pi wire shapes happens at the edge converters.
 *
 * Runtime routing through this vocabulary is owned by #1777; this module is
 * vocabulary only — no runtime code.
 */

// ── Content ─────────────────────────────────────────────────────────────────

/** Product-owned message content part. Structural subset of the Pi wire
 *  shapes, so parts are assignable where Pi content is expected — but
 *  product code must only ever name this type. */
export type AbtarsContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

/** Product-owned image payload (single definition reused by field and parts). */
export type AbtarsImagePart = Extract<AbtarsContentPart, { type: "image" }>;

// ── #1444: instruction messages ─────────────────────────────────────────────

export interface AbtarsInstructionAgentMessage {
  role: "abtars_instruction";
  content: string;
  timestamp?: number;
  leaseId: string;
  instructionIds: readonly string[];
  executionId: string;
  kind: "steer" | "followUp";
}

// ── #1446: current-turn marker ──────────────────────────────────────────────

export interface AbtarsCurrentTurnMessage {
  role: "abtars_current_turn";
  content: string | AbtarsContentPart[];
  executionId: string;
  sessionId: string;
  durableMessageId?: number;
  timestamp: number;
  /** Product-owned image payloads, converted to provider image parts by the
   *  edge converter. Replaces the former Pi-coupled image representation. */
  images?: AbtarsImagePart[];
}

// ── #1446: context projection source ────────────────────────────────────────

export type PiContextProjectionSource =
  | {
      mode: "durable";
      sessionKey: string;
      beforeMessageId: number;
      maxContext: number;
      /** #1527: caller identity threaded into the projection request. */
      userId: string;
    }
  | {
      mode: "ephemeral";
      sessionKey: string;
    };

export interface PiExecutionContextSeed {
  source: PiContextProjectionSource;
  executionId: string;
  currentTurn: AbtarsCurrentTurnMessage;
  volatileBlocks: readonly { kind: string; content: string }[];
}

// ── #1446: tool execution context ───────────────────────────────────────────

export interface PiToolExecutionContext {
  executionId: string;
  userId: string;
  signal?: AbortSignal;
  safety: unknown;
  onToolStart?: (name: string) => void;
  onToolSuccess?: () => void;
  /** Wrap a JSON schema object as a Pi-compatible TypeScript schema (Type.Unsafe). */
  createUnsafeSchema?: (schema: Record<string, unknown>) => Record<string, unknown>;
}

// ── #1446: safety controller outcomes ───────────────────────────────────────

export type ToolDecision =
  | { decision: "execute" }
  | { decision: "error"; reason: string }
  | { decision: "skip" };

export type TurnDecision =
  | { decision: "continue" }
  | { decision: "stop"; reason: string }
  | { decision: "pause" };

// ── Port contract vocabulary (#1774 7-point contract, #1777 foundation) ─────
// Narrow identity/policy/event categories in abtars terms. No Pi types.

/** Admission and correlation identity crossing the boundary. */
export interface PortTurnIdentity {
  executionId: string;
  sessionId: string;
  leaseId?: string;
  instructionIds?: readonly string[];
}

/** Explicit model selection input. No Pi default may widen it. */
export interface PortModelPolicy {
  model: string;
  provider?: string;
}

/** Authorized product tool descriptor. Pi tool schemas stay in the adapter. */
export interface PortToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Terminal outcome categories: exactly one per execution. */
export type PortTerminalOutcome = "completed" | "cancelled" | "failed";

/** Event categories mapped at the edge (text/tool/steering/provider/
 *  cancellation/cleanup/terminal per the #1774 contract). */
export type PortEventKind =
  | "text"
  | "tool"
  | "steering"
  | "provider"
  | "cancellation"
  | "cleanup"
  | "terminal";
