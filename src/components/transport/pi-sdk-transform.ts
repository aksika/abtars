/**
 * pi-sdk-transform.ts — #1932: request-scoped SDK transform.
 *
 * Pi owns the history flowing through; abtars owns the per-request system
 * bundle, safety round limits, classified-literal scrubbing, and durable
 * admission (liveness probe + archive gap + soul gate). The fresh bundle is
 * request-scoped and never written back to Pi history.
 *
 * Pure factory over explicit inputs so admission behavior is unit-testable
 * without a live SDK session; the transport supplies the per-turn inputs.
 */
import { logDebug } from "../logger.js";
import { DurableContextUnavailableError } from "./pi-core-context.js";
import type { PiDurableContextProvider } from "./pi-core-context.js";
import type { PiExecutionSafetyController } from "./pi-core-safety.js";
import type { AgentMessage } from "./pi-core-types.js";
import { PiSoulGate } from "../pi-session/pi-soul-gate.js";
import { soulBundleEnvelope } from "../pi-session/pi-soul-envelope.js";

/** #1932: hydration marker for the soul gate. The gate stores it opaquely;
 *  admission, not content, is what the gate decides. */
export const SOUL_HYDRATED = { hydrated: true };

export type SdkTransformSource =
  | { mode: "durable"; sessionKey: string; beforeMessageId: number; maxContext: number; userId: string }
  | { mode: "ephemeral"; sessionKey: string };

export interface SdkTransformInputs {
  safety: PiExecutionSafetyController;
  source: SdkTransformSource;
  volatileBlocks: Array<{ kind: string; content: string }>;
  executionId: string;
  candidateKey: string;
  contextProvider?: PiDurableContextProvider;
  /** Awaited archive probe (existing projection API); history discarded. */
  projectContext: (input: { userId: string; sessionId: string; beforeMessageId: number; maxContext: number }) => Promise<unknown>;
  /** Sync memory liveness probe (runtime.state). Undefined = unknown. */
  memoryState: () => string | undefined;
  /** Archive-gap check for the session key. */
  outboxHas: (sessionKey: string) => boolean;
  gate: PiSoulGate;
  generation: number;
  /** Current config bundle text (fresh per request). */
  getSystemPrompt: () => string;
  /**
   * Records the first transform denial of the turn. Pi settles a denied
   * request as an error turn instead of propagating the throw, so the
   * caller surfaces the recorded denial (typed) rather than reporting a
   * successful empty answer.
   */
  onDenied?: (err: unknown) => void;
}

/**
 * Current request system text — one marked bundle envelope plus volatile
 * blocks. Read fresh per request so post-compaction refreshes
 * (setSystemPrompt) take effect on the next provider call without
 * rebuilding the conversation.
 */
export function buildRequestSystemText(
  getSystemPrompt: () => string,
  executionId: string,
  beforeMessageId: number | undefined,
  volatileBlocks: Array<{ kind: string; content: string }>,
): string {
  const base = getSystemPrompt();
  const bundle = base.trim().length > 0
    ? soulBundleEnvelope(base, {
      executionId,
      ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
    })
    : base;
  const parts: string[] = [bundle];
  for (const block of volatileBlocks) {
    if (block.content) {
      const kind = block.kind.replaceAll('"', "'");
      parts.push(`[${block.kind}]\n<volatile_context kind="${kind}">\n${block.content}\n</volatile_context>`);
    }
  }
  return parts.join("\n\n");
}

export function buildSdkTransform(inputs: SdkTransformInputs): (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]> {
  // Record-then-throw: every denial below is observed by the caller.
  const deny = <E extends Error>(err: E): E => {
    try {
      inputs.onDenied?.(err);
    } catch { /* observer isolation; the throw below still surfaces */ }
    return err;
  };
  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    if (signal?.aborted) return [...messages];

    const turnDecision = inputs.safety.beginProviderTurn(inputs.candidateKey);
    if (turnDecision.decision === "stop") {
      logDebug("pi-sdk-transform", `Provider turn stopped: ${turnDecision.reason}`);
      if (turnDecision.reason?.startsWith("Prompt round limit") || inputs.safety.stopped) {
        inputs.safety.requestStop(turnDecision.reason ?? "Provider turn stopped");
        throw deny(new Error(turnDecision.reason ?? "Provider turn stopped"));
      }
    } else if (turnDecision.decision === "pause") {
      logDebug("pi-sdk-transform", "Provider turn paused");
      inputs.safety.requestPause();
      throw deny(new Error("Provider turn paused"));
    }

    const cleanMessages = inputs.safety.scrubClassifiedLiterals(messages);

    // R4: durable admission per request. Same failure semantics as the
    // retired per-prompt projection: sync liveness first (cheap), then the
    // awaited archive probe (history discarded — Pi owns history now), then
    // the archive-gap check, then the soul gate as final authority. A
    // mid-turn abmind loss denies the next request, including tool
    // continuations.
    if (inputs.source.mode === "durable" && !signal?.aborted) {
      if (inputs.memoryState() !== "ready") {
        throw deny(new DurableContextUnavailableError("runtime_unavailable"));
      }
      if (!inputs.contextProvider) {
        throw deny(new DurableContextUnavailableError("no_provider"));
      }
      try {
        const projected = await inputs.projectContext({
          userId: inputs.source.userId,
          sessionId: inputs.source.sessionKey,
          beforeMessageId: inputs.source.beforeMessageId,
          maxContext: inputs.source.maxContext,
        });
        if (!projected || typeof projected !== "object" || !Array.isArray((projected as { messages?: unknown }).messages)) {
          throw deny(new DurableContextUnavailableError("malformed_response"));
        }
      } catch (err) {
        if (signal?.aborted) return [...cleanMessages];
        if (err instanceof DurableContextUnavailableError) throw deny(err);
        throw deny(new DurableContextUnavailableError("provider_rejected", err));
      }
      if (signal?.aborted) return [...cleanMessages];
      if (inputs.outboxHas(inputs.source.sessionKey)) {
        throw deny(new DurableContextUnavailableError("record_failed"));
      }
      inputs.gate.completeHydration(SOUL_HYDRATED, inputs.generation, inputs.generation);
      const decision = inputs.gate.checkRequest(inputs.generation, { abmindAvailable: true, archiveAcknowledged: true });
      if (!decision.admit) {
        logDebug("pi-sdk-transform", `soul gate denies execution ${inputs.executionId}: admission refused (${decision.reason})`);
        throw deny(new DurableContextUnavailableError("hydration_failed"));
      }
    }

    // Request-scoped system bundle replaces the transcript's structural
    // system message per request. Pi history (user/assistant/tool) passes
    // through untouched.
    const systemText = buildRequestSystemText(
      inputs.getSystemPrompt,
      inputs.executionId,
      inputs.source.mode === "durable" ? inputs.source.beforeMessageId : undefined,
      inputs.volatileBlocks,
    );
    const replaced: AgentMessage[] = cleanMessages.map((m) => (
      m.role === "system" ? { ...m, content: systemText } : m
    ));
    if (!replaced.some((m) => m.role === "system")) {
      replaced.unshift({ role: "system", content: systemText, timestamp: Date.now() } as unknown as AgentMessage);
    }
    return replaced;
  };
}
