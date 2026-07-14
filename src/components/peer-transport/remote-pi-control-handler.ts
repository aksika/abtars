/**
 * peer-transport/remote-pi-control-handler.ts — Owner-side control handler (#1358).
 *
 * Processes authenticated control commands from the origin peer:
 * status, reply, steer, cancel, and resume.
 */

import type { PiRunService } from "../pi-executor/pi-run-service.js";
import type { PiRunRecord } from "../pi-executor/types.js";
import type {
  RemotePiControlRequestV1,
  RemotePiControlResponseV1,
  RemotePiCommandV1,
  ControlOutcome,
  CommandLedgerState,
  ControlErrorCode,
  ResumeApprovalV1,
} from "./remote-pi-types.js";
import {
  validateControlRequestV1,
  validateResumeApproval,
  createControlError,
  computeControlRequestHash,
  verifyApprovalStatement,
  REMOTE_PI_BOUNDS,
} from "./remote-pi-types.js";
import type { PiRunStore } from "../pi-executor/pi-run-store.js";
import { buildPublicProjection } from "./remote-pi-projection.js";
import { logInfo, logDebug, logTrace, logWarn, logError } from "../logger.js";

const TAG = "remote-pi-control-handler";

export interface ControlHandlerDeps {
  store: PiRunStore;
  service: PiRunService;
}

/**
 * Represents an authenticated peer identity.
 */
export interface AuthenticatedPeer {
  peerName: string;
  principalId: string;
}

/**
 * Owner-side control handler for remote Pi commands.
 */
export class RemotePiControlHandler {
  private readonly deps: ControlHandlerDeps;

  constructor(deps: ControlHandlerDeps) {
    this.deps = deps;
  }

  /**
   * Handle an incoming control request from an authenticated peer.
   */
  async handleControlRequest(authenticatedPeer: AuthenticatedPeer, request: RemotePiControlRequestV1): Promise<RemotePiControlResponseV1> {
    // Validate request schema
    try {
      validateControlRequestV1(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, `Invalid control request from ${authenticatedPeer.peerName}: ${message}`);
      return createControlError(request.command_id, "INTERNAL_ERROR", "Invalid request schema", { details: message });
    }

    // Check payload size
    const payloadBytes = Buffer.byteLength(JSON.stringify(request), "utf-8");
    if (payloadBytes > REMOTE_PI_BOUNDS.MAX_COMMAND_SIZE) {
      return createControlError(
        request.command_id,
        "PAYLOAD_TOO_LARGE",
        `Command payload exceeds ${REMOTE_PI_BOUNDS.MAX_COMMAND_SIZE} bytes`,
        { size: payloadBytes }
      );
    }

    // Load the run
    const run = this.deps.store.get(request.run_id);
    if (!run) {
      return createControlError(request.command_id, "UNKNOWN_RUN", `Run ${request.run_id} not found`);
    }

    // Verify peer ownership
    if (!run.originPeer || run.originPeer !== authenticatedPeer.peerName) {
      logError(TAG, `Forbidden control from ${authenticatedPeer.peerName} on run ${request.run_id} (owner: ${run.originPeer})`);
      return createControlError(request.command_id, "FORBIDDEN_PEER", "Run belongs to a different peer");
    }

    // Compute payload hash for idempotency
    const payloadHash = computeControlRequestHash(request);

    // Reserve command slot (idempotency)
    const reservation = this.deps.store.reserveCommand({
      originPeer: authenticatedPeer.peerName,
      commandId: request.command_id,
      runId: request.run_id,
      payloadHash,
    });

    if (reservation.result === "conflict") {
      return createControlError(request.command_id, "CONFLICTING_COMMAND", "Command ID reused with different payload");
    }

    if (reservation.result === "replay_completed") {
      // Return the previous final response
      const existing = this.deps.store.getCommand(authenticatedPeer.peerName, request.command_id);
      if (existing?.response_json) {
        logTrace(TAG, `Returning cached response for command ${request.command_id} state=${existing.state}`);
        return JSON.parse(existing.response_json) as RemotePiControlResponseV1;
      }
      // Fall through if no response stored (shouldn't happen, but be safe)
      return createControlError(request.command_id, "INTERNAL_ERROR", "Command in terminal state without response");
    }

    if (reservation.result === "replay_dispatch_started") {
      // Crash between dispatch_started and response persistence.
      // NEVER re-dispatch a side effect. Return outcome_unknown.
      // Reconciliation may later convert this to a proven outcome.
      const outcomeUnknown: RemotePiControlResponseV1 = {
        version: 1,
        command_id: request.command_id,
        outcome: "outcome_unknown",
        error: {
          code: "INTERNAL_ERROR",
          message: "Command outcome unknown — dispatch started but no response was persisted. Reconciliation required.",
        },
      };
      // Persist the outcome_unknown response so future replays are consistent
      this._recordCommandOutcome(authenticatedPeer.peerName, request.command_id, outcomeUnknown);
      logWarn(TAG, `Command ${request.command_id} replayed after dispatch_started — returning outcome_unknown`);
      return outcomeUnknown;
    }

    // reservation.result === "new" — proceed

    // Validate expected generation BEFORE writing dispatch_started. Stale
    // requests are hard rejects: they don't need the dispatch barrier because
    // no Pi side effect will fire. Writing the barrier first would pollute
    // the command ledger with rows that are immediately transitioned to
    // rejected on a flood of stale requests.
    if (request.expected_generation !== run.executionGeneration) {
      const error = createControlError(
        request.command_id,
        "STALE_GENERATION",
        `Expected generation ${request.expected_generation}, run is at ${run.executionGeneration}`
      );
      this._recordCommandOutcome(authenticatedPeer.peerName, request.command_id, error);
      return error;
    }

    // Update state to dispatch_started for side-effecting commands BEFORE
    // calling Pi. This must happen before the side effect so a crash here
    // yields outcome_unknown on the next replay.
    const isSideEffecting = request.command.action !== "status";
    if (isSideEffecting) {
      this.deps.store.updateCommand({
        originPeer: authenticatedPeer.peerName,
        commandId: request.command_id,
        state: "dispatch_started",
      });
    }

    // Dispatch based on action
    let response: RemotePiControlResponseV1;
    try {
      response = await this._dispatchCommand(authenticatedPeer, request, run);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, `Error dispatching command ${request.command_id}: ${message}`);
      response = createControlError(request.command_id, "INTERNAL_ERROR", "Command dispatch failed", { details: message });
    }

    // Record outcome
    this._recordCommandOutcome(authenticatedPeer.peerName, request.command_id, response);

    logInfo(TAG, `Handled ${request.command.action} command ${request.command_id} for run ${request.run_id} outcome=${response.outcome}`);

    return response;
  }

  /**
   * Dispatch a command to the appropriate handler.
   */
  private async _dispatchCommand(
    authenticatedPeer: AuthenticatedPeer,
    request: RemotePiControlRequestV1,
    run: PiRunRecord
  ): Promise<RemotePiControlResponseV1> {
    const principal = { userId: authenticatedPeer.principalId };

    switch (request.command.action) {
      case "status":
        return this._handleStatus(authenticatedPeer, request, run);

      case "reply":
        return this._handleReply(authenticatedPeer, request, run, principal);

      case "steer":
        return this._handleSteer(authenticatedPeer, request, run, principal);

      case "cancel":
        return this._handleCancel(authenticatedPeer, request, run, principal);

      case "resume":
        return this._handleResume(authenticatedPeer, request, run, principal);

      default:
        const _exhaustive: never = request.command;
        return createControlError(request.command_id, "UNSUPPORTED_ACTION", `Unsupported action: ${String(request.command)}`);
    }
  }

  /**
   * Handle status command (read-only).
   */
  private async _handleStatus(
    authenticatedPeer: AuthenticatedPeer,
    request: RemotePiControlRequestV1,
    run: PiRunRecord
  ): Promise<RemotePiControlResponseV1> {
    const projection = this._buildPublicProjection(run);
    return {
      version: 1,
      command_id: request.command_id,
      outcome: "succeeded",
      projection,
    };
  }

  /**
   * Handle reply command.
   */
  private async _handleReply(
    authenticatedPeer: AuthenticatedPeer,
    request: RemotePiControlRequestV1,
    run: PiRunRecord,
    principal: { userId: string }
  ): Promise<RemotePiControlResponseV1> {
    if (run.status !== "awaiting_input") {
      return createControlError(request.command_id, "INVALID_STATE", `Run is not awaiting input (status: ${run.status})`);
    }

    if (run.pendingRequestId !== request.command.request_id) {
      return createControlError(request.command_id, "MISSING_REQUEST", "Pending request ID mismatch");
    }

    // Validate reply value size
    const valueBytes = Buffer.byteLength(JSON.stringify(request.command.value), "utf-8");
    if (valueBytes > REMOTE_PI_BOUNDS.MAX_REPLY_VALUE_SIZE) {
      return createControlError(
        request.command_id,
        "PAYLOAD_TOO_LARGE",
        `Reply value exceeds ${REMOTE_PI_BOUNDS.MAX_REPLY_VALUE_SIZE} bytes`,
        { size: valueBytes }
      );
    }

    // Call PiRunService.reply
    try {
      const view = await this.deps.service.reply(request.run_id, request.command.request_id, request.command.value, principal);
      const projection = this._buildPublicProjection(this.deps.store.get(request.run_id)!);
      return {
        version: 1,
        command_id: request.command_id,
        outcome: "succeeded",
        projection,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already consumed") || message.includes("Request ID mismatch")) {
        return createControlError(request.command_id, "MISSING_REQUEST", message);
      }
      if (message.includes("wrong generation")) {
        return createControlError(request.command_id, "STALE_GENERATION", message);
      }
      if (message.includes("no longer awaiting")) {
        return createControlError(request.command_id, "INVALID_STATE", message);
      }
      return createControlError(request.command_id, "INTERNAL_ERROR", message);
    }
  }

  /**
   * Handle steer command.
   */
  private async _handleSteer(
    authenticatedPeer: AuthenticatedPeer,
    request: RemotePiControlRequestV1,
    run: PiRunRecord,
    principal: { userId: string }
  ): Promise<RemotePiControlResponseV1> {
    if (!["starting", "running", "awaiting_input"].includes(run.status)) {
      return createControlError(request.command_id, "INVALID_STATE", `Run cannot be steered in status: ${run.status}`);
    }

    try {
      const view = await this.deps.service.steer(request.run_id, request.command.instruction, principal);
      const projection = this._buildPublicProjection(this.deps.store.get(request.run_id)!);
      return {
        version: 1,
        command_id: request.command_id,
        outcome: "succeeded",
        projection,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("no longer active")) {
        return createControlError(request.command_id, "INVALID_STATE", message);
      }
      return createControlError(request.command_id, "INTERNAL_ERROR", message);
    }
  }

  /**
   * Handle cancel command.
   */
  private async _handleCancel(
    authenticatedPeer: AuthenticatedPeer,
    request: RemotePiControlRequestV1,
    run: PiRunRecord,
    principal: { userId: string }
  ): Promise<RemotePiControlResponseV1> {
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      // Cancel is idempotent for terminal states
      const projection = this._buildPublicProjection(run);
      return {
        version: 1,
        command_id: request.command_id,
        outcome: "succeeded",
        projection,
      };
    }

    try {
      const view = await this.deps.service.cancel(request.run_id, principal);
      const projection = this._buildPublicProjection(this.deps.store.get(request.run_id)!);
      return {
        version: 1,
        command_id: request.command_id,
        outcome: "succeeded",
        projection,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("no longer active")) {
        // Already terminal - succeed anyway
        const projection = this._buildPublicProjection(run);
        return {
          version: 1,
          command_id: request.command_id,
          outcome: "succeeded",
          projection,
        };
      }
      return createControlError(request.command_id, "INTERNAL_ERROR", message);
    }
  }

  /**
   * Handle resume command with operator approval.
   */
  private async _handleResume(
    authenticatedPeer: AuthenticatedPeer,
    request: RemotePiControlRequestV1,
    run: PiRunRecord,
    principal: { userId: string }
  ): Promise<RemotePiControlResponseV1> {
    const approval = request.command.approval;

    // Validate approval structure and bindings
    try {
      validateResumeApproval(approval);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return createControlError(request.command_id, "INVALID_APPROVAL", message);
    }

    // Verify approval statement hash matches canonical payload
    if (!verifyApprovalStatement(approval)) {
      return createControlError(request.command_id, "INVALID_APPROVAL", "Approval statement hash does not match canonical payload");
    }

    // Verify approval bindings
    if (approval.run_id !== request.run_id) {
      return createControlError(request.command_id, "INVALID_APPROVAL", "Approval run_id mismatch");
    }
    if (approval.origin_peer !== authenticatedPeer.peerName) {
      return createControlError(request.command_id, "INVALID_APPROVAL", "Approval origin_peer mismatch");
    }
    if (approval.command_id !== request.command_id) {
      return createControlError(request.command_id, "INVALID_APPROVAL", "Approval command_id mismatch");
    }
    if (approval.interrupted_generation !== request.expected_generation) {
      return createControlError(request.command_id, "INVALID_APPROVAL", "Approval generation mismatch");
    }

    // Check freshness
    const now = new Date();
    const expiresAt = new Date(approval.expires_at);
    const issuedAt = new Date(approval.issued_at);
    if (expiresAt < now) {
      return createControlError(request.command_id, "EXPIRED_APPROVAL", "Approval has expired");
    }
    if (issuedAt > now) {
      return createControlError(request.command_id, "INVALID_APPROVAL", "Approval issued in the future");
    }

    // Atomically consume the approval — single-use enforcement.
    // This must happen BEFORE calling Pi resume.
    const consumed = this.deps.store.consumeApproval({
      approvalId: approval.approval_id,
      runId: request.run_id,
      originPeer: authenticatedPeer.peerName,
      commandId: request.command_id,
    });
    if (!consumed.consumed) {
      return createControlError(request.command_id, "INVALID_APPROVAL", consumed.reason);
    }
    // If !firstUse, this is an idempotent replay of the same command+approval.
    // The command ledger (dispatch_started/outcome_unknown) handles that path.
    // At this point we've already passed the ledger check, so firstUse is expected.

    // Verify run is resumable
    if (run.resumeCapability !== "available") {
      return createControlError(request.command_id, "MISSING_RESUME_CAPABILITY", `Run is not resumable (${run.resumeCapability})`);
    }

    if (!["interrupted", "failed"].includes(run.status)) {
      return createControlError(request.command_id, "INVALID_STATE", `Run cannot be resumed in status: ${run.status}`);
    }

    // Call PiRunService.resume
    try {
      const ref = await this.deps.service.resume(request.run_id, principal);
      const projection = this._buildPublicProjection(this.deps.store.get(request.run_id)!);
      return {
        version: 1,
        command_id: request.command_id,
        outcome: "succeeded",
        projection,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not resumable") || message.includes("session file")) {
        return createControlError(request.command_id, "MISSING_RESUME_CAPABILITY", message);
      }
      if (message.includes("workspace policy")) {
        return createControlError(request.command_id, "SESSION_CONTINUITY_FAILED", message);
      }
      return createControlError(request.command_id, "INTERNAL_ERROR", message);
    }
  }

  /**
   * Record command outcome in the ledger.
   */
  private _recordCommandOutcome(
    originPeer: string,
    commandId: string,
    response: RemotePiControlResponseV1
  ): void {
    const state: CommandLedgerState =
      response.outcome === "succeeded" ? "completed" :
      response.outcome === "rejected" ? "rejected" :
      "outcome_unknown";

    this.deps.store.updateCommand({
      originPeer,
      commandId,
      state,
      responseJson: JSON.stringify(response),
    });
  }

  /**
   * Build a public projection from a run record. Delegates to the shared
   * projection builder so the control response cannot drift from the event
   * producer's projection.
   */
  private _buildPublicProjection(run: PiRunRecord) {
    // Pull the most recent UI request details for awaiting_input so the
    // status response carries title/prompt/options just like the events do.
    const uiRequest = run.pendingRequestId && run.status === "awaiting_input"
      ? this.deps.store.getLatestUiRequest(run.id)
      : null;
    return buildPublicProjection(run, uiRequest);
  }
}