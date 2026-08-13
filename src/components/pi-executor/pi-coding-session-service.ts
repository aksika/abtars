/**
 * pi-coding-session-service.ts — #1635 interactive Pi coding sessions.
 *
 * One durable session row spans many turn generations. A Telegram turn is a
 * transient RPC process: reserve a shared slot, atomically acquire the
 * workspace claim + CAS idle -> starting, launch/switch to the proven
 * transcript, prompt, and on `agent_end` persist proof, stop the process,
 * release slot/claim/lease, and return to `idle`. There is no resident idle
 * Telegram process and no eviction timer — the Pi transcript preserves
 * continuity.
 *
 * Memory isolation is structural: the child env is built with
 * memoryMode "none" and the routing boundary (coding-route.ts) short-circuits
 * before every abmind path. This service never calls spin.spin(),
 * buildPrompt(), or any memory hook.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { PiCodingSessionStore, type PiCodingSessionRecord, type PiCodingTransitionUpdates, type PiCodingState, type PiCodingLeaseFrontend } from "./pi-coding-session-store.js";
import { PiWorkspaceClaimStore } from "./pi-workspace-claim-store.js";
import { PiRuntimeHost } from "./pi-runtime-host.js";
import type { PiExecutorConfig } from "./config.js";
import { resolveAndValidateWorkspace, validatePersistedSession } from "./config.js";
import { SupervisedPiRpcClient, type PiAgentEvent } from "./pi-rpc-client.js";
import { projectPiEvent } from "./pi-event-projection.js";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import type { Spin } from "../spin.js";
import { captureGitEvidence, computeChangedFilesSummary } from "./evidence.js";
import type { PiUiReply, ResumeCapability } from "./types.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import type { NativeCodingHandoffInfo } from "../../platforms/tui/tui-protocol.js";

const TAG = "pi-coding";
const NATIVE_RECOVERY_POLL_MS = 250;

/** Internal sentinel: roll back the turn-start transaction. */
const TURN_START_ROLLBACK = Symbol("pi_coding_turn_start_rollback");

export interface PiCodingProjectionSink {
  /** One editable progress message per turn (content-free lifecycle). */
  progress(sessionId: string, text: string): void;
  /** Tool name + lifecycle, no arguments, no output. */
  tool(sessionId: string, name: string, started: boolean): void;
  /** Correlated extension UI request (input/editor as prompts, select/confirm
   * as inline controls — rendered by the sink). */
  uiRequest(sessionId: string, request: RpcExtensionUIRequest): void;
  /** Final assistant text, chunked by the sink to platform limits. */
  assistantText(sessionId: string, text: string): void;
  /** Final usage + changed-file summary. */
  turnComplete(sessionId: string, summary: { usageJson?: string; changedFilesSummary?: string; error?: string }): void;
  /** Bounded busy state — the turn did not start. */
  busy(sessionId: string, reason: string): void;
  /** Bounded retry response while starting/resuming. */
  retry(sessionId: string, reason: string): void;
  /** Truthful non-resumability with the derived capability. */
  notResumable(sessionId: string, capability: Exclude<ResumeCapability, "available">, reason: string): void;
}

export interface PiCodingServiceDeps {
  store: PiCodingSessionStore;
  claims: PiWorkspaceClaimStore;
  host: PiRuntimeHost;
  config: PiExecutorConfig;
  spin: Spin;
  sink: PiCodingProjectionSink;
}

interface OwnedTurn {
  sessionId: string;
  generation: number;
  client: SupervisedPiRpcClient;
  workspacePath: string;
  beforeEvidence: { head?: string; status?: string } | null;
  settling: boolean;
  released: boolean;
  endRequested: boolean;
  abortTimer: ReturnType<typeof setTimeout> | null;
  wallClockStart: number;
  unsubTermination: (() => void) | null;
  unsubEvents: (() => void) | null;
  unsubUi: (() => void) | null;
}

export type TurnStartResult =
  | { kind: "started" }
  | { kind: "busy"; reason: string }
  | { kind: "retry"; reason: string }
  | { kind: "not_resumable"; capability: Exclude<ResumeCapability, "available">; reason: string }
  | { kind: "error"; reason: string };

export interface CreateCodingSessionResult {
  sessionId: string;
  spinSessionId: string;
}

/** #1635 Phase 2 — a live native TUI handoff. The client owns the Pi process;
 *  the daemon holds the generation-owned slot/claim/lease until the client
 *  reports exit (or its connection dies and the process is proven gone). */
interface NativeHandoffState {
  sessionId: string;
  generation: number;
  leaseOwner: string;
  /** Initial-case Pi session id handed to the client via `--session-id`. */
  newPiSessionId?: string;
  /** True once the client reported its spawned Pi pid. */
  started: boolean;
  /** An owner requested `/coding end` or `/session end|kill`. */
  endRequested: boolean;
}

export type NativeHandoffResult =
  | { ok: true; handoff: NativeCodingHandoffInfo }
  | { ok: false; reason: string };

export class PiCodingSessionService {
  private readonly deps: PiCodingServiceDeps;
  private readonly live = new Map<string, OwnedTurn>();
  /** #1635 Phase 2 — live native TUI handoffs keyed by session id. */
  private readonly nativeHandoffs = new Map<string, NativeHandoffState>();
  /**
   * Native writers that outlived their socket/bridge connection.  Their
   * process slot remains reserved until a later reconciliation proves the
   * writer gone; the set prevents a boot/retry path from double-counting or
   * releasing the recovered slot belonging to another generation.
   */
  private readonly recoveredNativeSlots = new Set<string>();
  /** Bounded cleanup watches for client-owned writers that outlived a socket. */
  private readonly nativeRecoveryWatches = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: PiCodingServiceDeps) {
    this.deps = deps;
  }

  get liveCount(): number { return this.live.size; }

  /** Number of currently active native TUI handoffs (capacity accounting). */
  get nativeHandoffCount(): number { return this.nativeHandoffs.size; }

  // ── session creation / listing ────────────────────────────────────────────

  /**
   * R6 — Owner-only creation, allowlisted alias resolved canonically at
   * creation and at every launch/resume.
   */
  createCodingSession(input: {
    ownerPrincipal: string;
    workspaceAlias: string;
    chatId?: string;
    modelProvider?: string;
    modelId?: string;
    thinking?: string;
  }): CreateCodingSessionResult {
    const ws = resolveAndValidateWorkspace(input.workspaceAlias, this.deps.config);
    if (ws.error) throw new Error(ws.error);

    // R1.3 — the abTARS session envelope is the durable C session: listable,
    // switchable, transportless, no memory recording.
    const spinSession = this.deps.spin.allocateCodingExternalSession({
      userId: input.ownerPrincipal,
      platform: "telegram",
      name: `Coding: ${input.workspaceAlias}`,
      workingDir: ws.canonicalPath,
      codingSessionId: "", // placeholder; replaced below after row creation
    });

    // The row is keyed by the envelope id — created after allocation.
    const sessionId = spinSession.id;
    this.deps.store.create({
      sessionId,
      ownerPrincipal: input.ownerPrincipal,
      workspaceAlias: input.workspaceAlias,
      canonicalPath: ws.canonicalPath,
      chatId: input.chatId,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      thinking: input.thinking,
    });
    // Rewrite the envelope metadata with the durable identity (the id was not
    // known before allocation).
    (spinSession as unknown as Record<string, unknown>).externalMetadata = {
      kind: "coding",
      codingSessionId: sessionId,
    };
    this.deps.store.casTransition(sessionId, "creating", "idle");
    logInfo(TAG, `Coding session ${sessionId} created for ${input.ownerPrincipal} (${input.workspaceAlias})`);
    return { sessionId, spinSessionId: sessionId };
  }

  getSession(sessionId: string, callerPrincipal: string): PiCodingSessionRecord | null {
    const rec = this.deps.store.get(sessionId);
    if (!rec) return null;
    if (rec.ownerPrincipal !== callerPrincipal) return null;
    return rec;
  }

  listForOwner(ownerPrincipal: string): PiCodingSessionRecord[] {
    return this.deps.store.listForOwner(ownerPrincipal);
  }

  /** R1 — make the coding envelope the active session so inbound messages
   * route through the coding boundary. */
  activate(sessionId: string, ownerPrincipal: string): boolean {
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return false;
    const spinSession = this.deps.spin.getSessionById(sessionId);
    if (!spinSession || spinSession.status === "ended") return false;
    const r = this.deps.spin.switchSession(ownerPrincipal, spinSession.platform, spinSession.shortIndex);
    return typeof r !== "string";
  }

  /** R1 — return the owner to the platform's main session. */
  async deactivate(sessionId: string, ownerPrincipal: string): Promise<boolean> {
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return false;
    const spinSession = this.deps.spin.getSessionById(sessionId);
    if (!spinSession) return false;
    const active = this.deps.spin.getActiveSession(ownerPrincipal, spinSession.platform);
    if (active.id !== sessionId) return true; // already deactivated
    const { sessionType } = await import("../spin-types.js");
    const local = this.deps.spin.listSessions(ownerPrincipal, spinSession.platform).sessions;
    const main = local.find(s => sessionType(s) === "A" && s.status !== "ended");
    if (!main) return false;
    const r = this.deps.spin.switchSession(ownerPrincipal, spinSession.platform, main.shortIndex);
    return typeof r !== "string";
  }

  // ── Telegram turn lifecycle ───────────────────────────────────────────────

  /**
   * R4 — A turn on an `idle` session. Ordering is load-bearing:
   * reserve slot -> atomically (advance generation + CAS idle->starting +
   * claim acquire) -> launch -> switch/prove or fresh identity -> running ->
   * prompt. Every failure releases exactly what was acquired and leaves the
   * durable session `idle` (or `interrupted` when continuity cannot be
   * proven — Task 5).
   */
  async startTurn(input: {
    sessionId: string;
    text: string;
    ownerPrincipal: string;
    leaseOwner: string;
  }): Promise<TurnStartResult> {
    const rec = this.authorize(input.sessionId, input.ownerPrincipal);
    if (!rec) return { kind: "error", reason: "Session not found" };
    if (rec.state !== "idle" && rec.state !== "interrupted") {
      return { kind: rec.state === "starting" || rec.state === "resuming" ? "retry" : "busy", reason: `Session is ${rec.state}` };
    }

    const ws = resolveAndValidateWorkspace(rec.workspaceAlias, this.deps.config);
    if (ws.error) return { kind: "error", reason: ws.error };

    // R4.6 — synchronously reserve the shared Pi slot before anything else.
    if (!this.deps.host.tryReserveSlot()) {
      return { kind: "busy", reason: "Pi capacity is full — retry when a slot frees up" };
    }

    const currentGen = rec.runtimeGeneration;
    const intent: "initial" | "resume" = rec.piSessionId && rec.piSessionFile ? "resume" : "initial";

    // Atomically: bump the generation, CAS idle -> starting, acquire the
    // workspace claim. Any failure rolls the whole transaction back so the
    // durable session stays idle.
    let generation: number;
    try {
      const tx = this.txTurnStart(rec, currentGen, intent, input.leaseOwner, ws.canonicalPath);
      if (!tx.ok) {
        this.deps.host.releaseSlot();
        return tx.busy
          ? { kind: "busy", reason: "Workspace is busy — another Pi worker holds it" }
          : { kind: "retry", reason: "Session is starting; retry shortly" };
      }
      generation = tx.generation;
    } catch {
      this.deps.host.releaseSlot();
      return { kind: "error", reason: "Failed to start the turn" };
    }

    const turn = await this.launchTurn(rec, generation, ws.canonicalPath);
    if (!turn.ok) return { kind: "error", reason: turn.reason };

    const owned = turn.owned!;
    this.live.set(input.sessionId, owned);
    this.registerListeners(owned);

    try {
      // Prove or persist the session identity BEFORE running.
      const identity = await this.resolveIdentity(rec, owned, intent);
      if (!identity.ok) {
        await this.teardownTurn(owned, identity.capability, "Session identity could not be proven");
        return { kind: "not_resumable", capability: identity.capability, reason: identity.reason };
      }

      const running = this.deps.store.casTransition(
        input.sessionId, "starting", "running",
        {
          piSessionId: identity.sessionId,
          piSessionFile: identity.sessionFile,
          observedPid: owned.client.pid,
          resumeCapability: "available",
          pendingRequestId: null,
          pendingRequestType: null,
        },
        generation,
      );
      if (!running.applied) {
        await this.teardownTurn(owned, "unsupported", "State changed mid-turn");
        return { kind: "error", reason: "State changed mid-turn" };
      }

      await owned.client.prompt(input.text);
      this.deps.store.touchActivity(input.sessionId, generation);
      return { kind: "started" };
    } catch (err) {
      await this.teardownTurn(owned, "session_missing", boundedError(err));
      return { kind: "error", reason: boundedError(err) };
    }
  }

  /** A message arriving mid-turn — Pi queues it. */
  async followUp(sessionId: string, text: string, ownerPrincipal: string): Promise<TurnStartResult> {
    const owned = this.live.get(sessionId);
    if (!owned) return { kind: "busy", reason: "No active turn" };
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return { kind: "error", reason: "Session not found" };
    if (rec.state !== "running") return { kind: "busy", reason: `Session is ${rec.state}` };
    if (this.checkWallClock(owned)) return { kind: "error", reason: "Turn exceeded the wall clock — aborted" };
    try {
      await owned.client.followUp(text);
      this.deps.store.touchActivity(sessionId, owned.generation);
      return { kind: "started" };
    } catch (err) {
      return { kind: "error", reason: boundedError(err) };
    }
  }

  /** `/steer` — interrupt the active turn with direction. */
  async steer(sessionId: string, text: string, ownerPrincipal: string): Promise<TurnStartResult> {
    const owned = this.live.get(sessionId);
    if (!owned) return { kind: "busy", reason: "No active turn" };
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return { kind: "error", reason: "Session not found" };
    if (rec.state !== "running") return { kind: "busy", reason: `Session is ${rec.state}` };
    if (this.checkWallClock(owned)) return { kind: "error", reason: "Turn exceeded the wall clock — aborted" };
    try {
      await owned.client.steer(text);
      this.deps.store.touchActivity(sessionId, owned.generation);
      return { kind: "started" };
    } catch (err) {
      return { kind: "error", reason: boundedError(err) };
    }
  }

  /** `/stop` — abort the turn only; the durable session survives. */
  async stop(sessionId: string, ownerPrincipal: string): Promise<boolean> {
    const owned = this.live.get(sessionId);
    if (!owned) return false;
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return false;
    if (owned.settling) return false;
    this.cancelTurn(owned, "Cancelled by user");
    return true;
  }

  /** Reply to a pending extension UI request (awaiting_input). */
  async reply(sessionId: string, requestId: string, value: PiUiReply, ownerPrincipal: string): Promise<{ ok: boolean; reason?: string }> {
    const owned = this.live.get(sessionId);
    if (!owned) return { ok: false, reason: "No active turn" };
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return { ok: false, reason: "Session not found" };
    if (rec.state !== "awaiting_input") return { ok: false, reason: `Session is ${rec.state}` };
    if (rec.pendingRequestId !== requestId) return { ok: false, reason: "Request ID mismatch" };
    const result = await owned.client.respondToUi(requestId, value).catch((err: Error) => ({
      ok: false, delivery: "not_written" as const, error: err.message,
    }));
    if (result.delivery === "not_written") {
      return { ok: false, reason: "Pi did not accept the reply" };
    }
    this.deps.store.casTransition(sessionId, "awaiting_input", "running", {
      pendingRequestId: null, pendingRequestType: null,
    });
    this.deps.store.touchActivity(sessionId, owned.generation);
    return { ok: true };
  }

  /**
   * `//x` pass-through. Idle: the same transient runtime lifecycle as a turn
   * (launch/switch, submit the command, teardown to idle). Running: follow_up
   * (Pi's own queue is authoritative).
   */
  async passThrough(sessionId: string, command: string, ownerPrincipal: string): Promise<TurnStartResult> {
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return { kind: "error", reason: "Session not found" };
    if (rec.state === "running") {
      return this.followUp(sessionId, command, ownerPrincipal);
    }
    if (rec.state !== "idle" && rec.state !== "interrupted") {
      return { kind: "retry", reason: `Session is ${rec.state}` };
    }
    const result = await this.startTurn({ sessionId, text: command, ownerPrincipal, leaseOwner: `passthrough:${ownerPrincipal}` });
    return result;
  }

  /**
   * `/compact` on an idle session: the same transient lifecycle, running Pi's
   * native compaction, then persist proof and return to idle. Busy during a
   * turn.
   */
  async compactSession(sessionId: string, instructions: string | undefined, ownerPrincipal: string): Promise<{ ok: boolean; message: string }> {
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return { ok: false, message: "Session not found" };
    if (rec.state !== "idle" && rec.state !== "interrupted") {
      return { ok: false, message: `Busy during a turn (${rec.state})` };
    }
    const ws = resolveAndValidateWorkspace(rec.workspaceAlias, this.deps.config);
    if (ws.error) return { ok: false, message: ws.error };
    if (!this.deps.host.tryReserveSlot()) {
      return { ok: false, message: "Pi capacity is full — retry when a slot frees up" };
    }
    const currentGen = rec.runtimeGeneration;
    const intent: "initial" | "resume" = rec.piSessionId && rec.piSessionFile ? "resume" : "initial";
    let generation: number;
    try {
      const tx = this.txTurnStart(rec, currentGen, intent, `compact:${ownerPrincipal}`, ws.canonicalPath);
      if (!tx.ok) {
        this.deps.host.releaseSlot();
        return { ok: false, message: tx.busy ? "Workspace is busy" : "Session is starting" };
      }
      generation = tx.generation;
    } catch {
      this.deps.host.releaseSlot();
      return { ok: false, message: "Failed to start compaction" };
    }

    const turn = await this.launchTurn(rec, generation, ws.canonicalPath);
    if (!turn.ok) {
      return { ok: false, message: turn.reason };
    }
    const owned = turn.owned!;
    this.live.set(sessionId, owned);
    this.registerListeners(owned);
    try {
      const identity = await this.resolveIdentity(rec, owned, intent);
      if (!identity.ok) {
        await this.teardownTurn(owned, identity.capability, "Session identity could not be proven");
        return { ok: false, message: identity.reason };
      }
      await owned.client.compact(instructions);
      await this.finishTurn(owned, identity, "compact");
      return { ok: true, message: "Compaction complete" };
    } catch (err) {
      await this.teardownTurn(owned, "session_missing", boundedError(err));
      return { ok: false, message: boundedError(err) };
    }
  }

  // ── session end / shutdown ────────────────────────────────────────────────

  /**
   * `/coding end` — stop any live turn, then end the durable row and the Spin
   * C envelope after generation-owned resources are released. Never touches
   * the Pi transcript.
   */
  endSession(sessionId: string, ownerPrincipal: string): boolean {
    const rec = this.authorize(sessionId, ownerPrincipal);
    if (!rec) return false;
    const owned = this.live.get(sessionId);
    if (owned) {
      owned.endRequested = true;
      if (!owned.settling) this.cancelTurn(owned, "Session ended by user");
      logInfo(TAG, `Coding session ${sessionId} end requested; waiting for Pi teardown`);
      return true;
    }
    const native = this.nativeHandoffs.get(sessionId);
    if (native) {
      this.requestNativeHandoffEnd(native);
      logInfo(TAG, `Native coding session ${sessionId} end requested; waiting for Pi teardown`);
      return true;
    }
    this.deps.store.markEnded(sessionId);
    try {
      this.deps.spin.endCodingExternalSession(sessionId, sessionId);
    } catch { /* best effort */ }
    logInfo(TAG, `Coding session ${sessionId} ended (transcript preserved)`);
    return true;
  }

  /**
   * Synchronous preflight used by `/session end|kill`. An active Pi process
   * cannot be awaited by Spin's synchronous session API, so refuse envelope
   * finalization and let releaseTurn finish it after reap. Idle sessions have
   * no process and can be finalized by Spin immediately.
   */
  prepareEndSession(sessionId: string): boolean {
    const rec = this.deps.store.get(sessionId);
    if (!rec) return true;
    const owned = this.live.get(sessionId);
    if (owned) {
      owned.endRequested = true;
      if (!owned.settling) this.cancelTurn(owned, "Session ended by user");
      return false;
    }
    const native = this.nativeHandoffs.get(sessionId);
    if (native) {
      this.requestNativeHandoffEnd(native);
      return false;
    }
    this.deps.store.markEnded(sessionId);
    return true;
  }

  // ── #1635 Phase 2 — native TUI handoff ────────────────────────────────────

  /**
   * Resolve an `idle|suspended|interrupted` session for a native TUI handoff and hold
   * the generation-owned resources for its whole lifetime. Sequence (design
   * §8): prove no prior writer process -> synchronously reserve a shared Pi
   * slot -> atomically (advance generation + CAS idle|interrupted -> starting
   * + acquire the interactive workspace claim + set the native-tui writer
   * lease). The reply carries ONLY session facts — never an executable or
   * argument vector; the client resolves Pi and builds its own args.
   *
   * `command` is the raw client line: `/coding`, `/coding new <alias>`, or
   * `/coding resume [sessionId]` — same resolution semantics as Telegram.
   */
  beginNativeHandoff(input: {
    ownerPrincipal: string;
    leaseOwner: string;
    command: string;
  }): NativeHandoffResult {
    const resolved = this.resolveHandoffTarget(input.command, input.ownerPrincipal);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    let rec = this.discoverPendingSessionFile(resolved.rec!);

    // R2.4 — prove no prior writer process before acquiring the lease. A live
    // pid (previous crashed handoff / unreaped writer) must never be written
    // over by a second process.
    if (rec.observedPid !== undefined && isProcessAlive(rec.observedPid)) {
      return { ok: false, reason: `A prior Pi session process (pid ${rec.observedPid}) is still running on this workspace — quit it before starting a native handoff` };
    }

    // Self-heal a stale native handoff fence: a dead client connection or
    // daemon restart leaves the native lease/claim held on a `starting` or
    // `interrupted` row. The pid check above already proved no live writer,
    // so the stale fence can be released and the accept proceeds.
    if (rec.leaseFrontend === "native-tui" && rec.leaseGeneration !== undefined) {
      const stale = this.nativeHandoffs.get(rec.sessionId);
      let staleSlotHeld = false;
      if (stale) {
        this.nativeHandoffs.delete(rec.sessionId);
        staleSlotHeld = true;
      }
      this.deps.store.casTransition(rec.sessionId, ["starting", "interrupted"], "interrupted", {
        resumeCapability: this.capabilityForRow(rec),
        observedPid: null,
      }, rec.runtimeGeneration);
      this.deps.store.clearLease(rec.sessionId, rec.leaseGeneration);
      this.deps.store.clearObservedPid(rec.sessionId, rec.runtimeGeneration);
      this.deps.claims.releaseForGeneration({ ownerId: rec.sessionId, generation: rec.runtimeGeneration });
      if (staleSlotHeld) this.deps.host.releaseSlot();
      this.releaseRecoveredNativeSlot(rec.sessionId, rec.runtimeGeneration);
      logWarn(TAG, `Coding session ${rec.sessionId}: cleared stale native handoff fence`);
      rec = this.discoverPendingSessionFile(this.deps.store.get(rec.sessionId)!);
    }

    // R2.4 — fail closed from live states.
    if (rec.state !== "idle" && rec.state !== "suspended" && rec.state !== "interrupted") {
      return { ok: false, reason: `Native handoff requires an idle or suspended session (state is ${rec.state})` };
    }

    // Resume requires a proven target, never an inferred one (R4.4).
    const isResume = Boolean(rec.piSessionId && rec.piSessionFile);
    let proof: ReturnType<typeof validatePersistedSession> | null = null;
    if (isResume) {
      proof = validatePersistedSession({
        sessionStorageRoot: this.deps.config.sessionStorageRoot,
        expectedSessionId: rec.piSessionId,
        sessionFile: rec.piSessionFile,
      });
      if (!proof.ok) {
        this.deps.store.recordResumeCapability(rec.sessionId, proof.capability);
        return { ok: false, reason: `Pi session is not resumable (${proof.capability}): ${proof.reason}` };
      }
    }

    const ws = resolveAndValidateWorkspace(rec.workspaceAlias, this.deps.config);
    if (ws.error) return { ok: false, reason: ws.error };

    // The id is generated before the transaction so an initial handoff keeps
    // a durable target even if the bridge dies before the client can report
    // its pid.  Presence of this id alone never grants resumability; the
    // session file still has to be found and proven.
    const newPiSessionId = isResume ? undefined : randomUUID();

    // R4.6 — synchronously reserve the shared Pi slot before anything else.
    if (!this.deps.host.tryReserveSlot()) {
      return { ok: false, reason: "Pi capacity is full — retry when a slot frees up" };
    }

    const intent: "initial" | "resume" = isResume ? "resume" : "initial";
    let generation: number;
    try {
      const tx = this.txTurnStart(rec, rec.runtimeGeneration, intent, input.leaseOwner, ws.canonicalPath, "native-tui", newPiSessionId);
      if (!tx.ok) {
        this.deps.host.releaseSlot();
        return { ok: false, reason: tx.busy
          ? "Workspace is busy — another Pi worker holds it"
          : "Session changed state before the handoff could start" };
      }
      generation = tx.generation;
    } catch {
      this.deps.host.releaseSlot();
      return { ok: false, reason: "Failed to start the native handoff" };
    }

    this.nativeHandoffs.set(rec.sessionId, {
      sessionId: rec.sessionId,
      generation,
      leaseOwner: input.leaseOwner,
      newPiSessionId,
      started: false,
      endRequested: false,
    });

    const handoff: NativeCodingHandoffInfo = {
      sessionId: rec.sessionId,
      workspaceAlias: rec.workspaceAlias,
      canonicalPath: ws.canonicalPath,
      memoryMode: rec.memoryMode,
      sessionStorageRoot: this.deps.config.sessionStorageRoot,
      piSessionId: proof?.ok ? proof.sessionId : undefined,
      piSessionFile: proof?.ok ? proof.canonicalFile : undefined,
      newPiSessionId,
      modelProvider: rec.modelProvider,
      modelId: rec.modelId,
      thinking: rec.thinking,
    };
    logInfo(TAG, `Native handoff ${rec.sessionId} (gen ${generation}) started by ${input.leaseOwner} (${intent})`);
    return { ok: true, handoff };
  }

  /**
   * The client spawned the pinned Pi executable — persist the pid as the
   * exclusive-writer fence (`observedPid`). Generation- and lease-fenced: a
   * stale connection can never write a newer handoff's row.
   */
  recordNativeHandoffPid(input: { sessionId: string; leaseOwner: string; pid: number }): boolean {
    const h = this.nativeHandoffs.get(input.sessionId);
    if (!h || h.leaseOwner !== input.leaseOwner) return false;
    const cas = this.deps.store.casTransition(input.sessionId, h.endRequested ? ["starting", "ended"] : "starting", h.endRequested ? "ended" : "starting", {
      observedPid: input.pid,
      ...(h.newPiSessionId ? { piSessionId: h.newPiSessionId } : {}),
    }, h.generation);
    if (cas.applied) {
      h.started = true;
      logDebug(TAG, `Native handoff ${input.sessionId}: writer pid ${input.pid} recorded`);
      if (h.endRequested) {
        this.requestNativeHandoffEnd(h);
        // The client must not continue treating a remotely-ended handoff as
        // owned. It still reports exit so the bridge can perform the final
        // proof/release path.
        return false;
      }
    }
    return cas.applied;
  }

  /**
   * Pi exited (or the client aborted before spawning). Reconcile the durable
   * session truthfully, then release the generation-owned slot/claim/lease.
   * `code === 0` with a valid proof returns the session to `idle`; anything
   * else lands `interrupted` with a proof-derived capability — never a false
   * `available`.
   */
  endNativeHandoff(input: { sessionId: string; leaseOwner: string; code: number | null }): { ok: boolean; message: string } {
    const h = this.nativeHandoffs.get(input.sessionId);
    if (!h) return { ok: false, message: "No active native handoff for this session" };
    if (h.leaseOwner !== input.leaseOwner) return { ok: false, message: "Handoff lease owner mismatch" };

    const rec = this.deps.store.get(input.sessionId);
    if (!rec) {
      this.releaseNativeHandoff(h);
      return { ok: false, message: "Session not found" };
    }
    const forceEnded = h.endRequested || rec.state === "ended";

    const updates: PiCodingTransitionUpdates = {
      pendingRequestId: null,
      pendingRequestType: null,
      observedPid: null,
    };
    let state: PiCodingState;
    let provedIdentity: { sessionId: string; canonicalFile: string } | null = null;

    if (rec.piSessionId && rec.piSessionFile) {
      const proof = validatePersistedSession({
        sessionStorageRoot: this.deps.config.sessionStorageRoot,
        expectedSessionId: rec.piSessionId,
        sessionFile: rec.piSessionFile,
      });
      updates.resumeCapability = proof.ok ? "available" : proof.capability;
      if (proof.ok) provedIdentity = { sessionId: proof.sessionId, canonicalFile: proof.canonicalFile };
      state = forceEnded ? "ended" : input.code === 0 && proof.ok ? "idle" : "interrupted";
    } else if (h.newPiSessionId) {
      // Initial handoff: the client launched Pi with `--session-id`; discover
      // the file it created under the configured storage root, then prove it.
      const found = findSessionFileBySuffix(this.deps.config.sessionStorageRoot, h.newPiSessionId);
      const proof = found
        ? validatePersistedSession({
          sessionStorageRoot: this.deps.config.sessionStorageRoot,
          expectedSessionId: h.newPiSessionId,
          sessionFile: found,
        })
        : { ok: false as const, capability: "session_missing" as const, reason: "no session file created by Pi" };
      if (proof.ok) {
        provedIdentity = { sessionId: proof.sessionId, canonicalFile: proof.canonicalFile };
        updates.resumeCapability = "available";
        state = forceEnded ? "ended" : input.code === 0 ? "idle" : "interrupted";
      } else {
        updates.resumeCapability = proof.capability;
        state = forceEnded ? "ended" : "interrupted";
      }
    } else {
      updates.resumeCapability = "never_started";
      state = forceEnded ? "ended" : "interrupted";
    }

    if (provedIdentity) {
      updates.piSessionId = provedIdentity.sessionId;
      updates.piSessionFile = provedIdentity.canonicalFile;
    }
    this.deps.store.casTransition(input.sessionId, ["starting", "ended"], state, updates, h.generation);
    this.releaseNativeHandoff(h);
    logInfo(TAG, `Native handoff ${input.sessionId} ended (code ${input.code}) -> ${state}`);
    return { ok: true, message: state === "idle" ? "Pi session returned to idle" : state === "ended" ? "Coding session ended" : `Pi session ended abnormally (${state})` };
  }

  /**
   * The handoff connection died. The client-owned Pi process may still be
   * alive and writing the session file: if its recorded pid is live, keep the
   * workspace claim and writer lease (the next handoff's prior-writer check
   * blocks until the process actually exits); otherwise release everything.
   * A live orphan keeps the shared slot reserved as well, because releasing
   * it would let a second Pi writer start while the first still writes.
   */
  abortNativeHandoff(leaseOwner: string): void {
    for (const [sessionId, h] of this.nativeHandoffs) {
      if (h.leaseOwner !== leaseOwner) continue;
      this.nativeHandoffs.delete(sessionId);
      const rec = this.deps.store.get(sessionId);
      if (!rec) {
        // The generation row may have been removed concurrently, but the
        // native handoff still owns the slot represented by `h`.
        this.deps.host.releaseSlot();
        continue;
      }
      const capability = this.capabilityForRow(rec);
      const orphanWrites = h.started && rec.observedPid !== undefined && isProcessAlive(rec.observedPid);
      if (orphanWrites) {
        // Keep the claim + lease as the exclusive-writer fence. An explicit
        // end remains terminal, but resources stay held until the writer is
        // proven gone.
        this.deps.store.casTransition(sessionId, ["starting", "interrupted", "ended"], h.endRequested ? "ended" : "interrupted", {
          resumeCapability: capability,
        }, h.generation);
        this.recoveredNativeSlots.add(this.nativeSlotKey(sessionId, h.generation));
        this.watchRecoveredNativeWriter(sessionId, h.generation);
        logWarn(TAG, `Native handoff ${sessionId} connection died; writer pid ${rec.observedPid} still alive — claim kept`);
        continue;
      }
      const finalState = h.endRequested ? "ended" : "interrupted";
      this.deps.store.casTransition(sessionId, ["starting", "interrupted", "ended"], finalState, {
        resumeCapability: capability,
        observedPid: null,
      }, h.generation);
      if (rec.leaseGeneration !== undefined) {
        this.deps.store.clearLease(sessionId, rec.leaseGeneration);
      }
      this.deps.claims.releaseForGeneration({ ownerId: sessionId, generation: h.generation });
      this.deps.host.releaseSlot();
      if (finalState === "ended") this.finalizeEndedCodingEnvelope(sessionId);
      logWarn(TAG, `Native handoff ${sessionId} aborted (connection lost) — resources released`);
      continue;
    }
  }

  // ── native handoff helpers ──────────────────────────────────────────────

  /** Resolve the client's `/coding...` line to a session (Telegram semantics). */
  private resolveHandoffTarget(
    command: string,
    ownerPrincipal: string,
  ): { ok: true; rec: PiCodingSessionRecord } | { ok: false; reason: string } {
    const args = command.replace(/^\/coding\s*/i, "").trim();
    if (args.startsWith("new")) {
      const alias = args.slice("new".length).trim();
      if (!alias) return { ok: false, reason: "Usage: /coding new <workspace-alias>" };
      try {
        const created = this.createCodingSession({ ownerPrincipal, workspaceAlias: alias });
        const rec = this.deps.store.get(created.sessionId);
        if (!rec) return { ok: false, reason: "Coding session could not be created" };
        return { ok: true, rec };
      } catch (err) {
        return { ok: false, reason: boundedError(err) };
      }
    }
    const explicit = args.replace(/^resume\s*/i, "").trim();
    if (explicit) {
      const rec = this.getSession(explicit, ownerPrincipal);
      if (!rec) return { ok: false, reason: "Coding session not found" };
      return { ok: true, rec };
    }
    const candidates = this.deps.store.listForOwner(ownerPrincipal);
    if (candidates.length > 1) {
      const choices = candidates.slice(0, 5).map((candidate, index) =>
        `${index + 1}. ${candidate.sessionId} (${candidate.workspaceAlias}, ${candidate.state})`
      ).join("; ");
      return { ok: false, reason: `Multiple coding sessions — choose one with /coding resume <sessionId>: ${choices}` };
    }
    const rec = candidates[0] ?? null;
    if (!rec) return { ok: false, reason: "No coding sessions. Start one with /coding new <workspace-alias>." };
    return { ok: true, rec };
  }

  /** Release the generation-owned slot/claim/lease of a finished handoff. */
  private releaseNativeHandoff(h: NativeHandoffState): void {
    const ended = this.deps.store.get(h.sessionId)?.state === "ended";
    const recovered = this.recoveredNativeSlots.has(this.nativeSlotKey(h.sessionId, h.generation));
    this.nativeHandoffs.delete(h.sessionId);
    this.deps.store.clearObservedPid(h.sessionId, h.generation);
    this.deps.store.clearLease(h.sessionId, h.generation);
    this.deps.claims.releaseForGeneration({ ownerId: h.sessionId, generation: h.generation });
    if (recovered) this.releaseRecoveredNativeSlot(h.sessionId, h.generation);
    else this.deps.host.releaseSlot();
    if (ended) this.finalizeEndedCodingEnvelope(h.sessionId);
  }

  /** Request native Pi termination without releasing its exclusive resources. */
  private requestNativeHandoffEnd(h: NativeHandoffState): void {
    h.endRequested = true;
    this.deps.store.casTransition(h.sessionId, ["starting", "interrupted", "ended"], "ended", {
      pendingRequestId: null,
      pendingRequestType: null,
    }, h.generation);
    const rec = this.deps.store.get(h.sessionId);
    if (rec?.observedPid === undefined || !isProcessAlive(rec.observedPid)) return;
    try {
      process.kill(rec.observedPid, "SIGTERM");
      logInfo(TAG, `Requested native Pi termination for ${h.sessionId} (pid ${rec.observedPid})`);
    } catch (err) {
      logWarn(TAG, `Could not terminate native Pi for ${h.sessionId}: ${boundedError(err)}`);
    }
  }

  /** Finalize the durable Spin envelope after an explicitly ended handoff. */
  private finalizeEndedCodingEnvelope(sessionId: string): void {
    try {
      this.deps.spin.endCodingExternalSession(sessionId, sessionId);
    } catch { /* best effort; the durable row is already terminal */ }
  }

  private nativeSlotKey(sessionId: string, generation: number): string {
    return `${sessionId}:${generation}`;
  }

  private adoptRecoveredNativeSlot(sessionId: string, generation: number): void {
    const key = this.nativeSlotKey(sessionId, generation);
    if (this.recoveredNativeSlots.has(key)) return;
    this.recoveredNativeSlots.add(key);
    this.deps.host.adoptRecoveredSlot();
    this.watchRecoveredNativeWriter(sessionId, generation);
  }

  private releaseRecoveredNativeSlot(sessionId: string, generation: number): void {
    const key = this.nativeSlotKey(sessionId, generation);
    if (!this.recoveredNativeSlots.delete(key)) return;
    const timer = this.nativeRecoveryWatches.get(key);
    if (timer) clearTimeout(timer);
    this.nativeRecoveryWatches.delete(key);
    this.deps.host.releaseSlot();
  }

  /**
   * Poll a recovered client-owned PID until it exits. The bridge cannot reap
   * the child itself, but it can safely release the durable fence once the
   * exact recorded writer is gone. Timers are unref'ed so shutdown is never
   * held open by recovery bookkeeping.
   */
  private watchRecoveredNativeWriter(sessionId: string, generation: number): void {
    const key = this.nativeSlotKey(sessionId, generation);
    if (!this.recoveredNativeSlots.has(key) || this.nativeRecoveryWatches.has(key)) return;
    const poll = (): void => {
      this.nativeRecoveryWatches.delete(key);
      if (!this.recoveredNativeSlots.has(key)) return;
      const rec = this.deps.store.get(sessionId);
      if (!rec || rec.runtimeGeneration !== generation || rec.observedPid === undefined || !isProcessAlive(rec.observedPid)) {
        this.reapRecoveredNativeWriter(sessionId, generation);
        return;
      }
      this.watchRecoveredNativeWriter(sessionId, generation);
    };
    const timer = setTimeout(poll, NATIVE_RECOVERY_POLL_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.nativeRecoveryWatches.set(key, timer);
  }

  /** Release a recovered writer's claim/lease only after its PID is gone. */
  private reapRecoveredNativeWriter(sessionId: string, generation: number): void {
    const key = this.nativeSlotKey(sessionId, generation);
    if (!this.recoveredNativeSlots.has(key)) return;
    const rec = this.deps.store.get(sessionId);
    if (!rec || rec.runtimeGeneration !== generation) {
      this.releaseRecoveredNativeSlot(sessionId, generation);
      return;
    }
    if (rec.observedPid !== undefined && isProcessAlive(rec.observedPid)) {
      this.watchRecoveredNativeWriter(sessionId, generation);
      return;
    }

    const reconciled = this.discoverPendingSessionFile(rec);
    const capability = this.capabilityForRow(reconciled);
    const leaseGeneration = reconciled.leaseGeneration ?? generation;
    this.deps.store.casTransition(sessionId, ["starting", "interrupted", "ended"], reconciled.state, {
      resumeCapability: capability,
      observedPid: null,
    }, generation);
    this.deps.store.clearLease(sessionId, leaseGeneration);
    this.deps.claims.releaseForGeneration({ ownerId: sessionId, generation });
    this.releaseRecoveredNativeSlot(sessionId, generation);
    if (reconciled.state === "ended") this.finalizeEndedCodingEnvelope(sessionId);
    logInfo(TAG, `Recovered native writer ${sessionId} exited; resources released`);
  }

  /**
   * An initial native launch publishes its expected session id before the
   * client has a chance to report a file.  After a bridge restart, recover a
   * file that Pi created from that durable id; never mark it resumable unless
   * the normal bounded header/containment proof succeeds.
   */
  private discoverPendingSessionFile(rec: PiCodingSessionRecord): PiCodingSessionRecord {
    if (!rec.piSessionId || rec.piSessionFile) return rec;
    const found = findSessionFileBySuffix(this.deps.config.sessionStorageRoot, rec.piSessionId);
    if (!found) return rec;
    const proof = validatePersistedSession({
      sessionStorageRoot: this.deps.config.sessionStorageRoot,
      expectedSessionId: rec.piSessionId,
      sessionFile: found,
    });
    if (!proof.ok) return rec;
    this.deps.store.casTransition(rec.sessionId, rec.state, rec.state, {
      piSessionId: proof.sessionId,
      piSessionFile: proof.canonicalFile,
      resumeCapability: "available",
    }, rec.runtimeGeneration);
    return this.deps.store.get(rec.sessionId) ?? rec;
  }

  /**
   * Bridge shutdown: abort every live turn; leave sessions interrupted.
   */
  async interruptAll(): Promise<void> {
    const snapshot = [...this.live.values()];
    await Promise.all(snapshot.map(async (owned) => {
      owned.settling = true;
      const rec = this.deps.store.get(owned.sessionId);
      const capability = rec ? await this.probeCapability(owned) : ("session_missing" as ResumeCapability);
      this.deps.store.casTransition(owned.sessionId, ["starting", "running", "awaiting_input"], "interrupted", {
        pendingRequestId: null, pendingRequestType: null,
        resumeCapability: capability,
      }, owned.generation);
      await this.releaseTurn(owned);
    }));
    this.live.clear();
  }

  /**
   * #1635 — Boot reconciliation (Task 5). A crash mid-turn leaves rows in live
   * states with a stale lease/claim. Mark them `interrupted` with a capability
   * derived from the persisted-session proof — never from the presence of a
   * session id — and release every generation-owned resource so workers on
   * the same checkout proceed.
   */
  reconcileOnBoot(): void {
    for (const rec of this.deps.store.listLive()) {
      const reconciled = this.discoverPendingSessionFile(rec);
      const capability = this.capabilityForRow(reconciled);
      const nativeWriterAlive = reconciled.leaseFrontend === "native-tui"
        && reconciled.observedPid !== undefined
        && isProcessAlive(reconciled.observedPid);
      this.deps.store.casTransition(rec.sessionId, ["starting", "running", "awaiting_input", "resuming"], "interrupted", {
        resumeCapability: capability,
        pendingRequestId: null,
        pendingRequestType: null,
        observedPid: nativeWriterAlive ? reconciled.observedPid : null,
      }, rec.runtimeGeneration);
      if (nativeWriterAlive) {
        // #1635 Phase 2 — a native handoff's Pi process is CLIENT-owned and
        // survives the bridge restart. It may still be writing the session
        // file: keep the claim + lease as the exclusive-writer fence; the
        // next handoff accept self-heals them once the pid is proven gone.
        if (!this.nativeHandoffs.has(reconciled.sessionId)) {
          this.adoptRecoveredNativeSlot(reconciled.sessionId, reconciled.runtimeGeneration);
        }
        logWarn(TAG, `Coding session ${rec.sessionId}: native writer pid ${reconciled.observedPid} alive at boot — claim kept`);
        continue;
      }
      this.deps.claims.releaseForGeneration({ ownerId: rec.sessionId, generation: rec.runtimeGeneration });
      this.deps.store.clearLease(rec.sessionId, rec.runtimeGeneration);
      this.releaseRecoveredNativeSlot(reconciled.sessionId, reconciled.runtimeGeneration);
      logInfo(TAG, `Coding session ${rec.sessionId} interrupted at boot (capability ${capability})`);
    }
    for (const rec of this.deps.store.listStaleLeases()) {
      if (rec.leaseGeneration === undefined) continue;
      const reconciled = this.discoverPendingSessionFile(rec);
      const nativeWriterAlive = reconciled.leaseFrontend === "native-tui"
        && reconciled.observedPid !== undefined
        && isProcessAlive(reconciled.observedPid);
      if (nativeWriterAlive) {
        // same fence for rows that crashed outside the live states
        if (!this.nativeHandoffs.has(reconciled.sessionId)) {
          this.adoptRecoveredNativeSlot(reconciled.sessionId, reconciled.runtimeGeneration);
        }
        logWarn(TAG, `Coding session ${rec.sessionId}: native writer pid ${reconciled.observedPid} alive at boot — lease kept`);
        continue;
      }
      this.deps.store.casTransition(reconciled.sessionId, reconciled.state, reconciled.state, {
        observedPid: null,
      }, reconciled.runtimeGeneration);
      this.deps.claims.releaseForGeneration({ ownerId: reconciled.sessionId, generation: reconciled.runtimeGeneration });
      this.deps.store.clearLease(reconciled.sessionId, rec.leaseGeneration);
      this.releaseRecoveredNativeSlot(reconciled.sessionId, reconciled.runtimeGeneration);
      if (reconciled.state === "ended") this.finalizeEndedCodingEnvelope(reconciled.sessionId);
      logInfo(TAG, `Coding session ${rec.sessionId}: cleared stale lease (gen ${rec.leaseGeneration})`);
    }
  }

  /** Proof-derived capability for a row, truthful by construction. */
  private capabilityForRow(rec: PiCodingSessionRecord): ResumeCapability {
    const proof = validatePersistedSession({
      sessionStorageRoot: this.deps.config.sessionStorageRoot,
      expectedSessionId: rec.piSessionId,
      sessionFile: rec.piSessionFile,
    });
    return proof.ok ? "available" : proof.capability;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private authorize(sessionId: string, ownerPrincipal: string): PiCodingSessionRecord | null {
    const rec = this.deps.store.get(sessionId);
    if (!rec || rec.ownerPrincipal !== ownerPrincipal) return null;
    return rec;
  }

  /**
   * Turn-start transaction: advance generation + CAS idle/interrupted ->
   * starting + acquire the interactive workspace claim, atomically. Throwing
   * the rollback sentinel rolls back every write so the session stays idle.
   */
  private txTurnStart(
    rec: PiCodingSessionRecord,
    currentGen: number,
    intent: "initial" | "resume",
    leaseOwner: string,
    canonicalPath: string,
    frontend: PiCodingLeaseFrontend = "telegram-rpc",
    initialPiSessionId?: string,
  ): { ok: true; generation: number } | { ok: false; busy: boolean } {
    let outcome: { ok: true; generation: number } | { ok: false; busy: boolean } = { ok: false, busy: false };
    const run = (): void => {
      if (!this.deps.store.advanceGeneration(rec.sessionId, currentGen, intent)) {
        outcome = { ok: false, busy: false };
        throw TURN_START_ROLLBACK;
      }
      const generation = currentGen + 1;
      const cas = this.deps.store.casTransition(
        rec.sessionId, ["idle", "suspended", "interrupted"], "starting",
        initialPiSessionId
          ? { piSessionId: initialPiSessionId, piSessionFile: null, resumeCapability: "never_started" }
          : {},
        generation,
      );
      if (!cas.applied) {
        outcome = { ok: false, busy: false };
        throw TURN_START_ROLLBACK;
      }
      const claim = this.deps.claims.tryAcquireInTx({
        canonicalPath,
        ownerId: rec.sessionId,
        generation,
        ownerKind: "interactive",
      });
      if (claim.kind !== "claimed" && claim.kind !== "idempotent") {
        outcome = { ok: false, busy: true };
        throw TURN_START_ROLLBACK;
      }
      if (!this.setLeaseInTx(rec.sessionId, generation, leaseOwner, frontend)) {
        // A stale lease on an otherwise startable row is still an exclusive
        // writer. Roll back the whole transaction rather than launching a
        // process with no durable lease fence.
        outcome = { ok: false, busy: true };
        throw TURN_START_ROLLBACK;
      }
      outcome = { ok: true, generation };
    };
    try {
      this.deps.store.transaction(run);
    } catch (err) {
      if (err !== TURN_START_ROLLBACK) throw err;
    }
    return outcome;
  }

  private setLeaseInTx(sessionId: string, generation: number, leaseOwner: string, frontend: PiCodingLeaseFrontend): boolean {
    return this.deps.store.setLease(sessionId, {
      frontend,
      owner: leaseOwner,
      generation,
      acquiredAt: new Date().toISOString(),
    }, generation);
  }

  private async launchTurn(
    rec: PiCodingSessionRecord,
    generation: number,
    canonicalPath: string,
  ): Promise<{ ok: true; owned: OwnedTurn } | { ok: false; reason: string }> {
    let launched: Awaited<ReturnType<PiRuntimeHost["launch"]>>;
    try {
      launched = await this.deps.host.launch({
        workspaceAlias: rec.workspaceAlias,
        envIdentity: {
          id: rec.sessionId,
          ownerPrincipalId: rec.ownerPrincipal,
          executionGeneration: generation,
        },
        memoryMode: rec.memoryMode,
      });
    } catch (err) {
      this.deps.claims.releaseForGeneration({ ownerId: rec.sessionId, generation });
      this.deps.store.clearLease(rec.sessionId, generation);
      this.deps.store.casTransition(rec.sessionId, "starting", "idle", {}, generation);
      this.deps.host.releaseSlot();
      return { ok: false, reason: boundedError(err) };
    }
    if (!launched.ok) {
      this.deps.claims.releaseForGeneration({ ownerId: rec.sessionId, generation });
      this.deps.store.clearLease(rec.sessionId, generation);
      this.deps.store.casTransition(rec.sessionId, "starting", "idle", {}, generation);
      this.deps.host.releaseSlot();
      return { ok: false, reason: launched.error };
    }
    const owned: OwnedTurn = {
      sessionId: rec.sessionId,
      generation,
      client: launched.client,
      workspacePath: canonicalPath,
      beforeEvidence: captureGitEvidence(canonicalPath),
      settling: false,
      released: false,
      endRequested: false,
      abortTimer: null,
      wallClockStart: Date.now(),
      unsubTermination: null,
      unsubEvents: null,
      unsubUi: null,
    };
    return { ok: true, owned };
  }

  private registerListeners(owned: OwnedTurn): void {
    owned.unsubTermination = owned.client.onTermination(() => {
      this.onChildTerminated(owned);
    });
    owned.unsubEvents = owned.client.subscribe((event) => {
      this.onRpcEvent(owned, event);
    });
    owned.unsubUi = owned.client.onUiRequest((request) => {
      this.onUiRequest(owned, request);
    });
  }

  private async resolveIdentity(
    rec: PiCodingSessionRecord,
    owned: OwnedTurn,
    intent: "initial" | "resume",
  ): Promise<{ ok: true; sessionId: string; sessionFile?: string } | { ok: false; capability: Exclude<ResumeCapability, "available">; reason: string }> {
    try {
      if (intent === "resume") {
        // R4.4 — resume requires a proven target, never an inferred one.
        const proof = validatePersistedSession({
          sessionStorageRoot: this.deps.config.sessionStorageRoot,
          expectedSessionId: rec.piSessionId,
          sessionFile: rec.piSessionFile,
        });
        if (!proof.ok) {
          this.deps.store.recordResumeCapability(rec.sessionId, proof.capability);
          return { ok: false, capability: proof.capability, reason: proof.reason };
        }
        const switched = await owned.client.switchSession(proof.canonicalFile);
        if (switched.cancelled) {
          this.deps.store.recordResumeCapability(rec.sessionId, "session_missing");
          return { ok: false, capability: "session_missing", reason: "Session switch was cancelled" };
        }
        const state = await owned.client.getState();
        if (state.sessionId !== rec.piSessionId) {
          this.deps.store.recordResumeCapability(rec.sessionId, "session_missing");
          return { ok: false, capability: "session_missing", reason: "Switched session identity mismatch" };
        }
        const resumedProof = validatePersistedSession({
          sessionStorageRoot: this.deps.config.sessionStorageRoot,
          expectedSessionId: state.sessionId,
          sessionFile: state.sessionFile,
        });
        if (!resumedProof.ok) {
          this.deps.store.recordResumeCapability(rec.sessionId, resumedProof.capability);
          return { ok: false, capability: resumedProof.capability, reason: resumedProof.reason };
        }
        return { ok: true, sessionId: state.sessionId, sessionFile: resumedProof.canonicalFile };
      }
      // Initial — persist the fresh identity with a truthfully derived
      // capability, never an optimistic one.
      const state = await owned.client.getState();
      const proof = validatePersistedSession({
        sessionStorageRoot: this.deps.config.sessionStorageRoot,
        expectedSessionId: state.sessionId,
        sessionFile: state.sessionFile,
      });
      if (!proof.ok) {
        this.deps.store.recordResumeCapability(rec.sessionId, proof.capability);
        return { ok: false, capability: proof.capability, reason: proof.reason };
      }
      return { ok: true, sessionId: proof.sessionId, sessionFile: proof.canonicalFile };
    } catch (err) {
      return { ok: false, capability: "session_missing", reason: boundedError(err) };
    }
  }

  /** Final agent_end: persist proof, gather bounded evidence, return to idle. */
  private async finishTurn(
    owned: OwnedTurn,
    identity: { sessionId: string; sessionFile?: string },
    why: "turn" | "compact",
  ): Promise<void> {
    // `agent_end`, process termination, and compact completion can race. The
    // first path to settle owns the generation; later paths must not consume
    // another process's shared slot.
    if (owned.settling) return;
    owned.settling = true;
    const sessionId = owned.sessionId;
    const afterEvidence = captureGitEvidence(owned.workspacePath);
    const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
    const usage = await owned.client.getSessionStats().catch(() => ({}));
    const usageJson = JSON.stringify(usage).slice(0, 1000);
    const proof = validatePersistedSession({
      sessionStorageRoot: this.deps.config.sessionStorageRoot,
      expectedSessionId: identity.sessionId,
      sessionFile: identity.sessionFile,
    });
    const updates: PiCodingTransitionUpdates = {
      usageJson,
      changedFilesSummary: summary,
      resumeCapability: proof.ok ? "available" : proof.capability,
      pendingRequestId: null,
      pendingRequestType: null,
    };
    if (proof.ok) {
      // Persist the canonical, proof-backed path. If final state is malformed
      // or missing, retain the last known identity and downgrade capability;
      // never turn an unproven path into `available`.
      updates.piSessionId = proof.sessionId;
      updates.piSessionFile = proof.canonicalFile;
    }
    const transitioned = this.deps.store.casTransition(sessionId, "running", "idle", updates, owned.generation);
    if (transitioned.applied && why === "turn") {
      const finalText = await owned.client.getLastAssistantText().catch(() => null);
      if (finalText) this.deps.sink.assistantText(sessionId, finalText);
    }
    this.deps.sink.turnComplete(sessionId, { usageJson, changedFilesSummary: summary });
    await this.releaseTurn(owned);
    logInfo(TAG, `Coding turn ${sessionId} (gen ${owned.generation}) returned to idle (${why})`);
  }

  /** Abort path: close the process, release slot/claim/lease, return to idle. */
  private cancelTurn(owned: OwnedTurn, reason: string): void {
    if (owned.settling) return;
    owned.settling = true;
    owned.client.abort().catch(() => {});
    const graceMs = this.deps.config.abortGraceMs;
    owned.abortTimer = setTimeout(() => {
      if (this.live.get(owned.sessionId) !== owned) return;
      void owned.client.close();
      const afterEvidence = captureGitEvidence(owned.workspacePath);
      const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
      this.deps.store.casTransition(owned.sessionId, ["running", "awaiting_input", "starting"], "idle", {
        changedFilesSummary: summary,
        pendingRequestId: null, pendingRequestType: null,
      }, owned.generation);
      this.deps.sink.turnComplete(owned.sessionId, { changedFilesSummary: summary, error: reason });
      void this.releaseTurn(owned);
    }, graceMs);
  }

  /** Failure teardown with a truthful capability; session returns to idle. */
  private async teardownTurn(
    owned: OwnedTurn,
    capability: ResumeCapability,
    reason: string,
  ): Promise<void> {
    if (owned.settling) return;
    owned.settling = true;
    this.deps.store.casTransition(owned.sessionId, "starting", "idle", {
      resumeCapability: capability,
      pendingRequestId: null, pendingRequestType: null,
    }, owned.generation);
    this.deps.sink.turnComplete(owned.sessionId, { error: reason });
    await this.releaseTurn(owned);
  }

  /** Release every generation-owned resource exactly once. */
  private async releaseTurn(owned: OwnedTurn): Promise<void> {
    if (owned.released) return;
    owned.released = true;
    if (owned.abortTimer) { clearTimeout(owned.abortTimer); owned.abortTimer = null; }
    if (owned.unsubTermination) { owned.unsubTermination(); owned.unsubTermination = null; }
    if (owned.unsubEvents) { owned.unsubEvents(); owned.unsubEvents = null; }
    if (owned.unsubUi) { owned.unsubUi(); owned.unsubUi = null; }
    try { await owned.client.closeAndWait(); } catch { /* ignore */ }
    this.deps.store.clearObservedPid(owned.sessionId, owned.generation);
    this.deps.store.clearLease(owned.sessionId, owned.generation);
    this.deps.claims.releaseForGeneration({ ownerId: owned.sessionId, generation: owned.generation });
    this.deps.host.releaseSlot();
    if (this.live.get(owned.sessionId) === owned) {
      this.live.delete(owned.sessionId);
    }
    if (owned.endRequested) {
      this.deps.store.markEnded(owned.sessionId);
      try {
        this.deps.spin.endCodingExternalSession(owned.sessionId, owned.sessionId);
      } catch { /* best effort */ }
      logInfo(TAG, `Coding session ${owned.sessionId} ended after Pi teardown`);
    }
  }

  private async onChildTerminated(owned: OwnedTurn): Promise<void> {
    if (owned.settling) return;
    if (owned.client.closed) return;
    if (owned.abortTimer) return; // cancelling — the grace timer settles
    owned.settling = true;
    logWarn(TAG, `Unexpected Pi process termination for ${owned.sessionId} (gen=${owned.generation})`);
    const afterEvidence = captureGitEvidence(owned.workspacePath);
    const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
    this.deps.store.casTransition(owned.sessionId, ["running", "awaiting_input", "starting"], "idle", {
      changedFilesSummary: summary,
      resumeCapability: "session_missing",
      pendingRequestId: null, pendingRequestType: null,
    }, owned.generation);
    this.deps.sink.turnComplete(owned.sessionId, { changedFilesSummary: summary, error: "Pi process terminated unexpectedly" });
    await this.releaseTurn(owned);
  }

  private async onRpcEvent(owned: OwnedTurn, event: PiAgentEvent): Promise<void> {
    if (owned.settling || owned.released) return;
    this.deps.store.touchActivity(owned.sessionId, owned.generation);
    const proj = projectPiEvent(event);
    for (const p of proj.progress) {
      if (p.type === "tool_execution_start" || p.type === "tool_execution_end") {
        try {
          const name = (JSON.parse(p.json) as { name?: string }).name ?? "tool";
          this.deps.sink.tool(owned.sessionId, name, p.type === "tool_execution_start");
        } catch { /* ignore */ }
      } else if (p.type === "agent_start" || p.type === "compaction" || p.type === "auto_retry") {
        this.deps.sink.progress(owned.sessionId, p.type.replace(/_/g, " "));
      }
    }
    if (proj.settleCompletion) {
      // agent_end — persist proof and return the session to idle. Never
      // settles a card, never deletes anything.
      try {
        const state = await owned.client.getState();
        const identity = { sessionId: state.sessionId, sessionFile: state.sessionFile };
        await this.finishTurn(owned, identity, "turn");
      } catch (err) {
        logWarn(TAG, `agent_end settlement failed for ${owned.sessionId}: ${boundedError(err)}`);
        this.deps.store.casTransition(owned.sessionId, "running", "interrupted", {
          resumeCapability: "session_missing",
        }, owned.generation);
        await this.releaseTurn(owned);
      }
    }
  }

  private async onUiRequest(owned: OwnedTurn, request: RpcExtensionUIRequest): Promise<void> {
    if (owned.settling || owned.released) return;
    this.deps.store.touchActivity(owned.sessionId, owned.generation);
    const method = request.method;
    const dialogMethods = new Set(["select", "confirm", "input", "editor"]);
    if (dialogMethods.has(method)) {
      const result = this.deps.store.casTransition(owned.sessionId, "running", "awaiting_input", {
        pendingRequestId: request.id,
        pendingRequestType: method as PiCodingUiType,
      }, owned.generation);
      if (result.applied) {
        this.deps.sink.uiRequest(owned.sessionId, request);
      } else {
        logWarn(TAG, `UI request rejected for ${owned.sessionId} (gen=${owned.generation}, req=${request.id})`);
      }
    } else if (method === "notify") {
      this.deps.sink.progress(owned.sessionId, String((request as { message?: unknown }).message ?? ""));
    }
  }

  /** Event-driven per-turn wall clock — no new timers. An idle session is
   * never killed by a process-age clock. */
  private checkWallClock(owned: OwnedTurn): boolean {
    if (Date.now() - owned.wallClockStart <= this.deps.config.maxWallClockMs) return false;
    logWarn(TAG, `Coding turn ${owned.sessionId} exceeded max wall clock — aborting`);
    this.cancelTurn(owned, "Cancelled: maximum wall clock exceeded");
    return true;
  }

  /** Bounded live-state probe for interruption capability. */
  private async probeCapability(owned: OwnedTurn): Promise<ResumeCapability> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let state: { sessionId: string; sessionFile?: string } | null = null;
    try {
      state = await Promise.race([
        owned.client.getState(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 2_000);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    } catch {
      state = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!state) return "session_missing";
    const proof = validatePersistedSession({
      sessionStorageRoot: this.deps.config.sessionStorageRoot,
      expectedSessionId: state.sessionId,
      sessionFile: state.sessionFile,
    });
    return proof.ok ? "available" : proof.capability;
  }
}

type PiCodingUiType = "select" | "confirm" | "input" | "editor";

/** Bounded, content-free error text. */
function boundedError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

/** True when a pid names a live process on this host (ESRCH = gone). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const SESSION_FILE_SCAN_MAX_ENTRIES = 2000;
const SESSION_FILE_SCAN_MAX_DEPTH = 8;

/**
 * Bounded recursive scan of the session storage root for the file Pi created
 * for a `--session-id` launch: `<root>/--<encoded-cwd>--/<timestamp>_<id>.jsonl`.
 * Bounded by entry count and directory depth — never a full-tree walk.
 */
export function findSessionFileBySuffix(root: string, sessionId: string): string | null {
  const suffix = `_${sessionId}.jsonl`;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > SESSION_FILE_SCAN_MAX_DEPTH) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited++ >= SESSION_FILE_SCAN_MAX_ENTRIES) return null;
      if (entry.isDirectory()) {
        stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return join(dir, entry.name);
      }
    }
  }
  return null;
}
