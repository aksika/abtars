/**
 * probe-projection-journey.ts — #1527 escaped-regression consumer journey.
 *
 * Runs against a REAL abmind daemon (local Unix or signed WSS) through the
 * REAL abtars memory runtime and REAL Pi context projection. Records a
 * recognizable first exchange plus a second current turn, then proves:
 *   1. the second Pi provider request contains the first exchange exactly,
 *   2. the current turn is appended exactly once,
 *   3. removing the provider fails the same journey before model invocation.
 */
import { createDurableContextProvider, PiCoreContextProjection, DurableContextUnavailableError } from "../src/components/transport/pi-core-context.js";
import type { AbtarsMemoryRuntime } from "../src/components/memory-runtime.js";

export async function runProjectionJourney(runtime: AbtarsMemoryRuntime, user: string, runId: string, failures: string[]): Promise<void> {
  if (!runtime.supports("durableContext")) {
    failures.push("durableContext capability not advertised after negotiation");
    return;
  }

  const sessionId = `${runId}-probe-session`;
  const m1 = await runtime.recordMessage(
    { userId: user, sessionId, role: "user", content: "probe first user turn", timestamp: Date.now() - 2000 },
    `${runId}-probe-msg-1`,
  );
  const m2 = await runtime.recordMessage(
    { userId: user, sessionId, role: "assistant", content: "probe first assistant turn", timestamp: Date.now() - 1000 },
    `${runId}-probe-msg-2`,
  );
  const current = await runtime.recordMessage(
    { userId: user, sessionId, role: "user", content: "probe second user turn", timestamp: Date.now() },
    `${runId}-probe-msg-3`,
  );
  if (m1.id == null || m2.id == null || current.id == null || !(current.id > m2.id && m2.id > m1.id)) {
    failures.push(`recorded message ids not strictly ordered: ${m1.id} < ${m2.id} < ${current.id}`);
    return;
  }

  const provider = createDurableContextProvider(runtime);
  const marker = {
    role: "abtars_current_turn" as const,
    executionId: `${runId}-exec`,
    sessionId,
    content: "probe second user turn",
    timestamp: Date.now(),
  };
  const seed = {
    source: { mode: "durable" as const, sessionKey: sessionId, beforeMessageId: current.id, maxContext: 100_000, userId: user },
    executionId: `${runId}-exec`,
    currentTurn: marker,
    volatileBlocks: [],
  };
  const projection = new PiCoreContextProjection(seed, "system");

  // Escaped regression: the second Pi provider request must contain the first
  // exchange and exactly one second turn.
  const result = await projection.transform([marker as never], { hostGeneration: 0, contextProvider: provider });
  const texts = result.messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    return typeof content === "string" ? content : JSON.stringify(content);
  });
  if (!texts.some((t) => t === "probe first user turn") || !texts.some((t) => t.includes("probe first assistant turn"))) {
    failures.push(`projection missing the first exchange: ${JSON.stringify(texts)}`);
  }
  if (texts.filter((t) => t === "probe second user turn").length !== 1) {
    failures.push(`current turn not appended exactly once: ${JSON.stringify(texts)}`);
  }

  // Fail-closed: without a provider, the same journey must fail before model
  // invocation — never a plausible suffix-only answer.
  try {
    await projection.transform([marker as never], { hostGeneration: 0 });
    failures.push("durable projection without a provider should have thrown");
  } catch (err) {
    if (!(err instanceof DurableContextUnavailableError)) {
      failures.push(`expected DurableContextUnavailableError, got ${(err as Error).name}: ${(err as Error).message}`);
    }
  }
}
