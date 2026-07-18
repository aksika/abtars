import { existsSync } from "node:fs";
import { PiRunStore } from "./pi-run-store.js";
import { PiExecutor } from "./pi-executor.js";
import { resolveAndValidateWorkspace, validateSessionFile, type PiExecutorConfig } from "./config.js";
import type { PiRunRecord, PiRunView, PiRunRef, PiRunRequest, PiRunStatus, PiUiReply, PiModelSelection } from "./types.js";
import { MAX_GOAL_CHARS } from "./types.js";
import type { Spin } from "../spin.js";
import { nerve } from "../nerve.js";
import { logInfo, logDebug } from "../logger.js";
import { resolveAgent } from "../transport-config.js";

const TAG = "pi-service";

export type Principal = { userId: string };

export interface PiRunIdempotency {
  clientId: string;
  operation: string;
  requestId: string;
  requestHash: string;
}

export interface PiRunCreationRef extends PiRunRef {
  responseJson?: string;
}

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

  async run(input: PiRunRequest, caller: Principal, idempotency?: PiRunIdempotency): Promise<PiRunCreationRef> {
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

    const runId = this.deps.store.generateId();

    // #1405: Allocate a Spin external session before committing the run
    let spinSessionId: string | undefined;
    try {
      const spinSession = this.deps.spin.allocateExternalSession({
        type: "C",
        userId: input.owner.principalId,
        platform: "pi",
        name: `Pi: ${goal.slice(0, 60)}`,
        workingDir: ws.canonicalPath,
        metadata: { runId, generation: 1, executor: "pi" },
      });
      spinSessionId = spinSession.id;
    } catch (err) {
      throw new Error(`Failed to allocate Spin session: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const model = input.model ?? resolveCodingModel();
      const created = this.deps.store.createPiCardAndRun({
        runId,
        sessionId: spinSessionId,
        title: `Pi: ${goal.slice(0, 80)}`,
        goal,
        priority: input.priority,
        workspaceAlias: input.workspaceAlias,
        ownerPrincipalId: input.owner.principalId,
        origin: input.owner.origin,
        originPlatform: input.owner.platform,
        originChatId: input.owner.chatId,
        originPeer: input.owner.peer,
        modelProvider: model?.provider,
        modelId: model?.modelId,
        thinking: model?.thinking,
        idempotency,
      });

      nerve.fire("card:queued", created.cardId);
      logInfo(TAG, `Pi run ${runId} created (card ${created.cardId})`);
      return { runId, cardId: created.cardId, sessionId: spinSessionId, generation: 1, responseJson: created.responseJson };
    } catch (err) {
      // Compensate: end the allocated Spin session if the transaction failed
      if (spinSessionId) {
        try { this.deps.spin.endExternalSession(spinSessionId, { runId, generation: 1 }); } catch { /* best effort */ }
      }
      throw err;
    }
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

    if (!run.piSessionFile) {
      throw new Error(`Run ${runId} has no saved session file — cannot resume`);
    }

    if (!existsSync(run.piSessionFile)) {
      this.deps.store.casTransition(runId, run.status, run.status, { resumeCapability: "session_missing" });
      throw new Error(`Pi session file not found at ${run.piSessionFile}`);
    }

    // Validate session file
    const validated = validateSessionFile(this.deps.config.sessionStorageRoot, run.piSessionFile);
    if (validated.error) {
      throw new Error(`Session file validation failed: ${validated.error}`);
    }

    const newGen = run.executionGeneration + 1;

    // #1405: Allocate a new Spin external session for the resumed generation
    let spinSessionId: string;
    try {
      const spinSession = this.deps.spin.allocateExternalSession({
        type: "C",
        userId: run.ownerPrincipalId,
        platform: "pi",
        name: `Pi resume: ${run.operationalGoal.slice(0, 60)}`,
        workingDir: ws.canonicalPath,
        metadata: { runId, generation: newGen, executor: "pi" },
      });
      spinSessionId = spinSession.id;
    } catch (err) {
      throw new Error(`Failed to allocate Spin session for resume: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Atomic resume generation commit
    const commit = this.deps.store.queueResumeGeneration({
      runId,
      expectedGeneration: run.executionGeneration,
      newSessionId: spinSessionId,
      sessionFile: validated.canonicalPath!,
    });

    if (!commit.committed) {
      // Compensate: end the pre-allocated session
      try { this.deps.spin.endExternalSession(spinSessionId, { runId, generation: newGen }); } catch { /* best effort */ }
      throw new Error(`Failed to queue resume generation: ${commit.reason}`);
    }

    // Fire card:queued so Reconciler picks it up
    nerve.fire("card:queued", commit.cardId);
    logInfo(TAG, `Pi run ${runId} resumed (generation ${run.executionGeneration} → ${newGen})`);

    return { runId, cardId: run.cardId, sessionId: spinSessionId, generation: newGen };
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

/**
 * Resolve the effective coding provider and model from transport configuration.
 * Returns undefined when no assignment is available — Pi will use its default model.
 */
function resolveCodingModel(): PiModelSelection | undefined {
  try {
    let agent = resolveAgent("cody");
    if (!agent) agent = resolveAgent("main");
    if (!agent) {
      logDebug(TAG, "No coding model assignment configured — Pi will use its default model");
      return undefined;
    }
    return { provider: agent.providerName, modelId: agent.model };
  } catch {
    logDebug(TAG, "Failed to resolve coding model");
    return undefined;
  }
}
