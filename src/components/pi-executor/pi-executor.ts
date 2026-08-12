import { logInfo, logWarn, logDebug } from "../logger.js";
import { PiRpcError, SupervisedPiRpcClient, type PiProcessTermination, type PiAgentEvent } from "./pi-rpc-client.js";
import { projectPiEvent } from "./pi-event-projection.js";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { PiRunStore, type PiTerminalOutcome } from "./pi-run-store.js";
import type { PiExecutorConfig } from "./config.js";
import { validatePersistedSession, type SessionProof } from "./config.js";
import { PiRuntimeHost } from "./pi-runtime-host.js";
import type { PiRunRecord, PiRunStatus, PiPendingRequestType, PiUiReply, PendingUiClaim, ResumeCapability } from "./types.js";
import { captureGitEvidence, computeChangedFilesSummary } from "./evidence.js";
import { nerve } from "../nerve.js";

const TAG = "pi-executor";

/** #1647 — generation-fenced end of the external Spin C session. The spin
 * layer validates the immutable (runId, generation) metadata itself. */
export type EndExternalSession = (
  sessionId: string,
  expected: { runId: string; generation: number },
) => boolean;

/** Bounded live-state probe before graceful interruption. */
const INTERRUPT_PROBE_MS = 2_000;

interface OwnedProcess {
  client: SupervisedPiRpcClient;
  generation: number;
  runId: string;
  workspacePath: string;
  sessionId: string;
  beforeEvidence: { head?: string; status?: string } | null;
  abortTimer: ReturnType<typeof setTimeout> | null;
  wallClockStart: number;
  settling: boolean;
  unsubTermination: (() => void) | null;
  unsubEvents: (() => void) | null;
  unsubUi: (() => void) | null;
}

export interface PiTerminalObservation {
  runId: string;
  generation: number;
  outcome: PiTerminalOutcome;
  /** Optional narrow status fence for pre-live failures. */
  expectedStatuses?: PiRunStatus[];
  metadata: { resultSummary?: string; changedFilesSummary?: string; usageJson?: string; error?: string; piSessionId?: string };
  envelope?: import("../worker-contract.js").WorkerResultEnvelopeV1;
  canonicalPath?: string;
}

export class PiExecutor {
  private readonly config_: PiExecutorConfig;
  private readonly store: PiRunStore;
  /** #1635 — shared Pi runtime host: the single process cap and spawn path
   * across `/pi run`, supervised workers, interactive turns, and native
   * handoffs. */
  readonly host: PiRuntimeHost;
  private readonly live = new Map<string, OwnedProcess>();
  private _stopped = false;
  private _onCapacityReleased: (() => void) | null = null;
  /** #1638 — optional supervised/standalone settlement router (wired at boot
   * when the coordinator exists). When set, every terminal observation goes
   * through it so supervised runs settle through the Worker attempt. */
  private _settlementRouter: ((input: PiTerminalObservation) => unknown) | null = null;
  /** #1638 — supervised input suspension hook. When set, an input request on
   * a SUPERVISED run suspends the run (interrupted) and settles the Worker
   * attempt as input_requested instead of leaving the process in
   * awaiting_input. Standalone runs keep the existing awaiting_input path. */
  private _inputSuspendHook: ((runId: string, generation: number, request: RpcExtensionUIRequest) => Promise<boolean>) | null = null;
  /** #1647 — generation-fenced closer for the external Spin C session. Wired
   * at boot from ctx.sessionManager.endExternalSession. */
  private _endExternalSession: EndExternalSession | null = null;
  /** #1647 — typed interruption router (wired at boot with the supervised
   * coordinator). Routes standalone vs supervised interruption; the fallback
   * uses the standalone store operation. */
  private _interruptRouter: ((input: { runId: string; generation: number; continuity: SessionProof }) => { interrupted: boolean }) | null = null;
  /** #1358 — Lifecycle transition subscribers (multi). */
  private _transitionSubs = new Set<(runId: string, fromStatus: string | undefined, toStatus: string) => void>();
  /** Progress event subscribers (multi). */
  private _progressSubs = new Set<(runId: string, payload: string, progressType?: string) => void>();

  constructor(config: PiExecutorConfig, store: PiRunStore) {
    this.config_ = config;
    this.store = store;
    this.host = new PiRuntimeHost(config);
    // #1635 — every slot release (executor-owned or interactive/native)
    // fans out to the shared post-release wake wired at boot.
    this.host.setOnSlotReleased(() => { this._onCapacityReleased?.(); });
  }

  get activeCount(): number { return this.host.reservedCount; }
  get maxConcurrent(): number { return this.config_.maxConcurrent; }
  get isStopped(): boolean { return this._stopped; }
  get piStore(): PiRunStore { return this.store; }
  get config(): PiExecutorConfig { return this.config_; }

  /** #1638 — route every terminal observation through the coordinator. */
  setSettlementRouter(router: (input: PiTerminalObservation) => unknown): void {
    this._settlementRouter = router;
  }

  /** #1638 — wire supervised input suspension (see coordinator). */
  setInputSuspendHook(hook: (runId: string, generation: number, request: RpcExtensionUIRequest) => Promise<boolean>): void {
    this._inputSuspendHook = hook;
  }

  /** #1647 — wire the generation-fenced external Spin C session closer. */
  setExternalSessionCloser(closer: EndExternalSession): void {
    this._endExternalSession = closer;
  }

  /** #1647 — wire the typed interruption router (standalone vs supervised). */
  setInterruptRouter(router: (input: { runId: string; generation: number; continuity: SessionProof }) => { interrupted: boolean }): void {
    this._interruptRouter = router;
  }

  /** Register a callback fired when a Pi slot is released. */
  onCapacityReleased(cb: () => void): void {
    this._onCapacityReleased = cb;
  }

  /** Notify dispatchers when a pre-live startup path releases no owned
   * process but still leaves a queued waiter eligible to run. */
  notifyCapacityReleased(): void {
    this._onCapacityReleased?.();
  }

  /** #1358 — Subscribe to run state transitions. Returns unsubscribe function. */
  onTransition(cb: (runId: string, fromStatus: string | undefined, toStatus: string) => void): () => void {
    this._transitionSubs.add(cb);
    return () => { this._transitionSubs.delete(cb); };
  }

  /** Subscribe to bounded public progress emission. Returns unsubscribe function. */
  onProgress(cb: (runId: string, payload: string, progressType?: string) => void): () => void {
    this._progressSubs.add(cb);
    return () => { this._progressSubs.delete(cb); };
  }

  /** #1358 — Fire the transition hook for a run. */
  private _fireTransition(runId: string, fromStatus: string | undefined, toStatus: string): void {
    for (const cb of this._transitionSubs) {
      try { cb(runId, fromStatus, toStatus); } catch { /* best effort */ }
    }
  }

  /**
   * #1405 — Start a Pi run that has already been claimed (durable queued→starting
   * + card queued→running committed by Reconciler). Register live ownership
   * before spawning so early exit/error cannot escape observation.
   */
  async startWithClaim(runId: string, generation: number, sessionId: string): Promise<"started" | "error"> {
    const run = this.store.get(runId);
    if (!run || run.executionGeneration !== generation || run.status !== "starting") {
      // Reconciler can lose the race with shutdown or a newer generation
      // after claiming a C session. Release only this exact generation.
      this.store.releaseWorkspaceClaimForGeneration({ runId, generation });
      try { this._endExternalSession?.(sessionId, { runId, generation }); } catch { /* best effort */ }
      return "error";
    }
    if (this._stopped) {
      await this._settleAndCleanupGen(runId, generation, ["starting"], "failed", { error: "Pi executor is stopping" });
      try { this._endExternalSession?.(sessionId, { runId, generation }); } catch { /* best effort */ }
      return "error";
    }

    // #1635 — synchronously reserve the shared process slot before spawn.
    // Capacity contention settles this generation; the reconciler's advisory
    // gate already checked the same cap, this is the authoritative fence.
    if (!this.host.tryReserveSlot()) {
      await this._settleAndCleanupGen(runId, generation, ["starting"], "failed", { error: "Pi capacity exhausted" });
      return "error";
    }

    this._fireTransition(runId, "queued", "starting");

    // Register live ownership immediately, before spawn
    const placeholder: OwnedProcess = {
      client: null!,
      generation,
      runId,
      workspacePath: "",
      sessionId,
      beforeEvidence: null,
      abortTimer: null,
      wallClockStart: Date.now(),
      settling: false,
      unsubTermination: null,
      unsubEvents: null,
      unsubUi: null,
    };
    this.live.set(runId, placeholder);

    try {
      const owned = await this._startProcess(run, sessionId);
      if (!owned) {
        this.live.delete(runId);
        // #1635 — the pre-live failure path releases the reserved slot. The
        // ws/launch-error branch already settled this generation inside
        // `_startProcess`; the CAS-fail branch settles nothing, so the
        // release here covers both (releaseSlot is guarded).
        this.host.releaseSlot();
        this.store.releaseWorkspaceClaimForGeneration({ runId, generation });
        // #1647 — a launch failure still ends the generation's external C
        // session (generation-fenced by the spin layer).
        this._endExternalSession?.(sessionId, { runId, generation });
        return "error";
      }
      this.live.set(runId, owned);

      logInfo(TAG, `Started Pi run ${runId} (generation ${generation}, ${run.workspaceAlias})`);

      const state = await owned.client.getState().catch(() => null);
      if (!state) {
        await this._settleAndCleanup(owned, "failed", { error: "Pi process did not report initial state" });
        return "error";
      }

      // #1647 — branch on the persisted generation intent, never on the
      // generation number or nullable session fields.
      const intent = run.generationIntent ?? "initial";
      if (intent === "resume") {
        const resumeOk = await this._startResumed(owned, run);
        if (!resumeOk) return "error";
      } else if (intent === "initial") {
        const initialOk = await this._startInitial(owned, run, state);
        if (!initialOk) {
          await this._settleAndCleanup(owned, "failed", { error: "Failed to transition run to running" });
          return "error";
        }
        const promptOk = await this._submitPrompt(runId, run.operationalGoal, generation);
        if (!promptOk) {
          await this._settleAndCleanup(owned, "failed", { error: "Initial prompt submission failed" });
          return "error";
        }
      } else {
        // Exhaustive — an unknown intent fails the generation closed.
        await this._settleAndCleanup(owned, "failed", { error: `Unknown generation intent ${String(intent)}` });
        return "error";
      }

      return "started";
    } catch (err) {
      const error = `Launch exception: ${err instanceof Error ? err.message : String(err)}`;
      const owned = this.live.get(runId);
      if (owned) {
        await this._settleAndCleanup(owned, "failed", { error });
      } else {
        // #1635 — no owned process: release the reserved slot alongside the
        // generation settlement.
        this.host.releaseSlot();
        // Keep even pre-live exceptions on the single terminal router; a
        // direct PiRunStore transition would strand the Worker attempt.
        await this._settleAndCleanupGen(runId, generation, ["starting"], "failed", { error });
      }
      return "error";
    }
  }

  /**
   * #1647 — Verified resume start. The fresh process identity stays memory-only
   * until the saved target is validated, switched, and verified:
   *
   *   validate saved target -> switch_session(saved file) -> get_state
   *   -> require saved ID and validate returned file/header
   *   -> CAS starting -> running persisting the VERIFIED SAVED identity
   *   -> followUp("Continue where we left off")
   *
   * The freshly launched empty session is never persisted as the resume
   * target. Any failure settles this generation once and submits neither the
   * original goal nor a post-failure continuation.
   */
  private async _startResumed(owned: OwnedProcess, run: PiRunRecord): Promise<boolean> {
    await this._configureModel(owned, run);
    // Validate the saved target from the claimed run record — path checks and
    // the bounded header/ID proof, never path existence alone.
    const proof = validatePersistedSession({
      sessionStorageRoot: this.config_.sessionStorageRoot,
      expectedSessionId: run.piSessionId,
      sessionFile: run.piSessionFile,
    });
    if (!proof.ok) {
      await this._settleAndCleanup(owned, "failed", { error: "Resume target failed persisted-session validation" });
      return false;
    }
    try {
      await owned.client.switchSession(proof.canonicalFile);
      const state = await owned.client.getState();
      if (state.sessionId !== run.piSessionId) {
        await this._settleAndCleanup(owned, "failed", { error: "Switched session identity mismatch" });
        return false;
      }
      const resumedProof = validatePersistedSession({
        sessionStorageRoot: this.config_.sessionStorageRoot,
        expectedSessionId: state.sessionId,
        sessionFile: state.sessionFile,
      });
      if (!resumedProof.ok) {
        await this._settleAndCleanup(owned, "failed", { error: "Resumed session failed persisted-session validation" });
        return false;
      }
      if (resumedProof.canonicalFile !== proof.canonicalFile) {
        // Pi must report the exact saved identity we admitted. A different
        // valid session under the same root is not a successful resume.
        await this._settleAndCleanup(owned, "failed", { error: "Switched session file identity mismatch" });
        return false;
      }
      const transitioned = this.store.casTransition(run.id, "starting", "running", {
        piSessionId: state.sessionId,
        piSessionFile: resumedProof.canonicalFile,
        resumeCapability: "available",
      }, run.executionGeneration);
      if (!transitioned) {
        // Post-switch running CAS lost — close the owned process and the
        // exact C session, never send followUp.
        await this._settleAndCleanup(owned, "failed", { error: "Failed to transition resumed run to running" });
        return false;
      }
      this._fireTransition(run.id, "starting", "running");
      await owned.client.followUp("Continue where we left off");
      this.store.touchActivity(run.id, run.executionGeneration);
      return true;
    } catch (err) {
      await this._settleAndCleanup(owned, "failed", {
        error: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  }

  /**
   * #1647 — Initial start: configure model, persist the fresh identity with a
   * truthfully derived capability (never optimistic), then CAS to running.
   * The caller submits the operational goal exactly once after this succeeds.
   */
  private async _startInitial(owned: OwnedProcess, run: PiRunRecord, state: { sessionId: string; sessionFile?: string }): Promise<boolean> {
    await this._configureModel(owned, run);
    const proof = validatePersistedSession({
      sessionStorageRoot: this.config_.sessionStorageRoot,
      expectedSessionId: state.sessionId,
      sessionFile: state.sessionFile,
    });
    const capability: ResumeCapability = proof.ok ? "available" : proof.capability;
    const transitioned = this.store.casTransition(run.id, "starting", "running", {
      piSessionId: state.sessionId,
      piSessionFile: proof.ok ? proof.canonicalFile : undefined,
      resumeCapability: capability,
    }, run.executionGeneration);
    if (transitioned) {
      this._fireTransition(run.id, "starting", "running");
    }
    return transitioned;
  }

  private async _configureModel(owned: OwnedProcess, run: PiRunRecord): Promise<void> {
    if (!run.modelId || !run.modelProvider) return;
    try {
      const models = await owned.client.getAvailableModels();
      const match = models.find(m => m.id === run.modelId);
      if (match) {
        await owned.client.setModel(run.modelProvider, run.modelId);
      } else {
        logWarn(TAG, `Requested model ${run.modelId} not available in Pi catalogue, using default`);
      }
    } catch (err) {
      logWarn(TAG, `Model selection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _startProcess(run: PiRunRecord, sessionId: string): Promise<OwnedProcess | null> {
    const gen = run.executionGeneration;

    // #1635 — spawn through the shared runtime host (canonical workspace
    // resolution, args/trust/env construction, process launch).
    const launched = await this.host.launch({
      workspaceAlias: run.workspaceAlias,
      envIdentity: {
        id: run.id,
        ownerPrincipalId: run.ownerPrincipalId,
        executionGeneration: gen,
      },
    });
    if (!launched.ok) {
      await this._settleAndCleanupGen(run.id, gen, ["starting"], "failed", { error: launched.error });
      return null;
    }
    const client = launched.client;

    if (!this.store.casTransition(run.id, ["starting"], "starting", { observedPid: client.pid }, gen)) {
      await client.close();
      await this._settleAndCleanupGen(run.id, gen, ["starting"], "failed", { error: "Pi run generation changed before launch" });
      return null;
    }

    const beforeEvidence = captureGitEvidence(launched.canonicalPath);
    const unsubTermination = client.onTermination((event) => {
      this._onChildTerminated(run.id, gen, event);
    });
    const unsubEvents = client.subscribe((event) => this._onRpcEvent(run.id, gen, event));
    const unsubUi = client.onUiRequest((request) => this._onUiRequest(run.id, gen, request));

    return {
      client,
      generation: gen,
      runId: run.id,
      workspacePath: launched.canonicalPath,
      sessionId,
      beforeEvidence,
      abortTimer: null,
      wallClockStart: Date.now(),
      settling: false,
      unsubTermination: unsubTermination ?? null,
      unsubEvents: unsubEvents ?? null,
      unsubUi: unsubUi ?? null,
    };
  }

  private async _onChildTerminated(runId: string, expectedGen: number, event: PiProcessTermination): Promise<void> {
    const owned = this.live.get(runId);
    if (!owned || owned.generation !== expectedGen) return;
    if (owned.settling) return;

    // An unowned process termination outside our intentional close
    if (owned.client.closed) return;

    if (owned.abortTimer) {
      // In cancelling — let the grace timer handle settlement
      return;
    }

    logWarn(TAG, `Unexpected Pi process termination for ${runId} (gen=${expectedGen}): ${event.kind === "exit" ? `exit code=${event.code} signal=${event.signal}` : `error=${event.error.message}`}`);
    const afterEvidence = captureGitEvidence(owned.workspacePath);
    const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
    await this._settleAndCleanup(owned, "failed", {
      error: `Process terminated unexpectedly (${event.kind === "exit" ? `code=${event.code}` : event.error.message})`,
      changedFilesSummary: summary,
    });
  }

  private async _submitPrompt(runId: string, goal: string, expectedGeneration: number): Promise<boolean> {
    const owned = this.live.get(runId);
    if (!owned || owned.generation !== expectedGeneration || owned.settling) return false;
    try {
      await owned.client.prompt(goal);
      this.store.touchActivity(runId, expectedGeneration);
      return true;
    } catch (err) {
      logWarn(TAG, `Prompt submission failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ── user commands ────────────────────────────────────────────────────────

  async steer(runId: string, text: string): Promise<boolean> {
    const owned = this.live.get(runId);
    if (!owned) return false;
    try {
      await owned.client.steer(text);
      this.store.touchActivity(runId, owned.generation);
      return true;
    } catch { return false; }
  }

  async reply(runId: string, generation: number, requestId: string, value: PiUiReply): Promise<PendingUiClaim> {
    const owned = this.live.get(runId);
    if (!owned) return { claimed: false, reason: "missing" };
    if (owned.generation !== generation) return { claimed: false, reason: "wrong_generation" };
    if (owned.settling) return { claimed: false, reason: "wrong_status" };

    const claim = this.store.claimPendingUi({ runId, generation, requestId });
    if (!claim.claimed) return claim;

    const rpcResult = await owned.client.respondToUi(requestId, value).catch((err: Error) => ({
      ok: false, delivery: "written_unacknowledged" as const, error: err.message,
    }));

    // #1426: Pi sends no acknowledgement for extension_ui_response.
    // On successful write, record delivery_unknown; on failure, restore the UI claim.
    if (rpcResult.delivery === "not_written") {
      this.store.restorePendingUi({ runId, generation, requestId, requestType: claim.requestType });
    } else {
      this.store.recordUiReplyOutcome({ runId, generation, requestId, outcome: "delivery_unknown" });
      this._fireTransition(runId, "awaiting_input", "running");
    }
    this.store.touchActivity(runId, generation);
    return { claimed: true, requestType: claim.requestType };
  }

  async cancel(runId: string): Promise<boolean> {
    const owned = this.live.get(runId);
    if (!owned) return false;
    this._cancelProcess(runId, owned, "Cancelled by user");
    return true;
  }

  /**
   * #1406: native Pi RPC compaction of an owned, live run. Ownership,
   * generation, live process identity, and state are verified before any
   * write; the correlated `compact` response (plus bounded compaction
   * lifecycle observation) determines the terminal result. An accepted write
   * is never reported as completion without its response.
   */
  async compactOwnedRun(input: {
    runId: string;
    ownerPrincipalId: string;
    expectedGeneration: number;
    customInstructions?: string;
  }): Promise<import("./pi-run-service.js").CompactionControlResult> {
    const base = { targetKind: "local_pi_run" as const, message: "" };
    const owned = this.live.get(input.runId);
    if (!owned) {
      return { ...base, status: "failed", message: "Run is not running (terminal or not started)" };
    }
    if (owned.generation !== input.expectedGeneration) {
      return { ...base, status: "stale", message: "Run generation changed since the request was resolved" };
    }
    if (owned.settling) {
      return { ...base, status: "failed", message: "Run is settling" };
    }
    const run = this.store.get(input.runId);
    if (!run || run.status !== "running") {
      // Native Pi compaction is valid only between turns. Awaiting-input,
      // starting, cancelling, and terminal states are not safe compaction
      // boundaries.
      const busy = run?.status === "starting" || run?.status === "awaiting_input" || run?.status === "cancelling";
      return { ...base, status: busy ? "busy" : "failed", message: `Run is ${run?.status ?? "unknown"}` };
    }
    if (run.ownerPrincipalId !== input.ownerPrincipalId) {
      return { ...base, status: "failed", message: "Run belongs to a different principal" };
    }

    let state: { isStreaming: boolean; isCompacting: boolean };
    try {
      state = await owned.client.getState();
    } catch (err) {
      return { ...base, status: "failed", message: `Cannot probe run state: ${boundedError(err)}` };
    }
    if (state.isCompacting) {
      return { ...base, status: "busy", message: "Run is already compacting" };
    }
    if (state.isStreaming) {
      return { ...base, status: "busy", message: "Run is streaming an active turn" };
    }

    // Observe compaction lifecycle events during the call. The correlated
    // `compact` response is the official terminal signal; the lifecycle
    // listener cleans itself up on compaction_end or after a bounded grace.
    let compactionEnded = false;
    let lifecycleTimer: ReturnType<typeof setTimeout> | null = null;
    const lifecycle = new Promise<void>((resolve) => {
      let unsub: (() => void) | null = null;
      unsub = owned.client.subscribe((event) => {
        if (event.type === "compaction_end") {
          compactionEnded = true;
          if (lifecycleTimer) { clearTimeout(lifecycleTimer); lifecycleTimer = null; }
          unsub?.();
          resolve();
        }
      });
      lifecycleTimer = setTimeout(() => { lifecycleTimer = null; unsub?.(); }, 15_000);
      if (typeof lifecycleTimer.unref === "function") lifecycleTimer.unref();
    });

    try {
      const started = Date.now();
      const result = await owned.client.compact(input.customInstructions);
      await Promise.race([
        lifecycle,
        new Promise<void>(resolve => setTimeout(resolve, 10_000)),
      ]);
      if (lifecycleTimer) { clearTimeout(lifecycleTimer); lifecycleTimer = null; }
      this.store.touchActivity(input.runId, input.expectedGeneration);
      if (!compactionEnded) {
        logDebug(TAG, `Run ${input.runId}: compact response ok, no compaction_end observed (${Date.now() - started}ms)`);
      }
      if (!result.summary && !result.firstKeptEntryId) {
        return { ...base, status: "failed", message: "Pi returned an empty compaction result" };
      }
      return {
        ...base,
        status: "completed",
        tokensBefore: result.tokensBefore,
        tokensAfter: result.estimatedTokensAfter,
        message: "Native compaction completed",
      };
    } catch (err) {
      const code = err instanceof PiRpcError ? err.code : "unknown";
      if (code === "process_exit" || code === "process_error" || code === "closed") {
        return { ...base, status: "failed", message: "Pi process exited during compaction" };
      }
      if (code === "timeout") {
        return { ...base, status: "failed", message: "Compaction timed out" };
      }
      return { ...base, status: "failed", message: `Compaction failed: ${boundedError(err)}` };
    }
  }

  async checkWallClock(runId: string): Promise<boolean> {
    const owned = this.live.get(runId);
    if (!owned) return false;
    if (Date.now() - owned.wallClockStart > this.config_.maxWallClockMs) {
      logWarn(TAG, `Run ${runId} exceeded max wall clock (${this.config_.maxWallClockMs}ms) — aborting`);
      this._cancelProcess(runId, owned, "Cancelled: maximum wall clock exceeded");
      return true;
    }
    return false;
  }

  // ── settlement ───────────────────────────────────────────────────────────

  /** #1638 — route a terminal observation through the coordinator when wired;
   * standalone falls through to the existing PiRunStore.settleTerminal().
   * Returns { committed, supervised } so the caller skips Pi-lane card events
   * for supervised runs (the Worker lane owns those). */
  private settleTerminalObservation(observation: PiTerminalObservation): { committed: boolean; supervised: boolean } {
    if (this._settlementRouter) {
      try {
        const result = this._settlementRouter(observation);
        if (result && typeof result === "object" && "kind" in result) {
          const kind = (result as { kind: string }).kind;
          const supervised = (result as { supervised?: boolean }).supervised === true;
          return { committed: kind === "settled" || kind === "replayed", supervised };
        }
        return { committed: true, supervised: false };
      } catch (err) {
        logWarn(TAG, `settlement router failed for ${observation.runId}: ${err instanceof Error ? err.message : String(err)}`);
        return { committed: false, supervised: false };
      }
    }
    return {
      committed: this.store.settleTerminal({
        runId: observation.runId,
        generation: observation.generation,
        expectedStatuses: observation.expectedStatuses ?? ["running", "cancelling", "starting", "awaiting_input"],
        outcome: observation.outcome,
        metadata: observation.metadata,
      }).committed,
      supervised: false,
    };
  }

  private async _settleAndCleanup(
    owned: OwnedProcess,
    outcome: PiTerminalOutcome,
    metadata: { resultSummary?: string; changedFilesSummary?: string; usageJson?: string; error?: string; piSessionId?: string },
  ): Promise<void> {
    if (owned.settling) return;
    owned.settling = true;
    try {
      const { committed, supervised } = this.settleTerminalObservation({
        runId: owned.runId,
        generation: owned.generation,
        outcome,
        metadata,
      });

      if (committed) {
        // #1638: supervised runs settle through the Worker lane — the W card
        // and its events are owned there; only standalone Pi cards get a
        // Pi-lane card event here.
        if (!supervised) {
          const cardId = this.store.get(owned.runId)?.cardId ?? 0;
          if (outcome === "completed") {
            nerve.fire("card:done", cardId);
          } else {
            nerve.fire("card:failed", cardId);
          }
        }
        this._fireTransition(owned.runId, undefined, outcome);
      } else {
        logWarn(TAG, `Terminal CAS lost for ${owned.runId} (gen=${owned.generation} outcome=${outcome})`);
      }
    } catch (err) {
      // Durable settlement is best effort here, but process/slot/C-session
      // cleanup is mandatory even if a router, emitter, or event subscriber
      // throws.
      logWarn(TAG, `Terminal cleanup settlement failed for ${owned.runId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this._releaseOwned(owned);
    }
  }

  private async _settleAndCleanupGen(
    runId: string, generation: number, expectedStatuses: PiRunStatus[],
    outcome: PiTerminalOutcome,
    metadata: { error?: string; changedFilesSummary?: string },
  ): Promise<void> {
    try {
      const { committed, supervised } = this.settleTerminalObservation({
        runId,
        generation,
        outcome,
        expectedStatuses,
        metadata,
      });
      if (committed) {
        if (!supervised) {
          nerve.fire("card:failed", this.store.get(runId)?.cardId ?? 0);
        }
        this._fireTransition(runId, undefined, outcome);
      }
    } catch (err) {
      logWarn(TAG, `Pre-live cleanup settlement failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // #1647 — no owned process here (pre-live failure): release the exact
      // workspace claim and end only this generation's external C session.
      try { this.store.releaseWorkspaceClaimForGeneration({ runId, generation }); } catch (err) {
        logWarn(TAG, `Workspace claim cleanup failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const run = this.store.get(runId);
      if (run?.executionGeneration === generation && run.currentSessionId) {
        try {
          this._endExternalSession?.(run.currentSessionId, { runId, generation });
        } catch (err) {
          logWarn(TAG, `External session cleanup failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /** #1647 — release every exact-generation resource: timers, subscriptions,
   * the owned Pi process, the external C session, and the live slot. Every
   * action is generation-fenced and idempotent. */
  private async _releaseOwned(owned: OwnedProcess): Promise<void> {
    if (owned.abortTimer) { clearTimeout(owned.abortTimer); owned.abortTimer = null; }
    if (owned.unsubTermination) { owned.unsubTermination(); owned.unsubTermination = null; }
    if (owned.unsubEvents) { owned.unsubEvents(); owned.unsubEvents = null; }
    if (owned.unsubUi) { owned.unsubUi(); owned.unsubUi = null; }
    try {
      this.store.releaseWorkspaceClaimForGeneration({ runId: owned.runId, generation: owned.generation });
    } catch (err) {
      logWarn(TAG, `Workspace claim cleanup failed for ${owned.runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (owned.client) {
      try { await owned.client.close(); } catch { /* ignore */ }
    }
    if (owned.sessionId) {
      try {
        this._endExternalSession?.(owned.sessionId, { runId: owned.runId, generation: owned.generation });
      } catch (err) {
        logWarn(TAG, `External session cleanup failed for ${owned.runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.live.get(owned.runId) === owned) {
      this.live.delete(owned.runId);
    }
    // #1635 — release the shared process slot; the host fires the post-release
    // wake (queued standalone cards + supervised dispatch).
    this.host.releaseSlot();
  }

  // ── cancellation ─────────────────────────────────────────────────────────

  private _cancelProcess(runId: string, owned: OwnedProcess, reason: string): void {
    if (owned.settling) return;
    if (!this.store.casTransition(runId, ["running", "awaiting_input", "starting"], "cancelling", {
      pendingRequestId: null, pendingRequestType: null,
    }, owned.generation)) return;
    this._fireTransition(runId, undefined, "cancelling");

    owned.client.abort().catch(() => {});

    const graceMs = this.config_.abortGraceMs;
    owned.abortTimer = setTimeout(async () => {
      if (this.live.get(runId) !== owned) return;
      try { await owned.client.close(); } catch { /* settlement still owns cleanup */ }
      const afterEvidence = captureGitEvidence(owned.workspacePath);
      const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
      await this._settleAndCleanup(owned, "cancelled", {
        error: reason, changedFilesSummary: summary, resultSummary: reason,
      });
    }, graceMs);
  }

  // ── RPC event handler ─────────────────────────────────────────────────────

  private async _onRpcEvent(runId: string, expectedGeneration: number, event: PiAgentEvent): Promise<void> {
    const owned = this.live.get(runId);
    if (!owned || owned.generation !== expectedGeneration || owned.settling) return;
    // Every frame from Pi counts as activity (drives timeout/idle logic).
    this.store.touchActivity(runId, expectedGeneration);

    const proj = projectPiEvent(event);
    for (const p of proj.progress) {
      this.store.addProgress(runId, p.type, p.json, expectedGeneration);
      for (const cb of this._progressSubs) {
          try { cb(runId, p.json, p.type); } catch { /* best effort */ }
      }
    }
    if (proj.log?.level === "warn") logWarn(TAG, `${proj.log.message} [run=${runId}]`);
    else if (proj.log?.level === "debug") logDebug(TAG, `${proj.log.message} [run=${runId}]`);

    if (proj.settleCompletion) {
      await this._settleCompletion(runId, owned);
    }
  }

  /** Handle official extension_ui_request frames. Dialog methods enter awaiting_input;
   *  fire-and-forget methods are bounded progress/display events. */
  private async _onUiRequest(runId: string, expectedGeneration: number, request: RpcExtensionUIRequest): Promise<void> {
    const owned = this.live.get(runId);
    if (!owned || owned.generation !== expectedGeneration || owned.settling) return;
    this.store.touchActivity(runId, expectedGeneration);

    const method = request.method;
    const dialogMethods = new Set(["select", "confirm", "input", "editor"]);

    if (dialogMethods.has(method)) {
      // #1638: supervised runs suspend for input instead of parking in
      // awaiting_input — the question becomes structured Worker failure
      // evidence and Orc answers on the retry.
      if (this._inputSuspendHook) {
        // Block termination/progress callbacks while the coordinator proves
        // the durable session and settles the Worker attempt. Once it has
        // committed, the Pi process must be closed and removed from `live`;
        // otherwise it keeps consuming a Pi slot after input_requested.
        owned.settling = true;
        let suspended = false;
        try {
          suspended = await this._inputSuspendHook(runId, owned.generation, request);
        } catch (err) {
          logWarn(TAG, `Input suspension failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (suspended) {
          await this._releaseOwned(owned);
          return;
        }
        if (this.live.get(runId) !== owned || owned.generation !== expectedGeneration) return;
        owned.settling = false;
      }
      // #1358 review — the "ui" progress row is stored BEFORE the
      // awaiting_input transition so the in-transaction event emitter can
      // attach title/prompt/options to the public projection. A stray row on
      // a rejected request is harmless: the next accepted request writes a
      // newer row, and the projection reads the latest one.
      this.store.addProgress(runId, "ui", JSON.stringify({
        requestId: request.id,
        type: method,
        title: (request as any).title,
        description: (request as any).message ?? (request as any).placeholder ?? (request as any).prefill,
        options: (request as any).options,
        defaultValue: (request as any).defaultValue,
        filePattern: undefined,
      }), expectedGeneration);
      const result = this.store.setPendingUi({
        runId, generation: owned.generation, requestId: request.id, requestType: method as PiPendingRequestType,
      });
      if (result.ok) {
        this._fireTransition(runId, "running", "awaiting_input");
      } else {
        logWarn(TAG, `UI request rejected for ${runId} (gen=${owned.generation}, req=${request.id}): ${result.reason}`);
      }
    } else if (method === "notify") {
      this.store.addProgress(runId, "ui_notify", JSON.stringify({ message: (request as any).message }), expectedGeneration);
    }
  }

  private async _settleCompletion(runId: string, owned: OwnedProcess): Promise<void> {
    let outcome: PiTerminalOutcome;
    let metadata: { resultSummary?: string; changedFilesSummary?: string; usageJson?: string; error?: string; piSessionId?: string };

    try {
      let state = await owned.client.getState();
      const maxWait = 10_000;
      const pollStart = Date.now();
      while (state.isStreaming && Date.now() - pollStart < maxWait) {
        await new Promise(r => setTimeout(r, 200));
        state = await owned.client.getState();
      }
      if (state.isStreaming) {
        logWarn(TAG, `Run ${runId}: agent_end but still streaming after ${maxWait}ms — proceeding`);
      }

      const finalText = await owned.client.getLastAssistantText().catch(() => "(unavailable)");
      const stats = await owned.client.getSessionStats().catch(() => ({}));
      const run = this.store.get(runId);
      const isCancel = run?.status === "cancelling";
      const afterEvidence = captureGitEvidence(owned.workspacePath);
      const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
      const resultParts: string[] = [];
      if (finalText) resultParts.push(finalText.slice(0, 500));
      const resultSummary = resultParts.join("\n").slice(0, 1000);

      if (isCancel) {
        outcome = "cancelled";
        metadata = { error: "Cancelled", changedFilesSummary: summary, resultSummary, usageJson: JSON.stringify(stats).slice(0, 1000) };
      } else {
        outcome = "completed";
        metadata = { piSessionId: state.sessionId, changedFilesSummary: summary, resultSummary, usageJson: JSON.stringify(stats).slice(0, 1000) };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const run = this.store.get(runId);
      const isCancel = run?.status === "cancelling";
      outcome = isCancel ? "cancelled" : "failed";
      metadata = { error: isCancel ? errMsg : `Completion settlement failed: ${errMsg}` };
    }

    await this._settleAndCleanup(owned, outcome, metadata);
  }

  // ── stop/shutdown ────────────────────────────────────────────────────────

  /**
   * #1647 — Graceful interruption of every live Pi generation. For each
   * generation: probe live Pi state with a bounded timeout, derive the
   * capability from the shared session proof (never optimistic), route the
   * typed interruption (standalone or supervised), and always release the
   * exact generation's resources (process, C session, live slot, capacity).
   * Concurrent RPC callbacks cannot begin a second finalization while
   * shutdown is evaluating proof (settling ownership). Awaited by the bridge
   * shutdown step.
   */
  async interruptAll(): Promise<void> {
    this._stopped = true;
    const snapshot = [...this.live.values()];
    await Promise.all(snapshot.map(async (owned) => {
      if (owned.abortTimer) { clearTimeout(owned.abortTimer); owned.abortTimer = null; }
      owned.settling = true;
      try {
        const proof = await this._interruptProof(owned);
        let interrupted = false;
        if (this._interruptRouter) {
          interrupted = this._interruptRouter({ runId: owned.runId, generation: owned.generation, continuity: proof }).interrupted === true;
        } else {
          const direct = this.store.interruptGeneration({ runId: owned.runId, generation: owned.generation, continuity: proof });
          if (direct.committed) {
            interrupted = true;
          } else if (direct.reason === "supervised") {
            // Degraded corner (no coordinator wired): run-row-only
            // interruption, never touching the W card.
            interrupted = this.store.casTransition(
              owned.runId,
              ["starting", "running", "awaiting_input", "cancelling"],
              "interrupted",
              { pendingRequestId: null, pendingRequestType: null },
              owned.generation,
            );
          }
        }
        if (interrupted) this._fireTransition(owned.runId, undefined, "interrupted");
      } catch (err) {
        logWarn(TAG, `Interruption settlement failed for ${owned.runId}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        // Shutdown must not strand a process, external C session, capacity
        // slot, or workspace claim when durable interruption loses a race or
        // throws.
        await this._releaseOwned(owned);
      }
    }));
  }

  /** Bounded live-state probe; a timeout or RPC failure yields a
   * non-available proof — the interruption still succeeds, but the
   * generation must not claim resumability. */
  private async _interruptProof(owned: OwnedProcess): Promise<SessionProof> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let state: { sessionId: string; sessionFile?: string } | null = null;
    try {
      state = await Promise.race([
        owned.client.getState(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), INTERRUPT_PROBE_MS);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    } catch {
      state = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!state) {
      return { ok: false, capability: "session_missing", reason: "Pi state unavailable before interruption" };
    }
    return validatePersistedSession({
      sessionStorageRoot: this.config_.sessionStorageRoot,
      expectedSessionId: state.sessionId,
      sessionFile: state.sessionFile,
    });
  }
}

/** Bounded, content-free error text (never raw RPC frame content). */
function boundedError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}
