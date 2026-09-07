/**
 * scenarios.ts — #1528 Pi production-composition acceptance scenarios.
 *
 * Every scenario drives the built bridge over the real TUI socket and asserts
 * on externally meaningful outcomes: provider requests, TUI replies, child
 * lifecycles, and daemon state. Scenarios never import or construct
 * PiCoreTransport, Spin, MessagePipeline, or the durable-context provider.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { TIMEOUTS, type PiAcceptanceLane, type ProviderScript, type RequestExpectation, type ProviderSummary } from "./contracts.js";
import { ScriptedProvider } from "./scripted-provider.js";
import { TuiAcceptanceClient } from "./tui-client.js";
import { OwnerControllerClient } from "./controller-client.js";
import { SpawnedChild, waitFor } from "./child-process.js";
import { FIXTURE_MODEL_A, FIXTURE_MODEL_B, MASTER_USER_ID } from "./bridge-config.js";
import { scheduledOrcRoundLimit, scheduledOrcRoundLimitRestart } from "./scheduled-orc-round-limit.js";

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
  /** Kill the exact bridge PID and spawn bundle/abtars.js with the same home/env. */
  restartBridge: () => Promise<SpawnedChild>;
  /** #1776: bounded bridge-log tail (re-read from disk on every call). */
  readBridgeLog: () => string;
  /** #1548: isolated abtars home the bridge reads/writes (tasks, state, kanban). */
  abtarsHome: string;
  /** #1548: bounded artifact persistence through the result writer. */
  writeArtifact: (name: string, data: string) => void;
  /** #1528: last successfully persisted exchange (set by fail-closed, asserted by recovery). */
  durableHistory?: string[];
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
  profiles: readonly ("core" | "full" | "proof" | "hydration")[];
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
  await waitFor(
    // Substring match against the bounded synthetic user texts: the bridge
    // wraps markers in decorations (timestamp prefix, steering instructions)
    // that break exact-hash equality.
    async () => provider.summariesFor(candidate).some((s) => s.markerTexts.some((t) => t.includes(marker))),
    timeoutMs,
    `provider request carrying marker ${marker.slice(0, 40)}`,
  );
}

/**
 * Wait until the provider has observed a request carrying the marker on
 * either fixture candidate and return that request's summary. The lane's
 * session model is not static: after the serial model-switch scenario the
 * config remains on fixture-model-b, otherwise the lane is on
 * fixture-model-a. The request lands on exactly one of them.
 */
async function waitForHeldMarkerSummary(provider: ScriptedProvider, marker: string, timeoutMs: number = TIMEOUTS.turnMs): Promise<ProviderSummary> {
  return waitFor(
    async () => {
      for (const candidate of [FIXTURE_MODEL_A, FIXTURE_MODEL_B]) {
        const summaries = provider.summariesFor(candidate);
        for (let i = summaries.length - 1; i >= 0; i--) {
          const s = summaries[i]!;
          if (s.markerTexts.some((t) => t.includes(marker))) return s;
        }
      }
      return undefined;
    },
    timeoutMs,
    `provider request carrying marker ${marker.slice(0, 40)}`,
  );
}

function releaseHold(): { promise: Promise<void>; release: () => void } {
  let releaseFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => { releaseFn = resolve; });
  return { promise, release: releaseFn };
}

/** The bounded production reply for a fail-closed durable turn (#1529). */
const UNAVAILABLE_REPLY = "Memory context is temporarily unavailable. Please retry.";

/**
 * Send a durable turn that may fail closed while the bridge renegotiates
 * memory after an owner or bridge restart. On the bounded unavailability
 * reply (the production response itself tells the user to retry), wait and
 * retry with a fresh marker; the final attempt MUST reach the provider with
 * the requested durable history — bounded, evidence-based readiness, never a
 * fixed sleep. Failed attempts make no provider request and persist nothing.
 */
async function sendWithRecoveryRetry(
  ctx: PiAcceptanceContext,
  prefix: string,
  makeScript: (marker: string) => ProviderScript,
  replyMarker: string,
  what: string,
  attempts = 12,
): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const marker = ctx.markers.next(attempt === 1 ? prefix : `${prefix}R`);
    ctx.provider.enqueue(makeScript(marker));
    const reply = await ctx.tui.sendAndAwaitReply(marker, TIMEOUTS.turnMs);
    if (reply.markdown.includes(replyMarker)) {
      await settleBetweenTurns();
      return marker;
    }
    if (reply.markdown.includes(UNAVAILABLE_REPLY) && attempt < attempts) {
      await settleBetweenTurns(1500);
      continue;
    }
    throw new Error(`${what}: TUI reply did not contain scripted marker ${replyMarker.slice(0, 60)} (got: ${reply.markdown.slice(0, 200)})`);
  }
  throw new Error(`${what}: bridge never reached memory readiness after ${attempts} attempts`);
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

  // #1780: fragmented argument JSON must arrive intact at the real tool
  // boundary. The fixture streams the args across multiple SSE deltas through
  // the real Pi parser; the audit sink records the decoded args the tool
  // actually received. The unique query marker isolates this turn's entry.
  // A lost, duplicated, or malformed fragment drifts the decoded query and
  // fails here even when a post-tool continuation still occurs.
  const observedArgs = await waitFor(
    async () => {
      let raw: string;
      try {
        raw = readFileSync(join(ctx.abtarsHome, "logs", "audit.jsonl"), "utf-8");
      } catch {
        return undefined;
      }
      for (const line of raw.trim().split("\n").reverse()) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (entry["tool"] !== "memory_recall") continue;
        const argsRaw = entry["args"];
        if (typeof argsRaw !== "string") continue;
        let decoded: Record<string, unknown>;
        try {
          decoded = JSON.parse(argsRaw) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (decoded["query"] !== query) continue;
        return decoded;
      }
      return undefined;
    },
    15_000,
    `audit entry for fragmented memory_recall query ${query.slice(0, 40)}`,
  );
  if (observedArgs["query"] !== query || observedArgs["limit"] !== 5) {
    throw new Error(
      `fragmented tool arguments drifted at the tool boundary: expected ${JSON.stringify({ query, limit: 5 }).slice(0, 200)} (got ${JSON.stringify(observedArgs).slice(0, 300)})`,
    );
  }
}

// ── Scenario 2b: Tool policy denial (proof) — #1775 ─────────────────────────

/**
 * A forbidden bridge-spawning command must be rejected by the production
 * self-protection guard before any process is created, surfacing as a
 * structured policy rejection that the turn then continues past normally.
 */
async function toolPolicyDenial(ctx: PiAcceptanceContext): Promise<void> {
  const m = ctx.markers.next("PD1");
  const reply = ctx.markers.next("PD1A");
  const deniedCommand = "node main.js";

  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: m },
    action: { kind: "toolCall", name: "execute_bash", arguments: { command: deniedCommand } },
  });
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: m,
    exactlyOnce: [m],
  }, reply));

  // Summaries accumulate lane-wide: scope every lookup below to requests
  // made after this turn starts, so an earlier scenario's tool pair can
  // never satisfy this scenario's assertions.
  const baselineSeq = Math.max(0, ...ctx.provider.summaries.map((s) => s.seq));
  await sendExpectReply(ctx.tui, m, reply, "post-denial reply");

  const summaries = ctx.provider.summariesFor(FIXTURE_MODEL_A).filter((s) => s.seq > baselineSeq);
  const toolSummary = summaries.find((s) => s.action === "toolCall");
  if (!toolSummary) {
    throw new Error(`denied tool call never reached the provider (toolCalls seen: ${JSON.stringify(summaries.map((s) => s.toolCalls))})`);
  }
  const postTool = summaries.filter((s) => s.seq > toolSummary.seq).find((s) => s.roleCounts["tool"] !== undefined);
  if (!postTool) {
    throw new Error("no post-denial provider generation observed carrying the tool result");
  }
  if (!postTool.toolCalls.includes("execute_bash")) {
    throw new Error(`post-denial generation does not carry the denied call (toolCalls seen: ${JSON.stringify(postTool.toolCalls)})`);
  }

  // Correlate the audit invocation + completion entries by call id. The
  // invocation carries the redacted argument string; the completion must
  // carry the structured policy rejection and no successful completion for
  // this call may exist.
  const completions = await waitFor(
    async () => {
      let raw: string;
      try {
        raw = readFileSync(join(ctx.abtarsHome, "logs", "audit.jsonl"), "utf-8");
      } catch {
        return undefined;
      }
      const invocationIds = new Set<string>();
      const found: Array<{ callId: string; status: unknown; error: unknown }> = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (entry["tool"] !== "execute_bash") continue;
        const callId = entry["call_id"];
        if (typeof callId !== "string") continue;
        if (entry["args"] !== undefined) {
          let decoded: Record<string, unknown> | null = null;
          try {
            decoded = JSON.parse(entry["args"] as string) as Record<string, unknown>;
          } catch {
            decoded = null;
          }
          if (decoded?.["command"] === deniedCommand) invocationIds.add(callId);
        } else if (entry["status"] !== undefined) {
          found.push({ callId, status: entry["status"], error: entry["error"] });
        }
      }
      if (invocationIds.size === 0) return undefined;
      const ours = found.filter((c) => invocationIds.has(c.callId));
      return ours.length > 0 ? ours : undefined;
    },
    15_000,
    `audit completion for denied execute_bash ${deniedCommand}`,
  );
  for (const c of completions) {
    if (c.status !== "error") {
      throw new Error(`denied execute_bash completion is not an error (call ${c.callId}, status=${JSON.stringify(c.status)})`);
    }
    if (c.error !== "policy_rejected") {
      throw new Error(`denied execute_bash completion is not a policy rejection (call ${c.callId}, error=${JSON.stringify(c.error)})`);
    }
  }

  ctx.writeArtifact("tool-policy-denial.json", JSON.stringify({
    schemaVersion: 1,
    kind: "pi-boundary-proof",
    runId: ctx.runId,
    lane: ctx.lane,
    piVersion: "0.85.1",
    route: "pi-ai",
    tuiSessionId: ctx.tui.sessionId,
    scenario: "tool-policy-denial",
    markerHashes: [ctx.markers.hash(m), ctx.markers.hash(reply)],
    providerRequestIds: [String(toolSummary.seq), String(postTool.seq)],
    assertions: { denialError: "policy_rejected", completions: completions.length },
  }, null, 2));
}

// ── Scenario 2c: Durable compaction (proof) — #1775 ─────────────────────────

/** Bounded deterministic long reply: the marker plus filler, exactly N chars. */
function longProofReply(marker: string, chars: number): string {
  const filler = "0123456789abcdef";
  const repeats = Math.max(0, Math.ceil((chars - marker.length - 1) / filler.length));
  return `${marker}\n${filler.repeat(repeats)}`.slice(0, chars);
}

/**
 * Five large normal turns followed by manual /compact must produce a durable
 * checkpoint that the next turn's projected context consumes — without making
 * Pi's transcript a second durable authority and without duplicating rows.
 */
async function durableCompaction(ctx: PiAcceptanceContext): Promise<void> {
  const since = Date.now();
  const turnMarkers: string[] = [];
  const replyMarkers: string[] = [];

  for (let i = 1; i <= 5; i++) {
    const m = ctx.markers.next(`CC${i}`);
    const a = ctx.markers.next(`CC${i}A`);
    turnMarkers.push(m);
    replyMarkers.push(a);
    ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
      candidate: FIXTURE_MODEL_A,
      currentTurn: m,
      exactlyOnce: [m],
    }, longProofReply(a, 24_000)));
    await sendExpectReply(ctx.tui, m, a, `compaction turn ${i} reply`);
  }

  // The summarizer request shape is owned by the production compaction flow,
  // so its script carries no request expectation — FIFO serves it. A stale or
  // missing summary fails closed at the post-compaction expectation below.
  const summary = ctx.markers.next("CSUM");
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, undefined, summary));

  const compactReply = await ctx.tui.sendAndAwaitReply("/compact");
  if (!compactReply.markdown.includes("Compaction complete")) {
    throw new Error(`manual /compact did not complete (got: ${compactReply.markdown.slice(0, 200)})`);
  }
  await settleBetweenTurns();

  const pm = ctx.markers.next("PC1");
  const pa = ctx.markers.next("PC1A");
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: pm,
    orderedContains: [summary],
    exactlyOnce: [pm],
  }, pa));
  await sendExpectReply(ctx.tui, pm, pa, "post-compaction reply");

  // Durable history: exactly one user row per turn marker and one assistant
  // row per reply marker since this scenario started; no foreign proof
  // marker may have entered the owner's history in that window. A missing
  // row on the first read is retried boundedly (read transient — e.g. a
  // checkpoint-commit lock coinciding with the query); duplicate or foreign
  // rows fail immediately since they cannot be timing artifacts. The final
  // failure carries query diagnostics.
  let rows = await ctx.owner.conversationRows(MASTER_USER_ID, since, 200);
  const missingMarkers = () => turnMarkers.filter(
    (m) => !rows.some((r) => r.role === "user" && r.content.includes(m)),
  );
  for (let attempt = 1; attempt <= 5 && missingMarkers().length > 0; attempt++) {
    await settleBetweenTurns(2000);
    rows = await ctx.owner.conversationRows(MASTER_USER_ID, since, 200);
  }
  const ours = new Set([...turnMarkers, ...replyMarkers, summary, pm, pa]);
  for (const row of rows) {
    for (const marker of row.content.match(/PI-E2E-[A-Za-z0-9-]+/g) ?? []) {
      if (!ours.has(marker)) {
        throw new Error(`foreign proof marker in durable history: ${marker.slice(0, 60)}`);
      }
    }
  }
  for (const m of turnMarkers) {
    const hits = rows.filter((r) => r.role === "user" && r.content.includes(m));
    if (hits.length !== 1) {
      const roles = [...new Set(rows.map((r) => r.role))].join(",");
      const foundMarkers = turnMarkers.filter((t) => rows.some((r) => r.content.includes(t)));
      throw new Error(
        `turn marker ${m.slice(0, 40)} has ${hits.length} user rows, expected exactly 1 ` +
        `(rows=${rows.length} roles=[${roles}] since=${since} markersFound=${foundMarkers.length}/5)`,
      );
    }
  }
  for (const a of replyMarkers) {
    const hits = rows.filter((r) => r.role === "assistant" && r.content.includes(a));
    if (hits.length !== 1) throw new Error(`reply marker ${a.slice(0, 40)} has ${hits.length} assistant rows, expected exactly 1`);
  }

  ctx.writeArtifact("durable-compaction.json", JSON.stringify({
    schemaVersion: 1,
    kind: "pi-boundary-proof",
    runId: ctx.runId,
    lane: ctx.lane,
    piVersion: "0.85.1",
    route: "pi-ai",
    tuiSessionId: ctx.tui.sessionId,
    scenario: "durable-compaction",
    markerHashes: [...turnMarkers, ...replyMarkers].map((mk) => ctx.markers.hash(mk)),
    providerRequestIds: [],
    assertions: { turns: 5, replyChars: 24_000, durableRows: rows.length, compactResult: "complete" },
  }, null, 2));
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

// ── Scenario: session-start hydration (#1776, hydration profile) ─────────────

function countLinesWith(text: string, needle: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.includes(needle)) count++;
  }
  return count;
}

async function sessionStartHydration(ctx: PiAcceptanceContext): Promise<void> {
  // Unique-per-run markers. User sides are never truncated; assistant sides
  // are short enough to survive head/tail truncation.
  const tag = (s: string): string => `HYD-${s}-${ctx.runId}`;
  const pairUser = (i: number): string => `${tag(`U${i}`)} continuity probe alpha beta`;
  const pairAsst = (i: number): string => `${tag(`A${i}`)} acknowledged`;
  const dailyMarker = tag("DAILY");
  const weeklyMarker = tag("WEEKLY");
  const foreignMarker = tag("FOREIGN");

  // 1. Atomic fixture seed: ten complete pairs + fresh daily + weekly + one
  // foreign-user marker. The seed replaces the primary user's rows (the
  // runner's smoke turns wrote earlier rows), so the floor is exactly the
  // ten seeded pairs.
  await ctx.owner.seedHydrationFixture({
    userId: MASTER_USER_ID,
    pairs: Array.from({ length: 10 }, (_, i) => ({ user: pairUser(i), assistant: pairAsst(i) })),
    daily: `# ${dailyMarker}\n\nContinuity summary for hydration acceptance.`,
    weekly: `# ${weeklyMarker}\n\nWeekly rollup for hydration acceptance.`,
    foreignUserId: "e2e-user-b",
    foreignContent: `${foreignMarker} another user's turn`,
  });

  // Baseline log evidence before the fresh lifecycle starts.
  const daemonBaseline = countLinesWith(await ctx.owner.daemonLogTail(), "[session-context]");
  const bridgeBaselineStates = countLinesWith(ctx.readBridgeLog(), "session-state:");
  const bridgeBaselineAssembly = countLinesWith(ctx.readBridgeLog(), "session-assembly:");

  // 2. Fresh Main/A lifecycle after setup: the runner's smoke turn must not
  // satisfy the hydration assertion. Assembly order is consolidation-first,
  // then chronological pairs, so the chain leads with daily/weekly.
  const probe1 = ctx.markers.next("H1");
  const reply1 = ctx.markers.next("H1A");
  const floorChain = [2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => [pairUser(i), pairAsst(i)]);
  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: {
      candidate: FIXTURE_MODEL_A,
      containsInOrder: [dailyMarker, weeklyMarker, ...floorChain],
      excludes: [foreignMarker],
      currentTurn: probe1,
    },
    action: { kind: "text", chunks: [reply1] },
  });
  await ctx.tui.sendAndAwaitReply("/reset");
  // Re-attach with a brand-new session: `resume` would reattach to the
  // most-recently-active ready session, which is not deterministically the
  // fresh Main. A new attach guarantees the probe is the lifecycle's first
  // turn. The id rotation proves the lifecycle is actually fresh.
  const preResetSession = ctx.tui.sessionId;
  ctx.tui.close();
  await ctx.tui.connect("new");
  if (ctx.tui.sessionId === null || ctx.tui.sessionId === preResetSession) {
    throw new Error(`fresh lifecycle requires a rotated session id (was ${preResetSession}, now ${ctx.tui.sessionId})`);
  }
  await sendExpectReply(ctx.tui, probe1, reply1, "hydration probe reply");

  // 3. One following ordinary turn: succeeds, hydrates nothing new. Durable
  // Pi projection may retain hydrated markers, so the second request is
  // never scanned for their absence.
  const probe2 = ctx.markers.next("H2");
  const reply2 = ctx.markers.next("H2A");
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: probe2 }, reply2));
  await sendExpectReply(ctx.tui, probe2, reply2, "post-hydration ordinary reply");

  // 4. Lifecycle uniqueness from bounded log evidence. The bridge logger
  // buffers, so poll until the flushed lines arrive or the deadline hits —
  // a missing prerequisite fails here, never passes as a skip.
  await waitFor(
    async () => {
      const bridge = ctx.readBridgeLog();
      const newStates = bridge.split("\n").filter((l) => l.includes("session-state:")).slice(bridgeBaselineStates);
      const newAssemblies = bridge.split("\n").filter((l) => l.includes("session-assembly:")).slice(bridgeBaselineAssembly);
      const trues = newStates.filter((l) => l.includes("isSessionStart=true"));
      const falses = newStates.filter((l) => l.includes("isSessionStart=false"));
      const oks = newAssemblies.filter((l) => l.includes("outcome=ok"));
      if (trues.length === 1 && falses.length === 1 && oks.length === 1 && newAssemblies.length === 1) {
        return { trues: trues.length, falses: falses.length, oks: oks.length };
      }
      return undefined;
    },
    75000,
    "hydration lifecycle bridge evidence (1 session-start, 1 assembly, then ordinary)",
  );

  // Daemon evidence: exactly one history-enabled assembly for the lifecycle.
  const daemonTail = await ctx.owner.daemonLogTail();
  const newDiags = daemonTail.split("\n").filter((l) => l.includes("[session-context]")).slice(daemonBaseline);
  if (newDiags.length !== 1) {
    throw new Error(`expected exactly 1 session-context diagnostic for the fresh lifecycle, saw ${newDiags.length}`);
  }
  const diag = newDiags[0]!;
  const scalar = (name: string): number => {
    const m = diag.match(new RegExp(`${name}=(\\d+)`));
    if (!m) throw new Error(`diagnostic missing ${name}: ${diag.slice(0, 160)}`);
    return parseInt(m[1]!, 10);
  };
  const modelContextTokens = scalar("modelContextTokens");
  const historyBudgetChars = scalar("historyBudgetChars");
  const usedChars = scalar("usedChars");
  const daemonPairs = scalar("pairs");
  const daemonDailies = scalar("dailies");
  const daemonWeeklies = scalar("weeklies");
  // The fixture model window is 128k: full-window forwarding with a single
  // 5% application yields 6,400 (a 15%-prescaled window would yield 960).
  if (modelContextTokens !== 128000) {
    throw new Error(`expected full 128000-token model window forwarded, saw ${modelContextTokens}`);
  }
  if (historyBudgetChars !== 6400) {
    throw new Error(`expected single 6,400-char history budget, saw ${historyBudgetChars}`);
  }
  if (daemonPairs < 8 || daemonDailies < 1 || daemonWeeklies < 1) {
    throw new Error(`expected floor evidence pairs>=8 dailies>=1 weeklies>=1, saw ${daemonPairs}/${daemonDailies}/${daemonWeeklies}`);
  }

  // 5. Bounded content-free artifact: scalars and hashes only.
  const requestIds = ctx.provider.summaries.map((s) => `seq${s.seq}`);
  ctx.writeArtifact("session-start-hydration.json", JSON.stringify({
    scenario: "session-start-hydration",
    lane: ctx.lane,
    floorPairsObserved: 8,
    dailiesObserved: daemonDailies,
    weekliesObserved: daemonWeeklies,
    daemonPairs,
    modelContextTokens,
    historyBudgetChars,
    usedChars,
    providerRequestIds: requestIds,
    sessionStates: ["isSessionStart=true", "isSessionStart=false"],
    markerHashes: {
      probe1: ctx.markers.hash(probe1),
      daily: ctx.markers.hash(dailyMarker),
      weekly: ctx.markers.hash(weeklyMarker),
    },
  }, null, 2));
}

// ── Scenario 4: Fail closed (core) ──────────────────────────────────────────

async function failClosed(ctx: PiAcceptanceContext): Promise<void> {
  const f1 = ctx.markers.next("F1");
  const a1 = ctx.markers.next("F1A");
  const f2 = ctx.markers.next("F2");

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: f1 }, a1));
  await sendExpectReply(ctx.tui, f1, a1, "fail-closed first reply");
  // #1528: the f1/a1 exchange is the durable history that precedes route
  // loss; f2 is a fail-closed turn that must never be persisted.
  ctx.durableHistory = [f1, a1];

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
  const a3 = ctx.markers.next("F3A");
  const preLossHistory = ctx.durableHistory ?? [];

  await ctx.owner.restartOwner();

  // The bridge renegotiates memory asynchronously after the owner restart;
  // fail-closed turns are expected until it completes. Retry on the bounded
  // unavailability reply; the successful attempt must carry the pre-loss
  // durable history and its own marker exactly once.
  await sendWithRecoveryRetry(
    ctx,
    "F3",
    (marker) => textScript(FIXTURE_MODEL_A, {
      candidate: FIXTURE_MODEL_A,
      currentTurn: marker,
      orderedContains: preLossHistory,
      exactlyOnce: [marker],
    }, a3),
    a3,
    "post-recovery reply",
  );
}

// ── Scenario 6: Bridge restart (full) ───────────────────────────────────────

async function bridgeRestart(ctx: PiAcceptanceContext): Promise<void> {
  const a1 = ctx.markers.next("B1A");
  const a3 = ctx.markers.next("B3A");
  const preRestart = Date.now() - 1000;

  // The bridge may still be renegotiating memory after the owner recovery;
  // retry on the bounded unavailability reply like the recovery scenario.
  const b1 = await sendWithRecoveryRetry(
    ctx,
    "B1",
    (marker) => textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: marker }, a1),
    a1,
    "pre-restart reply",
  );

  // Terminate the exact bridge PID and boot the production entry point with
  // the same isolated home and owner.
  ctx.bridge = await ctx.restartBridge();

  // Reconnect the TUI client to the restarted bridge.
  ctx.tui.close();
  await ctx.tui.connect("resume");

  await sendWithRecoveryRetry(
    ctx,
    "B3",
    (marker) => textScript(FIXTURE_MODEL_A, { candidate: FIXTURE_MODEL_A, currentTurn: marker, exactlyOnce: [marker] }, a3),
    a3,
    "post-restart reply",
  );

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
  // Lazy Pi transport composition: spawn_session builds the sub transport
  // lazily through the subagent runtime (task one-shot). Spawns are
  // SEQUENTIAL (one per user turn) — the main host otherwise fires the next
  // spawn while the previous sub-transport is still in flight, reusing the
  // busy cached transport and overlapping two sendPrompt calls on one
  // PiCoreTransport. The second spawn exercises the transport lifecycle
  // after the first sub completed.
  const main1 = ctx.markers.next("LZ-M1");
  const goal1 = ctx.markers.next("LZ1");
  const sub1 = ctx.markers.next("LZ1A");
  const main1a = ctx.markers.next("LZ-M1A");
  const main2 = ctx.markers.next("LZ-M2");
  const goal2 = ctx.markers.next("LZ2");
  const sub2 = ctx.markers.next("LZ2A");
  const main2a = ctx.markers.next("LZ-M2A");

  // Turn 1: spawn #1; the sub request carries goal1.
  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: main1 },
    action: { kind: "toolCall", name: "spawn_session", arguments: { type: "task", goal: goal1 } },
  });
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: goal1,
    noToolBeforeCurrent: true,
  }, sub1));
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: main1,
    exactlyOnce: [main1],
  }, main1a));
  await ctx.tui.sendAndAwaitReply(main1);
  // The sub request for goal1 may complete after the main reply; the reply
  // itself is the main's final message (already consumed above).
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, goal1);
  await settleBetweenTurns();

  // Turn 2: spawn #2 after #1 completed — its request must NOT project the
  // first exchange (one-shot ephemeral execution).
  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: main2 },
    action: { kind: "toolCall", name: "spawn_session", arguments: { type: "task", goal: goal2 } },
  });
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: goal2,
    noToolBeforeCurrent: true,
  }, sub2));
  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: main2,
    exactlyOnce: [main2],
  }, main2a));
  await ctx.tui.sendAndAwaitReply(main2);
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, goal2);
  await settleBetweenTurns();

  // One-shot ephemeral execution stays operable without durable projection:
  // the second task-type spawn must NOT project the first spawn's exchange.
  const goal2Summary = ctx.provider.summariesFor(FIXTURE_MODEL_A).find((s) => s.markerTexts.some((t) => t.includes(goal2)));
  if (!goal2Summary) throw new Error("lazy task transport request for goal2 missing");
  if (goal2Summary.markerTexts.some((t) => t.includes(goal1))) {
    throw new Error("lazy task transport projected the first spawn's exchange into the second");
  }
}

// ── Scenario 8: Steer/follow-up (full) ──────────────────────────────────────

async function steerFollowUp(ctx: PiAcceptanceContext): Promise<void> {
  const s1 = ctx.markers.next("S1");
  const steer1 = ctx.markers.next("ST1");
  const steer2 = ctx.markers.next("ST2");
  const a1 = ctx.markers.next("S1A");
  const s2 = ctx.markers.next("S2");
  const a2 = ctx.markers.next("S2A");

  // Fire the turn without awaiting: its reply is the FINAL steered
  // generation's reply, delivered only after both steers are injected.
  const hold1 = releaseHold();
  ctx.provider.enqueue({ candidate: FIXTURE_MODEL_A, expectation: { candidate: FIXTURE_MODEL_A, currentTurn: s1 }, action: { kind: "hold", release: hold1.promise } });
  ctx.tui.sendInput(s1);
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, s1);

  // Steer 1 is delivered to the active host; the held request is released
  // (cleanly closed by the fixture) so the steered generation can run.
  const ack1 = await ctx.tui.steer(steer1);
  if (ack1.status === "rejected") throw new Error(`steer 1 rejected: ${ack1.message}`);
  hold1.release();

  const hold2 = releaseHold();
  // The steered generation's current turn IS the steering instruction (the
  // instruction is the latest user input in the active run); s1 remains in
  // the context and is asserted via orderedContains.
  ctx.provider.enqueue({
    candidate: FIXTURE_MODEL_A,
    expectation: { candidate: FIXTURE_MODEL_A, currentTurn: steer1, orderedContains: [s1, steer1] },
    action: { kind: "hold", release: hold2.promise },
  });
  await waitForProviderMarker(ctx.provider, FIXTURE_MODEL_A, steer1);

  // Steer 2 is queued while a generation is active (one-at-a-time).
  const ack2 = await ctx.tui.steer(steer2);
  if (ack2.status === "rejected") throw new Error(`steer 2 rejected: ${ack2.message}`);
  hold2.release();

  ctx.provider.enqueue(textScript(FIXTURE_MODEL_A, {
    candidate: FIXTURE_MODEL_A,
    currentTurn: steer2,
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

  // The lane's session model depends on prior serial scenarios: after
  // model-switch the config remains on fixture-model-b, otherwise the lane
  // is on fixture-model-a. Script the hold on both — the request lands on
  // exactly one — so C1 always reaches the provider and the abort bound
  // stays meaningful regardless of which model the session currently uses.
  const hold = releaseHold();
  for (const candidate of [FIXTURE_MODEL_A, FIXTURE_MODEL_B]) {
    ctx.provider.enqueue({ candidate, expectation: { candidate, currentTurn: c1 }, action: { kind: "hold", release: hold.promise } });
  }

  // Fire the held turn without awaiting; /stop interrupts it.
  ctx.tui.sendInput(c1);
  const held = await waitForHeldMarkerSummary(ctx.provider, c1);
  const servedCandidate = held.candidate;

  ctx.tui.sendInput("/stop");

  // The held provider connection must observe the abort.
  await waitFor(
    async () => held.aborted,
    TIMEOUTS.holdSettleMs,
    "held provider request abort",
  );

  // Consume the bounded abort/error messages the cancelled turn may surface —
  // the /stop acknowledgement ("🛑 Ctrl+C sent."), chunk-end "cancelled"
  // frames, and the cancelled turn's empty settle reply all count — so none
  // can ever be misattributed to the continuation turn. Drain until a
  // bounded window passes without a frame.
  for (let i = 0; i < 4; i++) {
    try {
      await ctx.tui.awaitMessage(1_000);
    } catch {
      break;
    }
  }

  ctx.provider.enqueue(textScript(servedCandidate, {
    candidate: servedCandidate,
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

  // #1775: late arrivals after the terminal outcome must be fenced. After the
  // continuation settles, drain straggler frames, then require a bounded quiet
  // window with no new provider request on either candidate. The sleep is a
  // negative-assertion window, not readiness evidence.
  await settleBetweenTurns();
  for (let i = 0; i < 3; i++) {
    try {
      await ctx.tui.awaitMessage(1_000);
    } catch {
      break;
    }
  }
  const quietBaseline = ctx.provider.summaries.length;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const quietLater = ctx.provider.summaries.length;
  if (quietLater !== quietBaseline) {
    throw new Error(`late provider request after cancellation settled (summaries ${quietBaseline} → ${quietLater})`);
  }
}

// ── Scenario 11b: Acquisition hang cancellation (full) — #1506 ──────────────

/**
 * The escaped #1506 edge: a provider whose request/stream NEVER opens (no
 * response headers) leaves the attempt in `acquiring` with no iterator for
 * any stream watchdog to observe. The whole-attempt liveness runner must
 * bound the acquisition on the execution abort signal so the turn terminates
 * and the next turn starts — the old code awaited the factory forever.
 */
async function acquisitionCancel(ctx: PiAcceptanceContext): Promise<void> {
  const a1 = ctx.markers.next("ACQ1");
  const a2 = ctx.markers.next("ACQ2");

  // Script the acquisition hold on both candidates — headers never written —
  // so the request lands on exactly the candidate the session currently uses.
  const hold = releaseHold();
  for (const candidate of [FIXTURE_MODEL_A, FIXTURE_MODEL_B]) {
    ctx.provider.enqueue({ candidate, expectation: { candidate, currentTurn: a1 }, action: { kind: "acquisitionHold", release: hold.promise } });
  }

  // Fire the turn without awaiting; /stop interrupts the pending acquisition.
  ctx.tui.sendInput(a1);
  const held = await waitForHeldMarkerSummary(ctx.provider, a1);
  const servedCandidate = held.candidate;

  ctx.tui.sendInput("/stop");

  // The never-opened provider connection must observe the abort — the bridge
  // cancelled the acquisition even though no stream ever existed.
  await waitFor(
    async () => held.aborted,
    TIMEOUTS.holdSettleMs,
    "held acquisition request abort",
  );

  // Drain the bounded abort/error frames the cancelled turn may surface.
  for (let i = 0; i < 4; i++) {
    try {
      await ctx.tui.awaitMessage(1_000);
    } catch {
      break;
    }
  }

  // The next turn must reach the provider and settle normally.
  ctx.provider.enqueue(textScript(servedCandidate, {
    candidate: servedCandidate,
    currentTurn: a2,
    orderedContains: [a1],
    exactlyOnce: [a2],
  }, a2));
  await sendExpectReply(ctx.tui, a2, a2, "post-cancel reply after acquisition hang");

  // No orphan requests: the only requests since the held one are the turn
  // that settled the cancel and the successful continuation.
  const since = ctx.provider.summaries.filter((s) => s.seq > held.seq);
  if (since.some((s) => s.action === "unscripted" || s.action === "expectation_failed")) {
    throw new Error("orphan or unscripted provider request after acquisition cancellation");
  }
}

// ── Scenario 12: Pi terminal cleanup (core) — #1647 ────────────────────────

/**
 * Terminal cleanup for a real spawned Pi child, offline: after a terminal
 * generation, its external C session is gone from /sessions, no Pi process
 * survives under the run root, and no workspace claim remains. The run
 * itself is driven over the real TUI and the real Pi RPC boundary with no
 * credentials — the prompt fails closed and the lifecycle settles.
 */
async function piTerminalCleanup(ctx: PiAcceptanceContext): Promise<void> {
  const goal = ctx.markers.next("PI-CLEAN");
  const runRoot = join(ctx.abtarsHome, "..");

  // 1. Create a Pi run over the real TUI.
  const created = await ctx.tui.sendAndAwaitReply(`/pi run --workspace default ${goal}`);
  const runId = created.markdown.match(/Run: `([^`]+)`/)?.[1];
  if (!runId) {
    throw new Error(`pi run creation reply had no run id: ${created.markdown.slice(0, 300)}`);
  }

  // 2. Wait for a terminal state (offline prompt fails closed).
  await waitFor(async () => {
    const status = await ctx.tui.sendAndAwaitReply(`/pi status ${runId}`);
    const m = status.markdown.match(/Status:\s*(\w+)/);
    const s = m?.[1] ?? "";
    return ["completed", "failed", "cancelled", "interrupted"].includes(s) ? s : undefined;
  }, 120_000, `pi run ${runId} terminal`);

  // 3. The external C session is gone: /sessions carries no entry naming the
  //    run's goal (session name is `Pi: <goal slice 60>`).
  await waitFor(async () => {
    const sessions = await ctx.tui.sendAndAwaitReply("/sessions");
    return sessions.markdown.includes(goal) ? undefined : true;
  }, 15_000, `no C session for ${runId} in /sessions`);
  const sessionsAfter = await ctx.tui.sendAndAwaitReply("/sessions");
  if (sessionsAfter.markdown.includes(goal)) {
    throw new Error("external C session for the terminal Pi generation still visible in /sessions");
  }

  // 4. No Pi process survives under the run root.
  const piChildren = () => {
    const out: Array<{ pid: number }> = [];
    let entries: string[];
    try { entries = readdirSync("/proc"); } catch { return out; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (comm !== "pi") continue;
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(runRoot)) continue;
        out.push({ pid });
      } catch { /* process vanished mid-scan */ }
    }
    return out;
  };
  await waitFor(async () => (piChildren().length === 0 ? true : undefined), 15_000, "no pi child processes after terminal");
  if (piChildren().length > 0) {
    throw new Error(`orphan pi process(es) after terminal generation: ${piChildren().map(p => p.pid).join(",")}`);
  }

  // 5. No workspace claim remains for the run, and the row is terminal.
  const dbPath = join(ctx.abtarsHome, "kanban", "kanban.db");
  if (!existsSync(dbPath)) throw new Error(`kanban db missing at ${dbPath}`);
  const claims = execFileSync("sqlite3", [dbPath, `SELECT COUNT(*) FROM pi_workspace_claims WHERE run_id = '${runId}'`], { encoding: "utf-8" }).trim();
  if (claims !== "0") {
    throw new Error(`workspace claim(s) remain for terminal run ${runId}: ${claims}`);
  }
  const row = execFileSync("sqlite3", [dbPath, `SELECT status FROM pi_runs WHERE id = '${runId}'`], { encoding: "utf-8" }).trim();
  if (!["completed", "failed", "cancelled", "interrupted"].includes(row)) {
    throw new Error(`pi run ${runId} not terminal after cleanup (status=${row})`);
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

export const PI_SCENARIOS: PiScenario[] = [
  { name: "main-continuity-and-cursor", profiles: ["core", "full", "proof"], run: mainContinuity },
  { name: "tool-multi-generation", profiles: ["core", "full", "proof"], run: toolMultiGeneration },
  { name: "tool-policy-denial", profiles: ["proof"], run: toolPolicyDenial },
  { name: "durable-compaction", profiles: ["proof"], run: durableCompaction },
  { name: "reset-rebuild", profiles: ["core", "full"], run: resetRebuild },
  { name: "session-start-hydration", profiles: ["hydration"], run: sessionStartHydration },
  { name: "fail-closed-provider-suppression", profiles: ["core", "full"], run: failClosed },
  { name: "owner-recovery", profiles: ["full"], run: ownerRecovery },
  { name: "bridge-restart", profiles: ["full", "proof"], run: bridgeRestart },
  { name: "lazy-transport-composition", profiles: ["full"], run: lazyTransports },
  { name: "steer-followup", profiles: ["full", "proof"], run: steerFollowUp },
  { name: "candidate-fallback", profiles: ["full"], run: fallback },
  { name: "model-switch", profiles: ["full", "proof"], run: modelSwitch },
  { name: "cancellation-deadline", profiles: ["full", "proof"], run: cancellation },
  { name: "acquisition-hang-cancellation", profiles: ["full"], run: acquisitionCancel },
  { name: "scheduled-orc-round-limit", profiles: ["full"], run: scheduledOrcRoundLimit },
  { name: "scheduled-orc-round-limit-restart", profiles: ["full"], run: scheduledOrcRoundLimitRestart },
  // This scenario intentionally relies on the offline/fail-closed Pi prompt.
  // The full profile leaves the fixture session on model B and runs scheduled
  // provider traffic immediately before this scenario, so it is not an
  // offline boundary and can wait forever for an unscripted provider turn.
  // Core exercises both transport lanes while preserving that contract.
  { name: "pi-terminal-cleanup", profiles: ["core"], run: piTerminalCleanup },
];

/** #1775 proof order: later scenarios observe state produced by earlier ones. */
const PROOF_SCENARIO_ORDER = [
  "main-continuity-and-cursor",
  "tool-multi-generation",
  "tool-policy-denial",
  "durable-compaction",
  "steer-followup",
  "cancellation-deadline",
  "bridge-restart",
  "model-switch",
];

export function scenariosForProfile(profile: "core" | "full" | "proof" | "hydration"): PiScenario[] {
  if (profile === "proof") {
    return PROOF_SCENARIO_ORDER.map((name) => {
      const scenario = PI_SCENARIOS.find((s) => s.name === name);
      if (!scenario) throw new Error(`proof profile requires missing registry scenario ${name}`);
      return scenario;
    });
  }
  return PI_SCENARIOS.filter((s) => s.profiles.includes(profile));
}
