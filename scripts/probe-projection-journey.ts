/**
 * probe-projection-journey.ts — #1527 escaped-regression consumer journey,
 * re-pointed at the #1932 SDK transform contract.
 *
 * Runs against a REAL abmind daemon (local Unix or signed WSS) through the
 * REAL abtars memory runtime and the REAL request-scoped SDK transform.
 * Records a recognizable first exchange plus a second current turn, then
 * proves:
 *   1. the transform admits the request and attaches exactly one marked
 *      bundle (system message replaced request-scoped);
 *   2. Pi history passes through byte-identical — the archive is NEVER
 *      reconstructed into provider requests on the intact path (R9);
 *   3. removing the provider fails the same journey before model invocation.
 */
import { createDurableContextProvider, DurableContextUnavailableError } from "../src/components/transport/pi-core-context.js";
import { buildSdkTransform } from "../src/components/transport/pi-sdk-transform.js";
import { createPiExecutionSafetyController } from "../src/components/transport/pi-core-safety.js";
import { PiSoulGate } from "../src/components/pi-session/pi-soul-gate.js";
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
  // Pi-owned history as the agent loop would hold it (structural system
  // entry plus the live transcript — never archive reconstruction).
  const history = [
    { role: "system", content: "structural", timestamp: Date.now() - 3000 },
    { role: "user", content: "probe second user turn", timestamp: Date.now() },
  ];
  const gate = new PiSoulGate();
  gate.beginSession();
  const transform = buildSdkTransform({
    safety: createPiExecutionSafetyController(),
    source: { mode: "durable", sessionKey: sessionId, beforeMessageId: current.id, maxContext: 100_000, userId: user },
    volatileBlocks: [],
    executionId: `${runId}-exec`,
    candidateKey: "probe@probe",
    contextProvider: provider,
    projectContext: (input) => provider.projectContext(input),
    memoryState: () => runtime.state,
    outboxHas: () => false,
    gate,
    generation: 1,
    getSystemPrompt: () => "probe bundle",
  });

  // New contract: admission succeeds, exactly one marked bundle is attached
  // request-scoped, and history passes through byte-identical.
  const result = await transform(history as never, undefined);
  const system = result.find((m) => (m as { role?: string }).role === "system") as { content?: unknown } | undefined;
  const systemText = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content);
  if (!systemText.includes("probe bundle")) {
    failures.push(`request system missing the bundle: ${systemText.slice(0, 200)}`);
  }
  const nonSystem = result.filter((m) => (m as { role?: string }).role !== "system");
  if (nonSystem.length !== 1 || JSON.stringify(nonSystem[0]) !== JSON.stringify(history[1])) {
    failures.push(`Pi history not passed through byte-identical: ${JSON.stringify(nonSystem).slice(0, 300)}`);
  }
  const texts = result.map((m) => JSON.stringify((m as { content?: unknown }).content));
  if (texts.some((t) => t.includes("probe first user turn") || t.includes("probe first assistant turn"))) {
    failures.push(`archive history reconstructed into the request (R9 violation): ${JSON.stringify(texts).slice(0, 300)}`);
  }

  // Fail-closed: without a provider, the same journey must fail before model
  // invocation — never a plausible suffix-only answer.
  const gate2 = new PiSoulGate();
  gate2.beginSession();
  const denied = buildSdkTransform({
    safety: createPiExecutionSafetyController(),
    source: { mode: "durable", sessionKey: sessionId, beforeMessageId: current.id, maxContext: 100_000, userId: user },
    volatileBlocks: [],
    executionId: `${runId}-exec`,
    candidateKey: "probe@probe",
    projectContext: async () => { throw new Error("must not probe without a provider"); },
    memoryState: () => runtime.state,
    outboxHas: () => false,
    gate: gate2,
    generation: 1,
    getSystemPrompt: () => "probe bundle",
  });
  try {
    await denied(history as never, undefined);
    failures.push("durable transform without a provider should have thrown");
  } catch (err) {
    if (!(err instanceof DurableContextUnavailableError)) {
      failures.push(`expected DurableContextUnavailableError, got ${(err as Error).name}: ${(err as Error).message}`);
    }
  }
}
