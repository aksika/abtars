import { logInfo, logWarn } from "../logger.js";
import { SupervisedPiRpcClient, type PiProcessTermination, type PiAgentEvent } from "./pi-rpc-client.js";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { PiRunStore, type PiTerminalOutcome } from "./pi-run-store.js";
import type { PiExecutorConfig } from "./config.js";
import { resolveAndValidateWorkspace, buildTrustArgs, buildPluginArgs, buildChildEnv, validateSessionFile } from "./config.js";
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
  /** #1358 — Lifecycle transition hook for remote Pi event production. */
  private _onTransition: ((runId: string, fromStatus: string | undefined, toStatus: string) => void) | null = null;

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

  /** #1358 — Register a callback fired on run state transitions. */
  onTransition(cb: (runId: string, fromStatus: string | undefined, toStatus: string) => void): void {
    this._onTransition = cb;
  }

  /** #1358 — Fire the transition hook for a run. */
  private _fireTransition(runId: string, fromStatus: string | undefined, toStatus: string): void {
    if (this._onTransition) {
      try { this._onTransition(runId, fromStatus, toStatus); } catch { /* best effort */ }
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
      ...buildPluginArgs(this.config),
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
    this.store.touchActivity(runId);

    switch (event.type) {
      case "agent_start":
        this.store.addProgress(runId, "agent_start", "{}");
        break;
      case "agent_end": {
        const owned = this.live.get(runId);
        if (!owned || owned.settling) return;
        await this._settleCompletion(runId, owned);
        break;
      }
      case "agent_settled":
        break;
      case "tool_execution_start":
        if (event.toolName && typeof event.toolName === "string") {
          this.store.addProgress(runId, "tool_execution_start", JSON.stringify({ name: event.toolName }));
        }
        break;
      case "tool_execution_update":
        break;
      case "tool_execution_end":
        if (event.toolName && typeof event.toolName === "string") {
          this.store.addProgress(runId, "tool_execution_end", JSON.stringify({ name: event.toolName }));
        }
        break;
      case "compaction_start":
        this.store.addProgress(runId, "compaction", JSON.stringify({ status: "started" }));
        break;
      case "compaction_end":
        this.store.addProgress(runId, "compaction", JSON.stringify({ status: "ended" }));
        break;
      case "auto_retry_start":
        if (typeof event.attempt === "number") {
          this.store.addProgress(runId, "auto_retry", JSON.stringify({ status: "started", attempt: event.attempt }));
        }
        break;
      case "auto_retry_end":
        if (typeof event.attempt === "number") {
          this.store.addProgress(runId, "auto_retry", JSON.stringify({ status: "ended", attempt: event.attempt }));
        }
        break;
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_end":
      case "queue_update":
      case "entry_appended":
      case "session_info_changed":
      case "thinking_level_changed":
        break;
      case "extension_error":
        logWarn(TAG, `Extension error for ${runId}: ${JSON.stringify(event)}`);
        this.store.addProgress(runId, "extension_error", JSON.stringify({}));
        break;
      default:
        logWarn(TAG, `Unhandled Pi event type for ${runId}: ${event.type}`);
        break;
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
