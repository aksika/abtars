import { logInfo, logWarn, logDebug } from "../logger.js";
import { SupervisedPiRpcClient, PiRpcError, type PiProcessTermination, type PiAgentEvent } from "./pi-rpc-client.js";
import { projectPiEvent } from "./pi-event-projection.js";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { PiRunStore, type PiTerminalOutcome } from "./pi-run-store.js";
import type { PiExecutorConfig } from "./config.js";
import { resolveAndValidateWorkspace, buildTrustArgs, buildChildEnv, validateSessionFile } from "./config.js";
import type { PiRunRecord, PiRunStatus, PiPendingRequestType, PiUiReply, PendingUiClaim } from "./types.js";
import { captureGitEvidence, computeChangedFilesSummary } from "./evidence.js";
import { nerve } from "../nerve.js";

const TAG = "pi-executor";

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

export class PiExecutor {
  private readonly config: PiExecutorConfig;
  private readonly store: PiRunStore;
  private readonly live = new Map<string, OwnedProcess>();
  private _stopped = false;
  private _onCapacityReleased: (() => void) | null = null;
  /** #1358 — Lifecycle transition subscribers (multi). */
  private _transitionSubs = new Set<(runId: string, fromStatus: string | undefined, toStatus: string) => void>();
  /** Progress event subscribers (multi). */
  private _progressSubs = new Set<(runId: string, payload: string, progressType?: string) => void>();

  constructor(config: PiExecutorConfig, store: PiRunStore) {
    this.config = config;
    this.store = store;
  }

  get activeCount(): number { return this.live.size; }
  get maxConcurrent(): number { return this.config.maxConcurrent; }
  get isStopped(): boolean { return this._stopped; }
  get piStore(): PiRunStore { return this.store; }

  /** Register a callback fired when a Pi slot is released. */
  onCapacityReleased(cb: () => void): void {
    this._onCapacityReleased = cb;
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
    if (this._stopped) return "error";

    const run = this.store.get(runId);
    if (!run || run.executionGeneration !== generation) return "error";
    if (run.status !== "starting") return "error";

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
        return "error";
      }
      this.live.set(runId, owned);

      logInfo(TAG, `Started Pi run ${runId} (generation ${generation}, ${run.workspaceAlias})`);

      const state = await owned.client.getState().catch(() => null);
      if (!state) {
        await this._settleAndCleanup(owned, "failed", { error: "Pi process did not report initial state" });
        return "error";
      }
      const initialOk = await this._settleInitial(runId, state.sessionId, state.sessionFile);
      if (!initialOk) {
        await this._settleAndCleanup(owned, "failed", { error: "Failed to transition run to running" });
        return "error";
      }

      const isResume = generation > 1 && run.piSessionFile;
      if (isResume) {
        const resumeOk = await this._resumeContinuation(owned, run);
        if (!resumeOk) {
          return "error";
        }
      } else {
        const promptOk = await this._submitPrompt(runId, run.operationalGoal);
        if (!promptOk) {
          await this._settleAndCleanup(owned, "failed", { error: "Initial prompt submission failed" });
          return "error";
        }
      }

      return "started";
    } catch (err) {
      this.live.delete(runId);
      await this.store.casTransition(runId, ["starting"], "failed", {
        error: `Launch exception: ${err instanceof Error ? err.message : String(err)}`,
      });
      nerve.fire("card:failed", run.cardId);
      this._fireTransition(runId, "starting", "failed");
      return "error";
    }
  }

  private async _resumeContinuation(owned: OwnedProcess, run: PiRunRecord): Promise<boolean> {
    if (!run.piSessionFile) {
      await this._settleAndCleanup(owned, "failed", { error: "No saved session file for resume" });
      return false;
    }
    const validated = validateSessionFile(this.config.sessionStorageRoot, run.piSessionFile);
    if (validated.error) {
      await this._settleAndCleanup(owned, "failed", { error: `Session file validation failed: ${validated.error}` });
      return false;
    }
    try {
      await owned.client.switchSession(validated.canonicalPath!);
      const state = await owned.client.getState();
      if (state.sessionId !== run.piSessionId) {
        await this._settleAndCleanup(owned, "failed", { error: "Switched session identity mismatch" });
        return false;
      }
      const newFile = validateSessionFile(this.config.sessionStorageRoot, state.sessionFile ?? "");
      if (newFile.error) {
        await this._settleAndCleanup(owned, "failed", { error: `Resumed session file invalid: ${newFile.error}` });
        return false;
      }
      await owned.client.followUp("Continue where we left off");
      this.store.touchActivity(run.id);
      return true;
    } catch (err) {
      await this._settleAndCleanup(owned, "failed", {
        error: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  }

  private async _startProcess(run: PiRunRecord, sessionId: string): Promise<OwnedProcess | null> {
    const ws = resolveAndValidateWorkspace(run.workspaceAlias, this.config);
    if (ws.error) {
      await this._settleAndCleanupGen(run.id, run.executionGeneration, ["starting"], "failed", { error: ws.error });
      return null;
    }

    const gen = run.executionGeneration;
    const client = new SupervisedPiRpcClient();

    const args = [
      ...this.config.fixedArgs,
      "--mode", "rpc",
      ...buildTrustArgs(this.config),
    ];

    const env = buildChildEnv(this.config, run);

    try {
      await client.launch(this.config.command, args, ws.canonicalPath, env);
    } catch (err) {
      await client.close().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      await this._settleAndCleanupGen(run.id, gen, ["starting"], "failed", { error: `Launch failed: ${msg}` });
      return null;
    }

    if (!this.store.casTransition(run.id, ["starting"], "starting", { observedPid: client.pid })) {
      await client.close();
      return null;
    }

    const beforeEvidence = captureGitEvidence(ws.canonicalPath);
    const unsubTermination = client.onTermination((event) => {
      this._onChildTerminated(run.id, gen, event);
    });
    const unsubEvents = client.subscribe((event) => this._onRpcEvent(run.id, event));
    const unsubUi = client.onUiRequest((request) => this._onUiRequest(run.id, request));

    return {
      client,
      generation: gen,
      runId: run.id,
      workspacePath: ws.canonicalPath,
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

  private async _settleInitial(runId: string, piSessionId: string, piSessionFile?: string): Promise<boolean> {
    const run = this.store.get(runId);
    if (!run || run.status !== "starting") return false;
    const owned = this.live.get(runId);
    if (!owned) return false;

    if (run.modelId && run.modelProvider) {
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

    const transitioned = this.store.casTransition(run.id, "starting", "running", { piSessionId, piSessionFile });
    if (transitioned) {
      this._fireTransition(run.id, "starting", "running");
    }
    return transitioned;
  }

  private async _submitPrompt(runId: string, goal: string): Promise<boolean> {
    const owned = this.live.get(runId);
    if (!owned) return false;
    try {
      await owned.client.prompt(goal);
      this.store.touchActivity(runId);
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
      this.store.touchActivity(runId);
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
    this.store.touchActivity(runId);
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
      this.store.touchActivity(input.runId);
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
    if (Date.now() - owned.wallClockStart > this.config.maxWallClockMs) {
      logWarn(TAG, `Run ${runId} exceeded max wall clock (${this.config.maxWallClockMs}ms) — aborting`);
      this._cancelProcess(runId, owned, "Cancelled: maximum wall clock exceeded");
      return true;
    }
    return false;
  }

  // ── settlement ───────────────────────────────────────────────────────────

  private async _settleAndCleanup(
    owned: OwnedProcess,
    outcome: PiTerminalOutcome,
    metadata: { resultSummary?: string; changedFilesSummary?: string; usageJson?: string; error?: string; piSessionId?: string },
  ): Promise<void> {
    if (owned.settling) return;
    owned.settling = true;

    const settlement = this.store.settleTerminal({
      runId: owned.runId,
      generation: owned.generation,
      expectedStatuses: ["running", "cancelling", "starting", "awaiting_input"],
      outcome,
      metadata,
    });

    if (settlement.committed) {
      if (settlement.outcome === "completed") {
        nerve.fire("card:done", settlement.cardId);
      } else {
        nerve.fire("card:failed", settlement.cardId);
      }
      this._fireTransition(owned.runId, undefined, settlement.outcome);
    } else {
      logWarn(TAG, `Terminal CAS lost for ${owned.runId} (gen=${owned.generation} outcome=${outcome}): ${settlement.reason}`);
    }

    this._releaseOwned(owned);
  }

  private async _settleAndCleanupGen(
    runId: string, generation: number, expectedStatuses: PiRunStatus[],
    outcome: PiTerminalOutcome,
    metadata: { error?: string; changedFilesSummary?: string },
  ): Promise<void> {
    const settlement = this.store.settleTerminal({
      runId,
      generation,
      expectedStatuses,
      outcome,
      metadata,
    });
    if (settlement.committed) {
      nerve.fire("card:failed", settlement.cardId);
      this._fireTransition(runId, undefined, outcome);
    }
  }

  private _releaseOwned(owned: OwnedProcess): void {
    if (owned.abortTimer) { clearTimeout(owned.abortTimer); owned.abortTimer = null; }
    if (owned.unsubTermination) { owned.unsubTermination(); owned.unsubTermination = null; }
    if (owned.unsubEvents) { owned.unsubEvents(); owned.unsubEvents = null; }
    if (owned.unsubUi) { owned.unsubUi(); owned.unsubUi = null; }
    owned.client.close().catch(() => {});
    if (this.live.get(owned.runId) === owned) {
      this.live.delete(owned.runId);
    }
    this._onCapacityReleased?.();
  }

  // ── cancellation ─────────────────────────────────────────────────────────

  private _cancelProcess(runId: string, owned: OwnedProcess, reason: string): void {
    if (owned.settling) return;
    if (!this.store.casTransition(runId, ["running", "awaiting_input", "starting"], "cancelling", {
      pendingRequestId: null, pendingRequestType: null,
    })) return;
    this._fireTransition(runId, undefined, "cancelling");

    owned.client.abort().catch(() => {});

    const graceMs = this.config.abortGraceMs;
    owned.abortTimer = setTimeout(async () => {
      if (this.live.get(runId) !== owned) return;
      await owned.client.close();
      const afterEvidence = captureGitEvidence(owned.workspacePath);
      const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
      await this._settleAndCleanup(owned, "cancelled", {
        error: reason, changedFilesSummary: summary, resultSummary: reason,
      });
    }, graceMs);
  }

  // ── RPC event handler ─────────────────────────────────────────────────────

  private async _onRpcEvent(runId: string, event: PiAgentEvent): Promise<void> {
    // Every frame from Pi counts as activity (drives timeout/idle logic).
    this.store.touchActivity(runId);

    const proj = projectPiEvent(event);
    for (const p of proj.progress) {
      this.store.addProgress(runId, p.type, p.json);
      for (const cb of this._progressSubs) {
          try { cb(runId, p.json, p.type); } catch { /* best effort */ }
      }
    }
    if (proj.log?.level === "warn") logWarn(TAG, `${proj.log.message} [run=${runId}]`);
    else if (proj.log?.level === "debug") logDebug(TAG, `${proj.log.message} [run=${runId}]`);

    if (proj.settleCompletion) {
      const owned = this.live.get(runId);
      if (!owned || owned.settling) return;
      await this._settleCompletion(runId, owned);
    }
  }

  /** Handle official extension_ui_request frames. Dialog methods enter awaiting_input;
   *  fire-and-forget methods are bounded progress/display events. */
  private async _onUiRequest(runId: string, request: RpcExtensionUIRequest): Promise<void> {
    this.store.touchActivity(runId);

    const method = request.method;
    const dialogMethods = new Set(["select", "confirm", "input", "editor"]);

    if (dialogMethods.has(method)) {
      const owned = this.live.get(runId);
      if (!owned) return;
      const result = this.store.setPendingUi({
        runId, generation: owned.generation, requestId: request.id, requestType: method as PiPendingRequestType,
      });
      if (result.ok) {
        this.store.addProgress(runId, "ui", JSON.stringify({
          requestId: request.id,
          type: method,
          title: (request as any).title,
          description: (request as any).message ?? (request as any).placeholder ?? (request as any).prefill,
          options: (request as any).options,
          defaultValue: (request as any).defaultValue,
          filePattern: undefined,
        }));
        this._fireTransition(runId, "running", "awaiting_input");
      } else {
        logWarn(TAG, `UI request rejected for ${runId} (gen=${owned.generation}, req=${request.id}): ${result.reason}`);
      }
    } else if (method === "notify") {
      this.store.addProgress(runId, "ui_notify", JSON.stringify({ message: (request as any).message }));
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

  async interruptAll(): Promise<void> {
    for (const [runId, owned] of this.live) {
      if (owned.abortTimer) clearTimeout(owned.abortTimer);
      try { await owned.client.close(); } catch { /* ignore */ }
      const interrupted = this.store.casTransition(runId, ["starting", "running", "awaiting_input", "cancelling"], "interrupted", {
        pendingRequestId: null, pendingRequestType: null,
      });
      if (interrupted) this._fireTransition(runId, undefined, "interrupted");
    }
    this.live.clear();
  }
}

/** Bounded, content-free error text (never raw RPC frame content). */
function boundedError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}
