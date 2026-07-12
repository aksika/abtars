import { existsSync } from "node:fs";
import { PiRunStore } from "./pi-run-store.js";
import { PiExecutor } from "./pi-executor.js";
import { resolveAndValidateWorkspace, type PiExecutorConfig } from "./config.js";
import type { PiRunRecord, PiRunView, PiRunRef, PiRunRequest, PiRunStatus, PiUiReply } from "./types.js";
import { MAX_GOAL_CHARS } from "./types.js";
import type { Spin } from "../spin.js";
import { nerve } from "../nerve.js";
import { logInfo } from "../logger.js";

const TAG = "pi-service";

export type Principal = { userId: string };

export interface PiServiceDeps {
  store: PiRunStore;
  executor: PiExecutor;
  config: PiExecutorConfig;
  spin: Spin;
}

export class PiRunService {
  private readonly deps: PiServiceDeps;

  constructor(deps: PiServiceDeps) {
    this.deps = deps;
  }

  get executor(): PiExecutor { return this.deps.executor; }
  get store(): PiRunStore { return this.deps.store; }
  get config(): PiExecutorConfig { return this.deps.config; }

  async run(input: PiRunRequest, caller: Principal): Promise<PiRunRef> {
    if (!this.deps.config.enabled) throw new Error("Pi executor is not enabled");
    if (caller.userId !== input.owner.principalId) throw new Error("Caller must match the run owner");

    const goal = input.goal.trim();
    if (!goal) throw new Error("Goal is required");
    if (Buffer.byteLength(goal, "utf-8") > MAX_GOAL_CHARS) {
      throw new Error(`Goal exceeds ${MAX_GOAL_CHARS} bytes`);
    }
    if (/(?:sk-(?:proj-)?[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,})/.test(goal)) {
      throw new Error("Goal contains what looks like a secret token — rejected");
    }

    const ws = resolveAndValidateWorkspace(input.workspaceAlias, this.deps.config);
    if (ws.error) throw new Error(ws.error);

    // #1393 — atomic card+run creation in one transaction, no Nerve event inside
    const runId = this.deps.store.generateId();
    const sessionId = `${Date.now()}_C_pi_${runId}`;
    const { cardId } = this.deps.store.createPiCardAndRun({
      runId,
      sessionId,
      title: `Pi: ${goal.slice(0, 80)}`,
      goal,
      workspaceAlias: input.workspaceAlias,
      ownerPrincipalId: input.owner.principalId,
      origin: input.owner.origin,
      originPlatform: input.owner.platform,
      originChatId: input.owner.chatId,
      originPeer: input.owner.peer,
      modelProvider: input.model?.provider,
      modelId: input.model?.modelId,
      thinking: input.model?.thinking,
    });

    nerve.fire("card:queued", cardId);
    logInfo(TAG, `Pi run ${runId} created (card ${cardId})`);

    return { runId, cardId, sessionId, generation: 1 };
  }

  get(runId: string, caller: Principal): PiRunView {
    const run = this.deps.store.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    this._authorize(run, caller);
    return this.deps.store.toView(run, caller.userId);
  }

  list(filter: { status?: PiRunStatus; ownerPrincipalId?: string }, caller: Principal): PiRunView[] {
    const runs = this.deps.store.list(filter);
    return runs
      .filter(r => r.ownerPrincipalId === caller.userId)
      .map(r => this.deps.store.toView(r, caller.userId));
  }

  async reply(runId: string, requestId: string, value: PiUiReply, caller: Principal): Promise<PiRunView> {
    const run = this._getActive(runId, caller);
    if (!run.pendingRequestId) throw new Error(`Run ${runId} has no pending request`);
    if (run.pendingRequestId !== requestId) throw new Error(`Request ID mismatch for run ${runId}`);
    const claim = await this.deps.executor.reply(runId, run.executionGeneration, requestId, value);
    if (!claim.claimed) {
      switch (claim.reason) {
        case "already_consumed": throw new Error(`Request already consumed for run ${runId}`);
        case "wrong_generation": throw new Error(`Stale generation for run ${runId}`);
        case "wrong_status": throw new Error(`Run ${runId} is no longer awaiting input`);
        case "request_mismatch": throw new Error(`Request ID mismatch for run ${runId}`);
        case "missing": throw new Error(`Run ${runId} not found`);
        default: throw new Error(`Failed to reply to run ${runId}`);
      }
    }
    return this.deps.store.toView(this.deps.store.get(runId)!, caller.userId);
  }

  async steer(runId: string, text: string, caller: Principal): Promise<PiRunView> {
    this._getActive(runId, caller);
    const ok = await this.deps.executor.steer(runId, text);
    if (!ok) throw new Error(`Failed to steer run ${runId}`);
    return this.deps.store.toView(this.deps.store.get(runId)!, caller.userId);
  }

  async cancel(runId: string, caller: Principal): Promise<PiRunView> {
    this._getActive(runId, caller);
    const ok = await this.deps.executor.cancel(runId);
    if (!ok) throw new Error(`Failed to cancel run ${runId}`);
    return this.deps.store.toView(this.deps.store.get(runId)!, caller.userId);
  }

  async resume(runId: string, caller: Principal): Promise<PiRunRef> {
    const run = this.deps.store.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    this._authorize(run, caller);

    if (run.resumeCapability !== "available") {
      throw new Error(`Run ${runId} is not resumable (${run.resumeCapability})`);
    }

    const ws = resolveAndValidateWorkspace(run.workspaceAlias, this.deps.config);
    if (ws.error) throw new Error(`Workspace policy changed: ${ws.error}`);

    if (run.piSessionFile && !existsSync(run.piSessionFile)) {
      this.deps.store.casTransition(runId, run.status, run.status, { resumeCapability: "session_missing" });
      throw new Error(`Pi session file not found at ${run.piSessionFile}`);
    }

    const newGen = run.executionGeneration + 1;
    const newSessionId = `${Date.now()}_C_pi_${runId}_gen${newGen}`;

    this.deps.store.casTransition(runId, run.status, "queued", {
      executionGeneration: newGen,
      currentSessionId: newSessionId,
      resumeCapability: "available",
      pendingRequestId: null,
      pendingRequestType: null,
    });

    const updated = this.deps.store.get(runId)!;
    return { runId, cardId: run.cardId, sessionId: newSessionId, generation: updated.executionGeneration };
  }

  private _getActive(runId: string, caller: Principal): PiRunRecord {
    const run = this.deps.store.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    this._authorize(run, caller);
    if (!["starting", "running", "awaiting_input"].includes(run.status)) {
      throw new Error(`Run ${runId} is not active (status: ${run.status})`);
    }
    return run;
  }

  private _authorize(run: PiRunRecord, caller: Principal): void {
    if (run.ownerPrincipalId !== caller.userId) {
      throw new Error(`Run ${run.id} belongs to a different principal`);
    }
  }
}
