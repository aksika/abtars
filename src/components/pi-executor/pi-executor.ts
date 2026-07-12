import { logInfo, logWarn } from "../logger.js";
import { PiRpcClient } from "./pi-rpc-client.js";
import { PiRunStore } from "./pi-run-store.js";
import type { PiExecutorConfig } from "./config.js";
import { resolveAndValidateWorkspace, buildTrustArgs, buildPluginArgs } from "./config.js";
import type { PiRunRecord, PiRunStatus, PiPendingRequestType, PiUiReply } from "./types.js";
import { captureGitEvidence, computeChangedFilesSummary } from "./evidence.js";
import type { PiRpcEvent } from "./pi-rpc-types.js";
import { nerve } from "../nerve.js";
import { kanbanComplete } from "../tasks/kanban-board.js";

const TAG = "pi-executor";

interface OwnedProcess {
  client: PiRpcClient;
  generation: number;
  runId: string;
  workspacePath: string;
  beforeEvidence: { head?: string; status?: string } | null;
  abortTimer: ReturnType<typeof setTimeout> | null;
  wallClockStart: number;
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

    const state = await owned.client.getState().catch(() => null);
    if (state) {
      await this.settleInitial(runId, state.sessionId, state.sessionFile);
    }

    await this.submitPrompt(runId, run.operationalGoal);

    return "started";
  }

  private async _startProcess(run: PiRunRecord): Promise<OwnedProcess | null> {
    const ws = resolveAndValidateWorkspace(run.workspaceAlias, this.config);
    if (ws.error) {
      this.store.casTransition(run.id, ["queued", "starting"], "failed", { error: ws.error });
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
      const msg = err instanceof Error ? err.message : String(err);
      this.store.casTransition(run.id, ["queued", "starting"], "failed", { error: `Launch failed: ${msg}` });
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

  async steer(runId: string, text: string): Promise<boolean> {
    const owned = this.live.get(runId);
    if (!owned) return false;
    try {
      await owned.client.steer(text);
      this.store.touchActivity(runId);
      return true;
    } catch { return false; }
  }

  async reply(runId: string, requestId: string, value: PiUiReply): Promise<boolean> {
    const run = this.store.get(runId);
    if (!run || run.pendingRequestId !== requestId) return false;
    const owned = this.live.get(runId);
    if (!owned) return false;
    try {
      await owned.client.respondToUi(requestId, value);
      this.store.casTransition(runId, "awaiting_input", "running");
      this.store.touchActivity(runId);
      return true;
    } catch { return false; }
  }

  async cancel(runId: string): Promise<boolean> {
    const owned = this.live.get(runId);
    if (!owned) return false;
    this._cancelProcess(runId, owned);
    return true;
  }

  private _cancelProcess(runId: string, owned: OwnedProcess): void {
    if (!this.store.casTransition(runId, ["running", "awaiting_input", "starting"], "cancelling")) return;

    owned.client.subscribe((event) => {
      if (event.type === "agent_end") {
        this._settleCompletion(runId, owned, true);
      }
    });
    owned.client.abort().catch(() => {});

    const graceMs = this.config.abortGraceMs;
    owned.abortTimer = setTimeout(async () => {
      if (this.live.get(runId) !== owned) return;
      await owned.client.close();
      const afterEvidence = captureGitEvidence(owned.workspacePath);
      const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);
      this.store.casTransition(runId, "cancelling", "cancelled", {
        changedFilesSummary: summary,
        resultSummary: "Cancelled by user",
      });
      this._terminalTransition(runId, "cancelled");
      this.live.delete(runId);
    }, graceMs);
  }

  async checkWallClock(runId: string): Promise<boolean> {
    const owned = this.live.get(runId);
    if (!owned) return false;
    if (Date.now() - owned.wallClockStart > this.config.maxWallClockMs) {
      logWarn(TAG, `Run ${runId} exceeded max wall clock (${this.config.maxWallClockMs}ms) — aborting`);
      this._cancelProcess(runId, owned);
      return true;
    }
    return false;
  }

  private async _onRpcEvent(runId: string, event: PiRpcEvent): Promise<void> {
    this.store.touchActivity(runId);

    switch (event.type) {
      case "agent_start":
        this.store.addProgress(runId, "agent_start", JSON.stringify(event.data ?? {}));
        break;

      case "agent_end":
        await this._settleCompletion(runId, this.live.get(runId), false);
        break;

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
          this.store.casTransition(runId, "running", "awaiting_input", {
            pendingRequestId: reqId,
            pendingRequestType: reqType as PiPendingRequestType,
          });
          this.store.addProgress(runId, "ui", JSON.stringify({ requestId: reqId, type: reqType, title: data?.title }));
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

  private async _settleCompletion(runId: string, owned: OwnedProcess | undefined, wasCancelled: boolean): Promise<void> {
    if (!owned) return;

    const terminalStatus: PiRunStatus = wasCancelled ? "cancelled" : "completed";

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
      const afterEvidence = captureGitEvidence(owned.workspacePath);
      const summary = computeChangedFilesSummary(owned.beforeEvidence, afterEvidence);

      const resultParts: string[] = [];
      if (finalText) resultParts.push(finalText.slice(0, 500));
      const resultSummary = resultParts.join("\n").slice(0, 1000);

      await owned.client.close();

      if (wasCancelled) {
        this.store.casTransition(runId, "cancelling", "cancelled", {
          changedFilesSummary: summary,
          resultSummary,
          usageJson: JSON.stringify(stats).slice(0, 1000),
        });
      } else {
        this.store.casTransition(runId, "running", "completed", {
          piSessionId: state.sessionId,
          changedFilesSummary: summary,
          resultSummary,
          usageJson: JSON.stringify(stats).slice(0, 1000),
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (wasCancelled) {
        this.store.casTransition(runId, "cancelling", "cancelled", { error: errMsg });
      } else {
        this.store.casTransition(runId, "running", "failed", { error: `Completion settlement failed: ${errMsg}` });
      }
    }

    this._terminalTransition(runId, terminalStatus);
    this.live.delete(runId);
  }

  private _terminalTransition(runId: string, status: PiRunStatus): void {
    if (this._stopped) return;
    const run = this.store.get(runId);
    if (!run || !run.cardId) return;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      kanbanComplete(run.cardId, "", run.resultSummary ?? "");
      nerve.fire("card:done", run.cardId);
    }
  }

  async interruptAll(): Promise<void> {
    for (const [runId, owned] of this.live) {
      if (owned.abortTimer) clearTimeout(owned.abortTimer);
      try { await owned.client.close(); } catch { /* ignore */ }
      this.store.casTransition(runId, ["starting", "running", "awaiting_input", "cancelling"], "interrupted");
    }
    this.live.clear();
  }
}
