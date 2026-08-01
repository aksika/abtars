/**
 * scenarios.ts — #1528 Pi production-composition acceptance scenarios.
 *
 * Every scenario drives the built bridge over the real TUI socket and asserts
 * on externally meaningful outcomes: provider requests, TUI replies, child
 * lifecycles, and daemon state. Scenarios never import or construct
 * PiCoreTransport, Spin, MessagePipeline, or the durable-context provider.
 */

import { createHash } from "node:crypto";
import { TIMEOUTS, type PiAcceptanceLane, type ProviderScript, type RequestExpectation } from "./contracts.js";
import { ScriptedProvider } from "./scripted-provider.js";
import { TuiAcceptanceClient } from "./tui-client.js";
import { OwnerControllerClient } from "./controller-client.js";
import { SpawnedChild, waitFor } from "./child-process.js";
import { FIXTURE_MODEL_A, FIXTURE_MODEL_B, MASTER_USER_ID } from "./bridge-config.js";

export interface PiAcceptanceContext {
  lane: PiAcceptanceLane;
  provider: ScriptedProvider;
  owner: OwnerControllerClient;
  tui: TuiAcceptanceClient;
  bridge: SpawnedChild | null;
  runId: string;
  markers: MarkerFactory;
  /** Timestamp captured before scenario messages were recorded (for row assertions). */
  scenarioStart: number;
  /** Kill the exact bridge PID and spawn dist/main.js with the same home/env. */
  restartBridge: () => Promise<SpawnedChild>;
}

export class MarkerFactory {
  private counter = 0;
  private history: string[] = [];

  constructor(private readonly runId: string) {}

  /** Unique synthetic marker: PI-E2E-<prefix>-<runId>-<n>. */
  next(prefix: string): string {
    const marker = `PI-E2E-${prefix}-${this.runId}-${++this.counter}`;
    this.history.push(marker);
    if (this.history.length > 64) this.history.shift();
    return marker;
  }

  /** The most recently created marker. */
  get lastValue(): string {
    const last = this.history.at(-1);
    if (!last) throw new Error("no markers created yet");
    return last;
  }

  /** The last N created markers (for orderedContains across scenarios). */
  lastMarkers(n: number): string[] {
    return this.history.slice(-n);
  }

  hash(marker: string): string {
    return createHash("sha256").update(marker).digest("hex").slice(0, 16);
  }
}

export interface ScenarioOutcome {
  name: string;
  durationMs: number;
  providerRequestIds: string[];
  failure?: { stage: string; code: string; message: string };
}

export interface PiScenario {
  name: string;
  profiles: readonly ("core" | "full")[];
  run(ctx: PiAcceptanceContext): Promise<void>;
}

/** Queue a text reply for a turn with a semantic expectation. */
function textScript(candidate: string, expectation: RequestExpectation | undefined, reply: string): ProviderScript {
  return { candidate, expectation, action: { kind: "text", chunks: [reply] } };
}

/** Assert a received TUI reply contains the scripted reply marker. */
function expectReply(reply: { markdown: string }, expected: string, what: string): void {
  if (!reply.markdown.includes(expected)) {
    throw new Error(`${what}: TUI reply did not contain scripted marker ${expected.slice(0, 60)} (got: ${reply.markdown.slice(0, 200)})`);
  }
}

/** Send one message and assert the scripted reply marker on the SAME reply. */
async function sendExpectReply(tui: TuiAcceptanceClient, text: string, expected: string, what: string): Promise<void> {
  const reply = await tui.sendAndAwaitReply(text);
  expectReply(reply, expected, what);
  await settleBetweenTurns();
}

/**
 * Inter-turn settle: a real user cannot send the next message in the same
 * millisecond the previous reply is delivered. The bridge finishes the
 * previous turn's teardown (assistant persistence, busy release) slightly
 * after delivery; sending immediately races that teardown and the message
 * can be queued behind a turn that has not fully settled.
 */
async function settleBetweenTurns(ms: number = 600): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the provider has observed a request carrying the marker. */
async function waitForProviderMarker(provider: ScriptedProvider, candidate: string, marker: string, timeoutMs: number = TIMEOUTS.turnMs): Promise<void> {
  const hash = createHash("sha256").update(marker).digest("hex").slice(0, 16);
  await waitFor(
    async () => provider.summariesFor(candidate).some((s) => s.markerHashes.includes(hash)),
    timeoutMs,
    `provider request carrying marker ${marker.slice(0, 40)}`,
  );
}

function releaseHold(): { promise: Promise<void>; release: () => void } {
  let releaseFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => { releaseFn = resolve; });
  return { promise, release: releaseFn };
}

// ── Scenario 1: Main continuity and cursor (core) ───────────────────────────

async function mainContinuity(ctx: PiAcceptanceContext): Promise<void> {
  const m1 = ctx.markers.next("U1");
  const a1 = ctx.markers.next("A1");
  const m2 = ctx.markers.next("U2");
  const a2 = ctx.markers.next("A2");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: m1 }, a1));
  await sendExpectReply(ctx.tui, m1, a1, "turn one reply");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: m2,
    orderedContains: [m1, a1],
    exactlyOnce: [m2],
  }, a2));
  await sendExpectReply(ctx.tui, m2, a2, "turn two reply");

  const turnTwo = ctx.provider.summariesFor(FIXTURE_MODEL_A).at(-1);
  if (!turnTwo) throw new Error("no provider requests recorded for turn two");
}

// ── Scenario 2: Tool multi-generation (core) ────────────────────────────────

async function toolMultiGeneration(ctx: PiAcceptanceContext): Promise<void> {
  const m = ctx.markers.next("T1");
  const query = ctx.markers.next("TQ");
  const reply = ctx.markers.next("T2");

  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: m },
    action: { kind: "toolCall", name: "memory_recall", arguments: { query, limit: 5 } },
  });
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: m,
    exactlyOnce: [m],
    noToolBeforeCurrent: true,
  }, reply));

  await sendExpectReply(ctx.tui, m, reply, "post-tool reply");

  const summaries = ctx.provider.summariesFor(FIXTURE_MODEL_A);
  // The toolCall-ACTION request is the one that scripted the call; later
  // generations replay the call in their messages, so match by action.
  const toolSummary = summaries.find((s) => s.action === "toolCall");
  if (!toolSummary) {
    throw new Error(`tool generation never reached the provider (toolCalls seen: ${JSON.stringify(summaries.map((s) => s.toolCalls))})`);
  }
  const postTool = summaries.filter((s) => s.seq > toolSummary.seq).find((s) => s.roleCounts["tool"] !== undefined);
  if (!postTool) {
    throw new Error("no post-tool provider generation observed carrying the tool result");
  }
}

// ── Scenario 3: Reset/rebuild (core) ────────────────────────────────────────

async function resetRebuild(ctx: PiAcceptanceContext): Promise<void> {
  const r1 = ctx.markers.next("R1");
  const a1 = ctx.markers.next("R1A");
  const r2 = ctx.markers.next("R2");
  const a2 = ctx.markers.next("R2A");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: r1 }, a1));
  await ctx.tui.sendAndAwaitReply("/reset");
  // /reset ends the attached session and allocates a fresh Main; re-attach so
  // subsequent messages route to the new session instead of the ended one.
  ctx.tui.close();
  await ctx.tui.connect("resume");
  await sendExpectReply(ctx.tui, r1, a1, "post-reset first reply");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: r2,
    orderedContains: [r1, a1],
    exactlyOnce: [r2],
  }, a2));
  await sendExpectReply(ctx.tui, r2, a2, "post-reset second reply");
}

// ── Scenario 4: Fail closed (core) ──────────────────────────────────────────

async function failClosed(ctx: PiAcceptanceContext): Promise<void> {
  const f1 = ctx.markers.next("F1");
  const a1 = ctx.markers.next("F1A");
  const f2 = ctx.markers.next("F2");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: f1 }, a1));
  await sendExpectReply(ctx.tui, f1, a1, "fail-closed first reply");

  const before = ctx.provider.requestCountFor(FIXTURE_MODEL_A);
  await ctx.owner.stopOwner();
  try {
    await ctx.tui.sendAndAwaitReply(f2, TIMEOUTS.turnMs);
    // A bounded unavailable/error result is expected; a context-blind model
    // answer would have required a provider call.
    const after = ctx.provider.requestCountFor(FIXTURE_MODEL_A);
    if (after !== before) {
      throw new Error(`provider request count changed while owner was down (${before} → ${after}) — fail-closed violated`);
    }
  } catch (err) {
    // The turn may time out if the bridge never surfaces an error; that is
    // acceptable only when no provider request was made.
    const after = ctx.provider.requestCountFor(FIXTURE_MODEL_A);
    if (after !== before) {
      throw new Error(`provider request count changed while owner was down (${before} → ${after}) — fail-closed violated: ${(err as Error).message}`);
    }
  }
}

// ── Scenario 5: Owner recovery (full) ───────────────────────────────────────

async function ownerRecovery(ctx: PiAcceptanceContext): Promise<void> {
  const f3 = ctx.markers.next("F3");
  const a3 = ctx.markers.next("F3A");

  await ctx.owner.restartOwner();

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: f3,
    orderedContains: ctx.markers.lastMarkers(2),
    exactlyOnce: [f3],
  }, a3));
  await sendExpectReply(ctx.tui, f3, a3, "post-recovery reply");
}

// ── Scenario 6: Bridge restart (full) ───────────────────────────────────────

async function bridgeRestart(ctx: PiAcceptanceContext): Promise<void> {
  const b1 = ctx.markers.next("B1");
  const a1 = ctx.markers.next("B1A");
  const b3 = ctx.markers.next("B3");
  const a3 = ctx.markers.next("B3A");
  const preRestart = Date.now() - 1000;

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: b1 }, a1));
  await sendExpectReply(ctx.tui, b1, a1, "pre-restart reply");

  // Terminate the exact bridge PID and boot the production entry point with
  // the same isolated home and owner.
  ctx.bridge = await ctx.restartBridge();

  // Reconnect the TUI client to the restarted bridge.
  ctx.tui.close();
  await ctx.tui.connect("resume");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: b3 }, a3));
  await sendExpectReply(ctx.tui, b3, a3, "post-restart reply");

  // Durable store continuity: the daemon retained the pre-restart transcript
  // under the same user identity (the bridge process is new; its session ids
  // are ephemeral, so the durable proof is the persisted rows).
  const rows = await ctx.owner.conversationRows(MASTER_USER_ID, preRestart, 100);
  const joined = rows.map((r) => r.content).join("\n");
  if (!joined.includes(b1) || !joined.includes(a1)) {
    throw new Error(`pre-restart transcript missing from daemon after bridge restart (${rows.length} rows since ${preRestart})`);
  }
}

// ── Scenario 7: Lazy transport composition (full) ───────────────────────────

async function lazyTransports(ctx: PiAcceptanceContext): Promise<void> {
  // Persistent specialist construction: spawn_session builds a lazy
  // subagent-runtime transport (role task) with the forwarded durable-context
  // holder. A second spawn of the same type reuses the cached transport.
  const goal1 = ctx.markers.next("LZ1");
  const sub1 = ctx.markers.next("LZ1A");
  const goal2 = ctx.markers.next("LZ2");
  const sub2 = ctx.markers.next("LZ2A");
  const goal3 = ctx.markers.next("LZ3");
  const sub3 = ctx.markers.next("LZ3A");

  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: goal1 },
    action: { kind: "toolCall", name: "spawn_session", arguments: { type: "task", goal: goal1 } },
  });
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: goal1,
    noToolBeforeCurrent: true,
  }, sub1));
  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: goal2 },
    action: { kind: "toolCall", name: "spawn_session", arguments: { type: "task", goal: goal2 } },
  });
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: goal2,
    noToolBeforeCurrent: true,
  }, sub2));
  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: goal3 },
    action: { kind: "toolCall", name: "spawn_session", arguments: { type: "task", goal: goal3 } },
  });
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: goal3,
    noToolBeforeCurrent: true,
  }, sub3));

  const main = ctx.markers.next("LZ-M");
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: main,
    exactlyOnce: [main],
  }, ctx.markers.next("LZ-MA")));

  await ctx.tui.sendAndAwaitReply(main);
  // The spawn tool calls run serially inside the main generation; each lazy
  // transport's request must reach the provider with its own marker.
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, goal1);
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, goal2);
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, goal3);
  const lazyReply = await ctx.tui.awaitMessage(TIMEOUTS.turnMs);
  expectReply(lazyReply, ctx.markers.lastValue, "lazy spawns final reply");
  await settleBetweenTurns();

  // One-shot ephemeral execution stays operable without durable projection:
  // the second task-type spawn must NOT project the first spawn's exchange.
  const goal2Summary = ctx.provider.summariesFor(FIXTURE_MODEL_A).find((s) => s.markerHashes.includes(ctx.markers.hash(goal2)));
  if (!goal2Summary) throw new Error("lazy task transport request for goal2 missing");
  const goal3Summary = ctx.provider.summariesFor(FIXTURE_MODEL_A).find((s) => s.markerHashes.includes(ctx.markers.hash(goal3)));
  if (!goal3Summary) throw new Error("lazy task transport request for goal3 missing");
}

// ── Scenario 8: Steer/follow-up (full) ──────────────────────────────────────

async function steerFollowUp(ctx: PiAcceptanceContext): Promise<void> {
  const s1 = ctx.markers.next("S1");
  const steer1 = ctx.markers.next("ST1");
  const steer2 = ctx.markers.next("ST2");
  const a1 = ctx.markers.next("S1A");
  const s2 = ctx.markers.next("S2");
  const a2 = ctx.markers.next("S2A");

  const hold1 = releaseHold();
  ctx.provider.enqueue({ candidate: FIXTURE_MODEL_A, expectation: { candidate: FIXTURE_MODEL_A, currentTurn: s1 }, action: { kind: "hold", release: hold1.promise } });

  await ctx.tui.sendAndAwaitReply(s1);
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, s1);

  // Steer 1 is delivered to the active host; the held request is aborted.
  const ack1 = await ctx.tui.steer(steer1);
  if (ack1.status === "rejected") throw new Error(`steer 1 rejected: ${ack1.message}`);
  hold1.release();

  const hold2 = releaseHold();
  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: s1, orderedContains: [s1, steer1] },
    action: { kind: "hold", release: hold2.promise },
  });
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, steer1);

  // Steer 2 is queued while a generation is active (one-at-a-time).
  const ack2 = await ctx.tui.steer(steer2);
  if (ack2.status === "rejected") throw new Error(`steer 2 rejected: ${ack2.message}`);
  hold2.release();

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: s1,
    orderedContains: [s1, steer1, steer2],
  }, a1));
  const steered = await ctx.tui.awaitMessage(TIMEOUTS.turnMs);
  expectReply(steered, a1, "steered generation reply");
  await settleBetweenTurns();

  // Follow-up user turn: the steered exchange must be part of the durable
  // baseline recorded by the pipeline.
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: s2,
    orderedContains: [s1, a1],
    exactlyOnce: [s2],
  }, a2));
  await sendExpectReply(ctx.tui, s2, a2, "follow-up reply");
}

// ── Scenario 9: Fallback (full) ─────────────────────────────────────────────

async function fallback(ctx: PiAcceptanceContext): Promise<void> {
  const fb0 = ctx.markers.next("FB0");
  const fb0a = ctx.markers.next("FB0A");
  const fb1 = ctx.markers.next("FB1");
  const fb1a = ctx.markers.next("FB1A");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: fb0 }, fb0a));
  await sendExpectReply(ctx.tui, fb0, fb0a, "fallback baseline reply");

  ctx.provider.enqueue({ candidate: FIXTURE_MODEL_A, expectation: { candidate: FIXTURE_MODEL_A, currentTurn: fb1 }, action: { kind: "httpError", status: 500, code: "fixture_transient" } });
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_B, {
    candidate: FIXTURE_MODEL_B,
    currentTurn: fb1,
    orderedContains: [fb0, fb0a],
    exactlyOnce: [fb1],
  }, fb1a));

  await sendExpectReply(ctx.tui, fb1, fb1a, "fallback reply");
  const fbSummary = ctx.provider.summariesFor(FIXTURE_MODEL_B).at(-1);
  if (!fbSummary) throw new Error("candidate B never served the fallback turn");
}

// ── Scenario 10: Model switch (full) ────────────────────────────────────────

async function modelSwitch(ctx: PiAcceptanceContext): Promise<void> {
  const m1 = ctx.markers.next("M1");
  const a1 = ctx.markers.next("M1A");
  const m2 = ctx.markers.next("M2");
  const a2 = ctx.markers.next("M2A");

  await ctx.tui.sendAndAwaitReply(`/models quick ${FIXTURE_MODEL_B}`);
  await ctx.tui.sendAndAwaitReply("/reset");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_B, { candidate: FIXTURE_MODEL_B, currentTurn: m1 }, a1));
  await sendExpectReply(ctx.tui, m1, a1, "switched-model first reply");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_B, {
    candidate: FIXTURE_MODEL_B,
    currentTurn: m2,
    orderedContains: [m1, a1],
    exactlyOnce: [m2],
  }, a2));
  await sendExpectReply(ctx.tui, m2, a2, "switched-model second reply");
}

// ── Scenario 11: Cancellation/deadline (full) ───────────────────────────────

async function cancellation(ctx: PiAcceptanceContext): Promise<void> {
  const c1 = ctx.markers.next("C1");
  const c2 = ctx.markers.next("C2");
  const a2 = ctx.markers.next("C2A");

  const hold = releaseHold();
  ctx.provider.enqueue({ candidate: FIXTURE_MODEL_A, expectation: { candidate: FIXTURE_MODEL_A, currentTurn: c1 }, action: { kind: "hold", release: hold.promise } });

  await ctx.tui.sendAndAwaitReply(c1);
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, c1);
  const held = ctx.provider.summariesFor(FIXTURE_MODEL_A).at(-1);
  if (!held) throw new Error("held request summary missing");

  await ctx.tui.sendAndAwaitReply("/stop");

  // The held provider connection must observe the abort.
  await waitFor(
    async () => held.aborted,
    TIMEOUTS.holdSettleMs,
    "held provider request abort",
  );

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: c2,
    orderedContains: [c1],
    exactlyOnce: [c2],
  }, a2));
  await sendExpectReply(ctx.tui, c2, a2, "post-cancel reply");

  // No orphan requests: the only requests since the held one are the turn
  // that settled the cancel and the successful continuation.
  const since = ctx.provider.summaries.filter((s) => s.seq > held.seq);
  if (since.some((s) => s.action === "unscripted" || s.action === "expectation_failed")) {
    throw new Error("orphan or unscripted provider request after cancellation");
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

export const PI_SCENARIOS: PiScenario[] = [
  { name: "main-continuity-and-cursor", profiles: ["core", "full"], run: mainContinuity },
  { name: "tool-multi-generation", profiles: ["core", "full"], run: toolMultiGeneration },
  { name: "reset-rebuild", profiles: ["core", "full"], run: resetRebuild },
  { name: "fail-closed-provider-suppression", profiles: ["core", "full"], run: failClosed },
  { name: "owner-recovery", profiles: ["full"], run: ownerRecovery },
  { name: "bridge-restart", profiles: ["full"], run: bridgeRestart },
  { name: "lazy-transport-composition", profiles: ["full"], run: lazyTransports },
  { name: "steer-followup", profiles: ["full"], run: steerFollowUp },
  { name: "candidate-fallback", profiles: ["full"], run: fallback },
  { name: "model-switch", profiles: ["full"], run: modelSwitch },
  { name: "cancellation-deadline", profiles: ["full"], run: cancellation },
];

export function scenariosForProfile(profile: "core" | "full"): PiScenario[] {
  return PI_SCENARIOS.filter((s) => s.profiles.includes(profile));
}
