/**
 * sha-incident-coordinator.ts — sole SHA admission and transition owner
 * (#1688 Tasks 6-7). Composes the classifier, incident store, policy,
 * workspace manager, known-fix runner, Kanban/Project/Worker primitives, and
 * an operator-notice port. Provider-neutral: no Telegram or Pi imports.
 *
 * `admit()` is synchronous through the durable admission decision. Long-
 * running work (known-fix commands, Worker stages) begins only after rows
 * commit. Guarded/off outcomes perform zero SHA store writes.
 */
import { nerve } from "../nerve.js";
import { logInfo, logWarn } from "../logger.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { cascadeFail, kanbanEnqueue, kanbanFail, kanbanGetCard, kanbanGetChildren, requireTaskDatabase } from "../tasks/kanban-board.js";
import { loadPiConfig } from "../pi-executor/config.js";
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { ShaWorkspaceManager } from "./sha-workspace-manager.js";
import { createContractId } from "../project-acceptance/project-contract.js";
import { classifyShaFailure, scheduledEventKey, scheduledFingerprint, logEventKey, logFingerprint } from "./sha-classifier.js";
import type { ShaPolicyView } from "./sha-classifier.js";
import { ShaIncidentStore } from "./sha-incident-store.js";
import type { AdmitResult } from "./sha-incident-store.js";
import { ShaKnownFixRunner } from "./sha-known-fix-runner.js";
import type { FixRule } from "./sha-policy.js";
import { loadMergedFixes, logAdmissionAllowed } from "./sha-policy.js";
import {
  SHA_STAGE_CRITERIA,
  SHA_WORKSPACE_ALIAS,
  artifactForStage,
  buildShaRootContract,
  buildShaWorkerContract,
  solutionVerificationArtifact,
  stagesForMode,
} from "./sha-stage-contracts.js";
import { join } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { isPathWithinRoot } from "../workspace-paths.js";
import type { ShaStage } from "./sha-stage-contracts.js";
import type { SelfHealMode, ShaAdmissionOutcome, ShaFailureSignal } from "./sha-types.js";
import type { TaskKind } from "../tasks/task-types.js";

export interface OperatorNotice {
  message: string;
  at: number;
}

/** #1688 R9: platform-neutral port — never Telegram/Pi in core SHA code. */
export interface OperatorNoticeSink {
  send(notice: OperatorNotice): void;
}

export interface ShaIncidentCoordinatorDeps {
  db?: TaskDatabase;
  store?: ShaIncidentStore;
  reviewStore?: ProjectReviewStore;
  workerService?: WorkerSupervisionService;
  supervisionStore?: WorkerSupervisionStore;
  workspaceManager?: ShaWorkspaceManager;
  knownFixRunner?: ShaKnownFixRunner;
  modeProvider: () => SelfHealMode;
  policyView?: () => ShaPolicyView;
  noticeSink?: OperatorNoticeSink;
  /** Sync alias availability check; null means available. */
  aliasAvailability?: () => string | null;
  now?: () => number;
}

const TAG = "sha-coordinator";

export class ShaIncidentCoordinator {
  private readonly db: TaskDatabase;
  private readonly store: ShaIncidentStore;
  private readonly reviewStore: ProjectReviewStore;
  private readonly workerService: WorkerSupervisionService;
  private readonly supervisionStore: WorkerSupervisionStore;
  private readonly workspaceManager: ShaWorkspaceManager;
  private readonly knownFixRunner: ShaKnownFixRunner;
  private readonly modeProvider: () => SelfHealMode;
  private readonly policyView: () => ShaPolicyView;
  private readonly noticeSink?: OperatorNoticeSink;
  private readonly aliasAvailability: () => string | null;

  constructor(deps: ShaIncidentCoordinatorDeps) {
    this.db = deps.db ?? requireTaskDatabase();
    this.store = deps.store ?? new ShaIncidentStore(this.db);
    this.reviewStore = deps.reviewStore ?? new ProjectReviewStore(this.db);
    this.workerService = deps.workerService ?? new WorkerSupervisionService(this.db);
    this.supervisionStore = deps.supervisionStore ?? new WorkerSupervisionStore(this.db);
    this.workspaceManager = deps.workspaceManager ?? new ShaWorkspaceManager();
    this.knownFixRunner = deps.knownFixRunner ?? new ShaKnownFixRunner(undefined, this.workspaceManager);
    this.modeProvider = deps.modeProvider;
    this.policyView = deps.policyView ?? (() => ({ fixes: loadMergedFixes(), logAdmissionAllowed: logAdmissionAllowed() }));
    this.noticeSink = deps.noticeSink;
    this.aliasAvailability = deps.aliasAvailability ?? (() => ShaWorkspaceManagerAliasCheck());
  }

  /**
   * #1688 R5/R6: synchronous admission. Guarded outcomes return before any
   * store access; unknown actionable faults create-or-attach the durable
   * incident, provision the complete blocked placeholder chain and root
   * contract, bind RCA, and — only after commit — fire the queued events.
   */
  admit(signal: ShaFailureSignal): ShaAdmissionOutcome {
    const mode = this.modeProvider();
    const classification = classifyShaFailure(signal, mode, this.policyView());

    switch (classification.classification) {
      case "system":
        return { kind: "ignored", reason: "system" };
      case "credits":
        return { kind: "ignored", reason: "credits" };
      case "external":
        return { kind: "ignored", reason: "external" };
      case "ambiguous":
        return { kind: "ignored", reason: "ambiguous" };
      case "suppressed":
        return classification.reason === "mode off"
          ? { kind: "ignored", reason: "off" }
          : { kind: "ignored", reason: "suppressed" };
      case "known_fix": {
        const rule = this.matchingRule(signal, classification.reason);
        if (!rule) return { kind: "ignored", reason: "suppressed" };
        return this.admitKnownFix(signal, rule);
      }
      case "unknown_actionable":
        return this.admitProject(signal, mode);
    }
  }

  private matchingRule(_signal: ShaFailureSignal, reason: string): FixRule | undefined {
    const pattern = /"([^"]+)"/.exec(reason)?.[1];
    if (!pattern) return undefined;
    return this.policyView().fixes.find((f) => f.pattern === pattern);
  }

  private eventIdentity(signal: ShaFailureSignal): {
    eventKey: string;
    fingerprint: string;
    source: "scheduled" | "log";
    sourceScope: string;
    taskKind?: TaskKind;
    diagnosticJson: string;
    occurredAt: number;
  } {
    if (signal.source === "scheduled") {
      return {
        eventKey: scheduledEventKey(signal),
        fingerprint: scheduledFingerprint(signal),
        source: "scheduled",
        sourceScope: signal.entryId,
        taskKind: signal.taskKind,
        diagnosticJson: JSON.stringify(signal.diagnostic),
        occurredAt: signal.occurredAt,
      };
    }
    return {
      eventKey: logEventKey(signal),
      fingerprint: logFingerprint(signal),
      source: "log",
      sourceScope: `${signal.component}:${signal.tag}`,
      diagnosticJson: JSON.stringify({ message: signal.normalizedMessage }),
      occurredAt: signal.occurredAt,
    };
  }

  /** #1688 R8: known-fix lifecycle — durable admission, then bounded execution. */
  private admitKnownFix(signal: ShaFailureSignal, rule: FixRule): ShaAdmissionOutcome {
    const mode = this.modeProvider();
    if (mode === "off") return { kind: "ignored", reason: "off" };
    if (mode === "investigation" || !ShaKnownFixRunner.executableRule(rule)) {
      return { kind: "known_fix_recommended" };
    }
    const identity = this.eventIdentity(signal);
    const admitted = this.store.admitEventWithCooldown({
      ...identity,
      workflowKind: "known_fix",
      mode: "full",
    }, "autofix-known", rule.pattern, rule.cooldownMin);
    if (admitted.kind === "duplicate_event") return { kind: "duplicate_event" };
    if (admitted.kind === "cooldown") return { kind: "known_fix_recommended" };
    if (admitted.kind === "attached") {
      // Existing running episode: the new event attaches; execution continues.
      return { kind: "known_fix_started", incidentId: admitted.incidentId };
    }
    const incidentId = admitted.incidentId;
    const started = this.store.transition({
      incidentId,
      expectedVersion: 1,
      fromStates: ["provisioning"],
      toState: "known_fix_running",
      reason: `known fix started for "${rule.pattern}"`,
    });
    if (!started.ok) {
      return { kind: "blocked", reason: started.reason };
    }
    void (async () => {
      try {
        const outcome = await this.knownFixRunner.execute(rule);
        const terminal = this.store.transition({
          incidentId,
          expectedVersion: started.version,
          fromStates: ["known_fix_running"],
          toState: outcome.state,
          reason: `${outcome.state}: action exit ${outcome.action.exitCode ?? "null"}, verifier exit ${outcome.verifier?.exitCode ?? "n/a"}`,
        });
        this.store.recordResult(
          "autofix-known",
          rule.pattern,
          outcome.state === "known_fix_verified",
          outcome.state === "known_fix_verified" ? undefined : outcome.action.output.slice(0, 200),
        );
        if (terminal.ok) {
          this.noticeSink?.send({
            at: Date.now(),
            message: `Known fix "${rule.pattern}": ${outcome.state}.`,
          });
        } else {
          logWarn(TAG, `known-fix terminal transition lost CAS for incident ${incidentId}: ${terminal.reason}`);
        }
      } catch (err) {
        this.store.recordResult("autofix-known", rule.pattern, false, err instanceof Error ? err.message : String(err));
        this.store.transition({
          incidentId,
          expectedVersion: started.version,
          fromStates: ["known_fix_running"],
          toState: "known_fix_failed",
          reason: `exception: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();
    return { kind: "known_fix_started", incidentId };
  }

  /** #1688 R5/R6: unknown actionable — atomic project provisioning + RCA binding. */
  private admitProject(signal: ShaFailureSignal, mode: SelfHealMode): ShaAdmissionOutcome {
    if (mode === "off") return { kind: "ignored", reason: "off" };
    if (mode !== "investigation" && mode !== "full") return { kind: "ignored", reason: "off" };

    // R7: admission blocks visibly when the alias is absent/invalid.
    const aliasError = this.aliasAvailability();
    if (aliasError) return { kind: "blocked", reason: aliasError };

    const identity = this.eventIdentity(signal);
    const stages = stagesForMode(mode);

    // Phase 1: incident + root + full placeholder chain + root contract +
    // supervision in ONE transaction. No nerve events before commit.
    const provisioned = this.db.transaction((): {
      admitted: AdmitResult;
      rootCardId: number;
      rcaCardId: number;
      designCardId: number;
      solutionCardId: number | null;
    } => {
      const admitted = this.store.admitEventInTx({ ...identity, workflowKind: "project", mode });
      if (admitted.kind !== "created") {
        return { admitted, rootCardId: 0, rcaCardId: 0, designCardId: 0, solutionCardId: null };
      }
      const rootCardId = kanbanEnqueue(
        `SHA incident: ${identity.sourceScope}`,
        "sha",
        identity.fingerprint,
        {
          type: "O",
          deliveryMode: "silent",
          maxAgents: 2,
          priority: "high",
          fireEvent: false,
        },
      );
      if (rootCardId === 0) throw new Error("SHA root card creation failed (kanban unavailable)");
      const rcaCardId = kanbanEnqueue(`SHA root-cause analysis: ${identity.sourceScope}`, "sha", undefined, {
        type: "W", parent_id: rootCardId, deliveryMode: "silent", fireEvent: false,
      });
      if (rcaCardId === 0) throw new Error("SHA RCA card creation failed");
      const designCardId = kanbanEnqueue(`SHA design: ${identity.sourceScope}`, "sha", undefined, {
        type: "W", parent_id: rootCardId, deliveryMode: "silent", blocked_by: String(rcaCardId), fireEvent: false,
      });
      if (designCardId === 0) throw new Error("SHA design card creation failed");
      let solutionCardId: number | null = null;
      if (stages.includes("solution")) {
        solutionCardId = kanbanEnqueue(`SHA solution: ${identity.sourceScope}`, "sha", undefined, {
          type: "W", parent_id: rootCardId, deliveryMode: "silent", blocked_by: String(designCardId), fireEvent: false,
        });
        if (solutionCardId === 0) throw new Error("SHA solution card creation failed");
      }
      const contract = buildShaRootContract({
        rootCardId,
        mode,
        sourceScope: identity.sourceScope,
        fingerprintPrefix: identity.fingerprint.slice(0, 8),
        deadlineAt: this.now() + (mode === "full" ? 50 * 60_000 : 25 * 60_000),
      });
      this.reviewStore.insertContract(contract);
      this.reviewStore.initializeSupervision(rootCardId, contract.id, "executing");
      this.store.bindProvisioned(admitted.incidentId, rootCardId, rcaCardId);
      return { admitted, rootCardId, rcaCardId, designCardId, solutionCardId };
    });

    if (provisioned.admitted.kind === "duplicate_event") return { kind: "duplicate_event" };
    if (provisioned.admitted.kind === "attached") {
      return {
        kind: "attached",
        incidentId: provisioned.admitted.incidentId,
        rootCardId: provisioned.admitted.rootCardId ?? 0,
        occurrenceCount: provisioned.admitted.occurrenceCount,
      };
    }
    if (provisioned.rootCardId === 0) {
      return { kind: "blocked", reason: "SHA provisioning failed — root card not created" };
    }
    const incidentId = provisioned.admitted.incidentId;
    const { rootCardId, rcaCardId } = provisioned;

    // Phase 2: bind the RCA contract/attempt to the pre-created card, move
    // incident provisioning → rca, in one transaction.
    const activation = this.db.transaction(() => {
      const spec = buildShaWorkerContract({
        rootCardId,
        cardId: rcaCardId,
        stage: "rca",
        contractId: createContractId("sha"),
        sourceScope: identity.sourceScope,
        fingerprintPrefix: identity.fingerprint.slice(0, 8),
      });
      const created = this.workerService.createChild(spec.rawGoal, rootCardId, "sha-coordinator", spec.createChildOpts);
      if ("error" in created) return { ok: false as const, error: created.error };
      const moved = this.store.transition({
        incidentId,
        expectedVersion: 1,
        fromStates: ["provisioning"],
        toState: "rca",
        reason: "activated: RCA bound",
        fields: { currentStageCardId: rcaCardId },
      });
      if (!moved.ok) return { ok: false as const, error: moved.reason };
      return { ok: true as const, attemptId: created.attemptId };
    });

    if (!activation.ok) {
      this.blockIncident(incidentId, rootCardId, `activation failed: ${activation.error}`);
      return { kind: "blocked", reason: activation.error };
    }

    // After commit: the ordinary queued events drive the Reconciler.
    nerve.fire("card:queued", rootCardId);
    nerve.fire("card:queued", rcaCardId);
    return { kind: "project_created", incidentId, rootCardId, mode };
  }

  private now(): number {
    return Date.now();
  }

  /** #1688 R5: terminal block — CAS incident first (so re-entrant nerve
   *  events see it terminal), then cascade placeholders, then block project
   *  under current project authority. A lost incident CAS bails: a stale
   *  block must never block a healthy project. */
  private blockIncident(incidentId: number, rootCardId: number, reason: string, expectedVersion?: number): void {
    try {
      const row = this.store.findById(incidentId);
      if (!row || row.terminalAt !== null) return;
      const version = expectedVersion ?? row.version;
      const fromStates: readonly import("./sha-types.js").ShaIncidentState[] = row.state
        ? [row.state]
        : ["provisioning", "rca", "design", "solution", "review"];
      const review = this.reviewStore;
      const authority = this.supervisionAuthority(rootCardId);
      this.db.transaction(() => {
        const transitioned = this.store.transition({ incidentId, expectedVersion: version, fromStates, toState: "blocked", reason });
        if (!transitioned.ok) {
          logInfo(TAG, `incident ${incidentId}: block CAS lost (${transitioned.reason}) — stale block refused`);
          return;
        }
        try {
          const children = kanbanGetChildren(rootCardId);
          const fromId = row.currentStageCardId ?? rootCardId;
          cascadeFail(fromId, children);
          if (!row.currentStageCardId) {
            for (const child of children) {
              if (child.status === "queued") kanbanFail(child.id, `blocked: ${reason.slice(0, 200)}`);
            }
          }
        } catch { /* best-effort cascade */ }
        review.blockProject(rootCardId, reason, {}, { failCard: true, authority });
      });
      // #1688 review: fire the root failed event after commit so other nerve
      // listeners observe the terminal block.
      nerve.fire("card:failed", rootCardId);
    } catch (err) {
      logWarn(TAG, `blockIncident failed for ${incidentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private supervisionAuthority(rootCardId: number): import("../project-acceptance/project-review-store.js").ProjectMutationAuthority {
    const supervision = this.reviewStore.getSupervision(rootCardId);
    return { projectCardId: rootCardId, projectGeneration: supervision?.generation ?? 1 };
  }

// ── #1688 Task 7: stage progression, terminal settlement, boot recovery ────

/**
 * Subscribe to terminal card events for SHA stage/root progression. Returns a
 * disposer. Progression is nerve-event driven; no heartbeat task exists.
 */
subscribe(): () => void {
  const onDone = (cardId: number): void => {
    void this.onCardTerminal(cardId, "done");
  };
  const onFailed = (cardId: number): void => {
    void this.onCardTerminal(cardId, "failed");
  };
  nerve.on("card:done", onDone);
  nerve.on("card:failed", onFailed);
  return () => {
    nerve.off("card:done", onDone);
    nerve.off("card:failed", onFailed);
  };
}

/** Resolve the nonterminal incident owning this card (stage or root). */
private incidentForCard(cardId: number): { incident: import("./sha-incident-store.js").IncidentRow; isRoot: boolean } | null {
  const row = this.store.findByIdForCard(cardId);
  if (!row) return null;
  if (row.terminalAt !== null) return null;
  return { incident: row, isRoot: row.rootCardId === cardId };
}

/** #1688 R5: event-driven stage/root settlement. Idempotent under duplicate
 *  or reordered card events. */
private async onCardTerminal(cardId: number, kind: "done" | "failed"): Promise<void> {
  const found = this.incidentForCard(cardId);
  if (!found) return;
  const { incident, isRoot } = found;

  if (isRoot) {
    if (kind === "failed") {
      this.blockIncident(incident.id, cardId, "root failed", incident.version);
      return;
    }
    // Accepted root: the Orc final review is the terminal authority.
    const toState = incident.mode === "investigation" ? "investigation_complete" : "accepted";
    const terminal = this.store.transition({
      incidentId: incident.id,
      expectedVersion: incident.version,
      fromStates: ["review"],
      toState,
      reason: `root accepted (${toState})`,
    });
    if (terminal.ok) {
      logInfo(TAG, `Incident ${incident.id} terminalized as ${toState}`);
      this.noticeSink?.send({ at: Date.now(), message: `SHA incident ${incident.id} ${toState}.` });
    }
    return;
  }

  if (kind === "failed") {
    this.blockIncident(incident.id, incident.rootCardId ?? 0, `stage card #${cardId} failed`, incident.version);
    return;
  }

  // Stage success: validate envelope + workspace postcondition, then bind.
  await this.advanceStage(incident, cardId);
}

/** #1688 R5: accepted stage evidence binds exactly the next placeholder. */
private async advanceStage(
  incident: import("./sha-incident-store.js").IncidentRow,
  stageCardId: number,
): Promise<void> {
  const stage = this.stageOf(incident, stageCardId);
  if (!stage) {
    logWarn(TAG, `incident ${incident.id}: card #${stageCardId} is not a current stage card — ignoring`);
    return;
  }

  // Ordinary Worker envelope validation.
  const attempt = this.supervisionStore.getLatestAttempt(stageCardId);
  const envelope = attempt ? this.supervisionStore.getResultByAttempt(attempt.id)?.envelope : undefined;
  if (!envelope || envelope.outcome !== "completed") {
    logWarn(TAG, `incident ${incident.id}: stage ${stage} envelope invalid/missing for card #${stageCardId} — blocking`);
    this.blockIncident(incident.id, incident.rootCardId ?? 0, `stage ${stage} produced no completed envelope`, incident.version);
    return;
  }

  const expectedArtifact = artifactForStage(stage);
  const artifact = envelope.artifacts?.find((a) => a.artifact_id === expectedArtifact.id);
  if (!artifact || !artifact.exists || !artifact.digest) {
    this.blockIncident(incident.id, incident.rootCardId ?? 0, `stage ${stage} missing expected artifact ${expectedArtifact.ref}`, incident.version);
    return;
  }

  // Workspace postconditions (async, before any binding). The stage has
  // legitimately written its evidence artifact, so the clean requirement is
  // lifted; identity/protected-root revalidation still applies.
  const preflight = await this.workspaceManager.resolve({ requireClean: false });
  if (!preflight.ok) {
    this.blockIncident(incident.id, incident.rootCardId ?? 0, `workspace preflight failed: ${preflight.error}`, incident.version);
    return;
  }
  if (stage === "rca" || stage === "design") {
    const clean = await this.workspaceManager.assertAnalysisCleanExcluding(preflight, [expectedArtifact.ref]);
    if (!clean.ok) {
      this.blockIncident(incident.id, incident.rootCardId ?? 0, `stage ${stage} mutated the workspace: ${clean.error}`, incident.version);
      return;
    }
    // The disposable checkout is reset before the next stage. Preserve the
    // accepted analysis artifact first; the root review must not depend on a
    // file that has already been deleted from the worker workspace.
    const copied = await this.workspaceManager.copyEvidence(
      preflight,
      incident.id,
      stage,
      join(preflight.canonicalPath, expectedArtifact.ref),
    );
    if (!copied.ok) {
      this.blockIncident(incident.id, incident.rootCardId ?? 0, `${stage} evidence copy failed: ${copied.error}`, incident.version);
      return;
    }
    // Investigation ends after design, so there is no next-stage binding to
    // perform the normal baseline reset. Restore the disposable checkout
    // before entering review just as the full-mode path does.
    if (stage === "design" && incident.mode === "investigation") {
      const restored = await this.workspaceManager.prepareStage(preflight);
      if (!restored.ok) {
        this.blockIncident(incident.id, incident.rootCardId ?? 0, `workspace restore failed: ${restored.error}`, incident.version);
        return;
      }
    }
  } else {
    const verification = solutionVerificationArtifact();
    const verificationArtifact = envelope.artifacts?.find((a) => a.artifact_id === verification.id);
    if (!verificationArtifact || !verificationArtifact.exists || !verificationArtifact.digest) {
      this.blockIncident(incident.id, incident.rootCardId ?? 0, `stage ${stage} missing expected artifact ${verification.ref}`, incident.version);
      return;
    }
    const patchPath = join(preflight.canonicalPath, artifact.ref);
    const verificationPath = join(preflight.canonicalPath, verification.ref);
    const copiedPatch = await this.workspaceManager.copyEvidence(preflight, incident.id, "solution", patchPath);
    if (!copiedPatch.ok) {
      this.blockIncident(incident.id, incident.rootCardId ?? 0, `solution evidence copy failed: ${copiedPatch.error}`, incident.version);
      return;
    }
    const copiedVerification = await this.workspaceManager.copyEvidence(preflight, incident.id, "solution", verificationPath);
    if (!copiedVerification.ok) {
      this.blockIncident(incident.id, incident.rootCardId ?? 0, `solution verification copy failed: ${copiedVerification.error}`, incident.version);
      return;
    }
    // Restore the disposable checkout after preserving the evidence.
    const restored = await this.workspaceManager.prepareStage(preflight);
    if (!restored.ok) {
      this.blockIncident(incident.id, incident.rootCardId ?? 0, `workspace restore failed: ${restored.error}`, incident.version);
      return;
    }
  }

  await this.bindNextStage(incident, stage, { stage, artifactRef: expectedArtifact.ref, digest: artifact.digest });
}

/** Map the current stage card to its stage name; undefined when not current. */
private stageOf(incident: import("./sha-incident-store.js").IncidentRow, cardId: number): ShaStage | null {
  if (incident.currentStageCardId !== cardId) return null;
  switch (incident.state) {
    case "rca": return "rca";
    case "design": return "design";
    case "solution": return "solution";
    default: return null;
  }
}

/** #1688 R5: bind the next placeholder contract, then fire its queued event. */
private async bindNextStage(
  incident: import("./sha-incident-store.js").IncidentRow,
  stage: ShaStage,
  predecessor: { stage: ShaStage; artifactRef: string; digest: string },
): Promise<void> {
  const next: { stage: ShaStage; criterionId: string } | null =
    stage === "rca" ? { stage: "design", criterionId: SHA_STAGE_CRITERIA.design }
    : stage === "design" && incident.mode === "full" ? { stage: "solution", criterionId: SHA_STAGE_CRITERIA.solution }
    : null;

  if (!next) {
    // Last stage accepted — move the incident to review; the Orc review owns
    // the terminal mapping.
    const moved = this.store.transition({
      incidentId: incident.id,
      expectedVersion: incident.version,
      fromStates: [incident.state],
      toState: "review",
      reason: `stage ${stage} accepted; awaiting Orc final review`,
    });
    if (moved.ok) {
      const review = this.reviewStore;
      review.setState(incident.rootCardId ?? 0, "review_ready");
      const { requestReconcileForProject } = await import("../reconciler.js");
      requestReconcileForProject(incident.rootCardId ?? 0);
    }
    return;
  }

  // Prepare the disposable workspace before the next Worker dispatch: the
  // previous stage left its evidence artifacts, so resolve without the clean
  // requirement, then reset to the captured baseline.
  const preflight = await this.workspaceManager.resolve({ requireClean: false });
  if (!preflight.ok) {
    this.blockIncident(incident.id, incident.rootCardId ?? 0, `workspace preflight failed: ${preflight.error}`, incident.version);
    return;
  }
  const prepared = await this.workspaceManager.prepareStage(preflight);
  if (!prepared.ok) {
    this.blockIncident(incident.id, incident.rootCardId ?? 0, `workspace reset failed: ${prepared.error}`, incident.version);
    return;
  }

  const binding = this.db.transaction(() => {
    // Re-read: the stage may have advanced while the async workspace work
    // ran. Derive the expected stage and card from CURRENT durable state.
    const current = this.store.findById(incident.id);
    if (!current || current.terminalAt !== null) return { ok: false as const, lost: true as const, error: "incident already terminal" };
    const expectedNext = current.state === "rca" ? "design" : current.state === "design" && current.mode === "full" ? "solution" : null;
    if (expectedNext !== next.stage) {
      return { ok: false as const, lost: true as const, error: `state moved to ${current.state} — duplicate/reordered event` };
    }
    const nextCardId = this.nextPlaceholderCardId(current.rootCardId ?? 0);
    if (nextCardId === null) {
      return { ok: false as const, lost: false as const, error: `no placeholder card found for stage ${next.stage}` };
    }
    const spec = buildShaWorkerContract({
      rootCardId: current.rootCardId ?? 0,
      cardId: nextCardId,
      stage: next.stage,
      contractId: createContractId("sha"),
      sourceScope: current.sourceScope,
      fingerprintPrefix: current.fingerprint.slice(0, 8),
      predecessorEvidence: predecessor,
    });
    const created = this.workerService.createChild(spec.rawGoal, current.rootCardId ?? 0, "sha-coordinator", spec.createChildOpts);
    if ("error" in created) {
      // Throw so createChild's partial writes roll back with the outer tx.
      throw new Error(`binding ${next.stage}: ${created.error}`);
    }
    const moved = this.store.transition({
      incidentId: current.id,
      expectedVersion: current.version,
      fromStates: [current.state],
      toState: next.stage,
      reason: `stage ${stage} accepted; bound ${next.stage}`,
      fields: { currentStageCardId: nextCardId },
    });
    if (!moved.ok) {
      throw new Error(`binding ${next.stage}: CAS lost (${moved.reason})`);
    }
    return { ok: true as const, lost: false as const, cardId: nextCardId };
  });

  if (!binding.ok) {
    if (binding.lost) {
      logInfo(TAG, `incident ${incident.id}: stage ${stage} binding lost CAS — duplicate/reordered event, ignoring`);
      return;
    }
    this.blockIncident(incident.id, incident.rootCardId ?? 0, `binding ${next.stage} failed: ${binding.error}`, incident.version);
    return;
  }
  nerve.fire("card:queued", binding.cardId);
}

/** Find the first unbound queued placeholder card (sequential binding). */
private nextPlaceholderCardId(rootCardId: number): number | null {
  const children = kanbanGetChildren(rootCardId);
  for (const child of children) {
    if (child.type !== "W" || child.status !== "queued") continue;
    const contract = this.supervisionStore.getContractByCardId(child.id);
    if (contract) continue;
    return child.id;
  }
  return null;
}

/**
 * #1688 R5: one bounded boot recovery pass over nonterminal incidents.
 * Deterministic table per design §5; no heartbeat polling.
 */
runBootRecovery(): void {
  for (const incident of this.store.listNonTerminal()) {
    try {
      this.recoverOne(incident);
    } catch (err) {
      logWarn(TAG, `boot recovery failed for incident ${incident.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

private recoverOne(incident: import("./sha-incident-store.js").IncidentRow): void {
  // #1688 review: a crash mid-known-fix leaves known_fix_running. The
  // process is gone by definition at boot — terminalize truthfully; the
  // partial unique index then admits a fresh episode for later events.
  if (incident.state === "known_fix_running") {
    this.store.transition({
      incidentId: incident.id,
      expectedVersion: incident.version,
      fromStates: ["known_fix_running"],
      toState: "known_fix_failed",
      reason: "recovery: known-fix execution interrupted by restart",
    });
    return;
  }
  const rootCardId = incident.rootCardId;
  if (incident.state === "provisioning" && (rootCardId === null || rootCardId === 0)) {
    this.store.transition({ incidentId: incident.id, expectedVersion: incident.version, fromStates: ["provisioning"], toState: "blocked", reason: "provisioning_incomplete: no root card" });
    return;
  }
  if (rootCardId === null || rootCardId === 0) return;
  const root = kanbanGetCard(rootCardId);
  if (!root) {
    this.store.transition({ incidentId: incident.id, expectedVersion: incident.version, fromStates: ["provisioning", "rca", "design", "solution", "review"], toState: "blocked", reason: "provisioning_incomplete: root card missing" });
    return;
  }
  if (root.status === "failed") {
    this.store.transition({ incidentId: incident.id, expectedVersion: incident.version, fromStates: ["provisioning", "rca", "design", "solution", "review"], toState: "blocked", reason: "root failed" });
    return;
  }
  if (root.status === "done" || root.status === "delivered") {
    if (incident.state !== "review") {
      this.store.transition({
        incidentId: incident.id,
        expectedVersion: incident.version,
        fromStates: [incident.state],
        toState: "blocked",
        reason: `recovery: root ${root.status} before final review (state=${incident.state})`,
      });
      return;
    }
    const toState = incident.mode === "investigation" ? "investigation_complete" : "accepted";
    this.store.transition({ incidentId: incident.id, expectedVersion: incident.version, fromStates: ["review"], toState, reason: `boot: root ${root.status}` });
    return;
  }
  if (incident.state === "provisioning") {
    // Provisioning with a complete card set but no bound RCA — bind and activate.
    const children = kanbanGetChildren(rootCardId);
    const rca = children.find((c) => c.type === "W" && c.status === "queued");
    if (!rca) {
      this.store.transition({ incidentId: incident.id, expectedVersion: incident.version, fromStates: ["provisioning"], toState: "blocked", reason: "provisioning_incomplete: no RCA placeholder" });
      return;
    }
    const contract = this.supervisionStore.getContractByCardId(rca.id);
    if (!contract) {
      void this.bindRcaOnRecovery(incident, rca.id);
    }
    return;
  }
  if (incident.state === "review") {
    import("../reconciler.js").then(({ requestReconcileForProject }) => requestReconcileForProject(rootCardId)).catch(() => { /* best-effort */ });
    return;
  }
  // Stage state: live attempt → owned by existing Worker recovery. Terminal
  // stage card with an unbound placeholder → bind next.
  const stageCardId = incident.currentStageCardId;
  if (stageCardId === null) {
    this.store.transition({ incidentId: incident.id, expectedVersion: incident.version, fromStates: [incident.state], toState: "blocked", reason: "recovery: no current stage card" });
    return;
  }
  const stageCard = kanbanGetCard(stageCardId);
  if (!stageCard) {
    this.store.transition({ incidentId: incident.id, expectedVersion: incident.version, fromStates: [incident.state], toState: "blocked", reason: "recovery: stage card missing" });
    return;
  }
  if (stageCard.status === "failed") {
    this.blockIncident(incident.id, rootCardId, `recovery: stage card #${stageCardId} failed`, incident.version);
    return;
  }
  if (stageCard.status === "done" || stageCard.status === "delivered") {
    const stage = this.stageOf(incident, stageCardId);
    if (stage) {
      void this.advanceStage(incident, stageCardId);
    }
  }
}

private async bindRcaOnRecovery(incident: import("./sha-incident-store.js").IncidentRow, rcaCardId: number): Promise<void> {
  const rootCardId = incident.rootCardId;
  if (rootCardId === null) return;
  const activation = this.db.transaction(() => {
    const spec = buildShaWorkerContract({
      rootCardId,
      cardId: rcaCardId,
      stage: "rca",
      contractId: createContractId("sha"),
      sourceScope: incident.sourceScope,
      fingerprintPrefix: incident.fingerprint.slice(0, 8),
    });
    const created = this.workerService.createChild(spec.rawGoal, rootCardId, "sha-coordinator", spec.createChildOpts);
    if ("error" in created) return { ok: false as const, error: created.error };
    const moved = this.store.transition({
      incidentId: incident.id,
      expectedVersion: incident.version,
      fromStates: ["provisioning"],
      toState: "rca",
      reason: "boot recovery: RCA bound",
      fields: { currentStageCardId: rcaCardId },
    });
    if (!moved.ok) return { ok: false as const, error: moved.reason };
    return { ok: true as const };
  });
  if (!activation.ok) {
    this.blockIncident(incident.id, rootCardId, `recovery activation failed: ${activation.error}`, incident.version);
    return;
  }
  nerve.fire("card:queued", rootCardId);
  nerve.fire("card:queued", rcaCardId);
}

}

/** R7 sync alias availability: Pi enabled + fixed alias + alias-level never. */
export function ShaWorkspaceManagerAliasCheck(): string | null {
  const config = loadPiConfig();
  if (!config) return "Pi executor is disabled — SHA stages require the configured Pi alias";
  const mapping = config.workspaceAliases[SHA_WORKSPACE_ALIAS];
  if (!mapping) return `workspace alias "${SHA_WORKSPACE_ALIAS}" is not configured`;
  if (mapping.projectTrust !== "never") return `alias "${SHA_WORKSPACE_ALIAS}" must set projectTrust="never"`;
  if (!mapping.root) return `alias "${SHA_WORKSPACE_ALIAS}" must configure a containing root`;
  try {
    const canonicalRoot = realpathSync(mapping.root);
    const canonicalPath = realpathSync(mapping.path);
    if (!statSync(canonicalRoot).isDirectory()) return `configured root "${canonicalRoot}" is not a directory`;
    if (!statSync(canonicalPath).isDirectory()) return `workspace path "${canonicalPath}" is not a directory`;
    if (canonicalRoot === canonicalPath || !isPathWithinRoot(canonicalRoot, canonicalPath)) {
      return `workspace alias "${SHA_WORKSPACE_ALIAS}" must be strictly inside configured root`;
    }
  } catch {
    return `workspace alias "${SHA_WORKSPACE_ALIAS}" path or root does not exist`;
  }
  return null;
}
