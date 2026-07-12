import { logInfo, logWarn } from "../logger.js";
import { PiRpcClient } from "./pi-rpc-client.js";
import { PiRunStore, type PiTerminalOutcome, type PiTerminalSettlement } from "./pi-run-store.js";
import type { PiExecutorConfig } from "./config.js";
import { resolveAndValidateWorkspace, buildTrustArgs, buildPluginArgs } from "./config.js";
import type { PiRunRecord, PiRunStatus, PiPendingRequestType, PiUiReply, PendingUiClaim } from "./types.js";
import { captureGitEvidence, computeChangedFilesSummary } from "./evidence.js";
import type { PiRpcEvent } from "./pi-rpc-types.js";
import { nerve } from "../nerve.js";

const TAG = "pi-executor";

interface OwnedProcess {
  client: PiRpcClient;
  generation: number;
  runId: string;
  workspacePath: string;
  beforeEvidence: { head?: string; status?: string } | null;
  abortTimer: ReturnType<typeof setTimeout> | null;
  wallClockStart: number;
  settling: boolean;   // #1396 — in-memory guard against duplicate settlement
}

export class PiExecutor {
  private readonly config: PiExecutorConfig;
  private readonly store: PiRunStore;
  private readonly live = new Map<string, OwnedProcess>();
  private _stopped = false;

  constructor(config: PiExecutorConfig, store: PiRunStore) {
    this.config = config;
    this.store = store;
  }

  get activeCount(): number {
    return this.live.size;
  }

  get maxConcurrent(): number {
    return this.config.maxConcurrent;
  }

  get isStopped(): boolean {
    return this._stopped;
  }

  // ── start pipeline ───────────────────────────────────────────────────────

  async claimAndStart(runId: string): Promise<"started" | "concurrency_full" | "not_found" | "error"> {
    if (this._stopped) return "error";
    if (this.live.size >= this.config.maxConcurrent) return "concurrency_full";

    const run = this.store.get(runId);
    if (!run) return "not_found";
    if (run.status !== "queued" && run.status !== "starting") return "error";

    const owned = await this._startProcess(run);
    if (!owned) return "error";

    this.live.set(runId, owned);
    logInfo(TAG, `Started Pi run ${runId} (generation ${run.executionGeneration}, ${run.workspaceAlias})`);

    // #1396 — settleInitial is required; if it fails, finalize as failed
    const state = await owned.client.getState().catch(() => null);
    if (!state) {
      await this.finalize(owned, "failed", { error: "Pi process did not report initial state" });
      return "error";
    }
    const initialOk = await this.settleInitial(runId, state.sessionId, state.sessionFile);
    if (!initialOk) {
      await this.finalize(owned, "failed", { error: "Failed to transition run to running" });
      return "error";
    }

    // #1396 — prompt submission is required; if it fails, finalize as failed
    const promptOk = await this.submitPrompt(runId, run.operationalGoal);
    if (!promptOk) {
      await this.finalize(owned, "failed", { error: "Initial prompt submission failed" });
      return "error";
    }

    return "started";
  }

  private async _startProcess(run: PiRunRecord): Promise<OwnedProcess | null> {
    const ws = resolveAndValidateWorkspace(run.workspaceAlias, this.config);
    if (ws.error) {
      // #1396 — workspace failure → terminal failed + card failed
      await this.finalizeGen(run.id, run.executionGeneration, ["queued", "starting"], "failed", { error: ws.error });
      return null;
    }

    const gen = run.executionGeneration;
    const client = new PiRpcClient();

    const args = [
      ...this.config.fixedArgs,
      "--mode", "rpc",
      "--rpc-version", this.config.supportedRpcVersion,
      ...buildTrustArgs(this.config),
      ...buildPluginArgs(this.config),
    ];

    if (this.config.sessionStorageRoot) {
      args.push("--session-storage-root", this.config.sessionStorageRoot);
    }

    const env: Record<string, string | undefined> = {};
    for (const name of this.config.allowedEnv) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env["ABMIND_USER_ID"] = run.ownerPrincipalId;
    env["ABMIND_PARENT_EXECUTION_ID"] = `pi-run-${run.id}-gen-${gen}`;
    env["ABMIND_AUTOMATIC_WRITE_OWNER"] = "abmind-pi-plugin";

    try {
      await client.launch(this.config.command, args, ws.canonicalPath, env);
    } catch (err) {
      await client.close().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      await this.finalizeGen(run.id, gen, ["queued", "starting"], "failed", { error: `Launch failed: ${msg}` });
      return null;
    }

    if (!this.store.casTransition(run.id, ["queued", "starting"], "starting", {
      observedPid: client.pid,
    })) {
      await client.close();
      return null;
    }

    const beforeEvidence = captureGitEvidence(ws.canonicalPath);
    client.subscribe((event) => this._onRpcEvent(run.id, event));

    return {
      client,
      generation: gen,
      runId: run.id,
      workspacePath: ws.canonicalPath,
      beforeEvidence,
      abortTimer: null,
      wallClockStart: Date.now(),
      settling: false,
    };
  }

  async settleInitial(runId: string, piSessionId: string, piSessionFile?: string): Promise<boolean> {
    const run = this.store.get(runId);
    if (!run || run.status !== "starting") return false;

    const owned = this.live.get(runId);
    if (!owned) return false;

    if (run.modelId && run.modelProvider) {
      try {
        const models = await owned.client.getAvailableModels();
        const match = models.find(m => m.modelId === run.modelId);
        if (match) {
          await owned.client.setModel({ provider: run.modelProvider, modelId: run.modelId, thinking: run.thinking });
        } else {
          logWarn(TAG, `Requested model ${run.modelId} not available in Pi catalogue, using default`);
        }
      } catch (err) {
        logWarn(TAG, `Model selection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return this.store.casTransition(run.id, "starting", "running", {
      piSessionId,
      piSessionFile,
    });
  }

  async submitPrompt(runId: string, goal: string): Promise<boolean> {
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
    // Verify exact live owned process
    const owned = this.live.get(runId);
    if (!owned) return { claimed: false, reason: "missing" };
    if (owned.generation !== generation) return { claimed: false, reason: "wrong_generation" };
    if (owned.settling) return { claimed: false, reason: "wrong_status" };

    // Durable claim via store
    const claim = this.store.claimPendingUi({ runId, generation, requestId });
    if (!claim.claimed) return claim;

    // Claim won — send RPC and handle outcome
    const rpcResult = await owned.client.respondToUi(requestId, value).catch((err: Error) => ({
      ok: false, delivery: "written_unacknowledged" as const, error: err.message,
    }));

    switch (rpcResult.delivery) {
      case "not_written": {
        // Provable pre-write failure — restore the pending request
        this.store.restorePendingUi({ runId, generation, requestId, requestType: claim.requestType });
        break;
      }
      case "acknowledged": {
        this.store.recordUiReplyOutcome({ runId, generation, requestId, outcome: "acknowledged" });
        break;
      }
      case "written_unacknowledged": {
        this.store.recordUiReplyOutcome({ runId, generation, requestId, outcome: "delivery_unknown" });
        break;
      }
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

  /**
   * #1396 — Central terminal settlement for a gen-tracked owned process.
   * CASes the run and card in one transaction, publishes exactly one Nerve
   * event, and cleans up the live map and client.  Idempotent: the
   * `settling` guard and durable generation CAS ensure at-most-once.
   */
  private async finalize(
    owned: OwnedProcess,
    outcome: PiTerminalOutcome,
    metadata: { resultSummary?: string; changedFilesSummary?: string; usageJson?: string; error?: string; piSessionId?: string },
  ): Promise<PiTerminalSettlement> {
    if (owned.settling) return { committed: false, reason: "wrong_status" };
    owned.settling = true;

    return this._doFinalize(owned.runId, owned.generation, outcome, metadata);
  }

  /** #1396 — Terminal settlement without an OwnedProcess (startup failures before live registration). */
  private async finalizeGen(
    runId: string, generation: number, expectedStatuses: PiRunStatus[],
    outcome: PiTerminalOutcome,
    metadata: { error?: string },
  ): Promise<PiTerminalSettlement> {
    return this._doFinalize(runId, generation, outcome, metadata, expectedStatuses);
  }

  private async _doFinalize(
    runId: string, generation: number,
    outcome: PiTerminalOutcome,
    metadata: { resultSummary?: string; changedFilesSummary?: string; usageJson?: string; error?: string; piSessionId?: string },
    expectedStatuses?: PiRunStatus[],
  ): Promise<PiTerminalSettlement> {
    const settlement = this.store.settleTerminal({
      runId,
      generation,
      expectedStatuses: expectedStatuses ?? ["running", "cancelling", "starting", "awaiting_input"],
      outcome,
      metadata,
    });

    if (settlement.committed) {
      if (settlement.outcome === "completed") {
        nerve.fire("card:done", settlement.cardId);
      } else {
        nerve.fire("card:failed", settlement.cardId);
      }
    } else {
      logWarn(TAG, `Terminal CAS lost for ${runId} (gen=${generation} outcome=${outcome}): ${settlement.reason}`);
    }

    // Cleanup the owned process if we have one (caller must handle this in finally)
    return settlement;
  }

  /** #1396 — Clean up the owned process: clear abort timer, close client, remove from live map.  Safe to call in finally. */
  private cleanupOwned(owned: OwnedProcess): void {
    if (owned.abortTimer) { clearTimeout(owned.abortTimer); owned.abortTimer = null; }
    owned.client.close().catch(() => {});
    if (this.live.get(owned.runId) === owned) {
      this.live.delete(owned.runId);
    }
  }

  // ── cancellation ─────────────────────────────────────────────────────────

  private _cancelProcess(runId: string, owned: OwnedProcess, reason: string): void {
    if (owned.settling) return;
    if (!this.store.casTransition(runId, ["running", "awaiting_input", "starting"], "cancelling", {
      pendingRequestId: null,
      pendingRequestType: null,
    })) return;

    owned.client.abort().catch(() => {});

    const graceMs = this.config.abortGraceMs;
    owned.abortTimer = setTimeout(async () => {
      if (this.live.get(runId) !== owned) return;
      await owned.client.close();
      const afterEvidence = captureGitEvidence(owned.workspacePath);
      const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
      await this.finalize(owned, "cancelled", {
        error: reason,
        changedFilesSummary: summary,
        resultSummary: reason,
      });
      this.cleanupOwned(owned);
    }, graceMs);
  }

  // ── RPC event handler ─────────────────────────────────────────────────────

  private async _onRpcEvent(runId: string, event: PiRpcEvent): Promise<void> {
    this.store.touchActivity(runId);

    switch (event.type) {
      case "agent_start":
        this.store.addProgress(runId, "agent_start", JSON.stringify(event.data ?? {}));
        break;

      case "agent_end": {
        const owned = this.live.get(runId);
        if (!owned || owned.settling) return;
        await this._settleCompletion(runId, owned);
        break;
      }

      case "tool_start":
        if (event.data?.name) {
          this.store.addProgress(runId, "tool_start", JSON.stringify({ name: event.data.name }));
        }
        break;

      case "ui": {
        const data = event.data as Record<string, unknown> | undefined;
        const reqId = data?.requestId as string | undefined;
        const reqType = data?.type as string | undefined;
        if (reqId && reqType && ["select", "confirm", "input", "editor"].includes(reqType)) {
          const owned = this.live.get(runId);
          if (!owned) return;
          const result = this.store.setPendingUi({
            runId,
            generation: owned.generation,
            requestId: reqId,
            requestType: reqType as PiPendingRequestType,
          });
          if (result.ok) {
            this.store.addProgress(runId, "ui", JSON.stringify({ requestId: reqId, type: reqType, title: data?.title }));
          } else {
            logWarn(TAG, `UI request rejected for ${runId} (gen=${owned.generation}, req=${reqId}): ${result.reason}`);
          }
        }
        break;
      }

      case "status":
      case "notify":
      case "progress":
        this.store.addProgress(runId, event.type, JSON.stringify(event.data ?? {}));
        break;

      case "error":
        logWarn(TAG, `RPC error event for ${runId}: ${JSON.stringify(event.data)}`);
        this.store.addProgress(runId, "error", JSON.stringify(event.data ?? {}));
        break;
    }
  }

  // ── completion settlement ─────────────────────────────────────────────────

  private async _settleCompletion(runId: string, owned: OwnedProcess): Promise<void> {
    // Gather completion metadata
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

      // Determine outcome based on actual run status
      const run = this.store.get(runId);
      const isCancel = run?.status === "cancelling";

      const afterEvidence = captureGitEvidence(owned.workspacePath);
      const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);

      const resultParts: string[] = [];
      if (finalText) resultParts.push(finalText.slice(0, 500));
      const resultSummary = resultParts.join("\n").slice(0, 1000);

      if (isCancel) {
        outcome = "cancelled";
        metadata = {
          error: "Cancelled",
          changedFilesSummary: summary,
          resultSummary,
          usageJson: JSON.stringify(stats).slice(0, 1000),
        };
      } else {
        outcome = "completed";
        metadata = {
          piSessionId: state.sessionId,
          changedFilesSummary: summary,
          resultSummary,
          usageJson: JSON.stringify(stats).slice(0, 1000),
        };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const run = this.store.get(runId);
      const isCancel = run?.status === "cancelling";
      outcome = isCancel ? "cancelled" : "failed";
      metadata = { error: isCancel ? errMsg : `Completion settlement failed: ${errMsg}` };
    }

    // #1396 — atomic settlement, then close regardless
    await this.finalize(owned, outcome, metadata);
    this.cleanupOwned(owned);
  }

  // ── stop/shutdown ────────────────────────────────────────────────────────

  async interruptAll(): Promise<void> {
    for (const [runId, owned] of this.live) {
      if (owned.abortTimer) clearTimeout(owned.abortTimer);
      try { await owned.client.close(); } catch { /* ignore */ }
      this.store.casTransition(runId, ["starting", "running", "awaiting_input", "cancelling"], "interrupted", {
        pendingRequestId: null,
        pendingRequestType: null,
      });
    }
    this.live.clear();
  }
}
