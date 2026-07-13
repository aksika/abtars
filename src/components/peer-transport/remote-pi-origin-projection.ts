/**
 * peer-transport/remote-pi-origin-projection.ts — Origin-side projection reducer (#1358).
 *
 * Reduces lifecycle events from the owner peer into a local projection,
 * maintaining cursor, generation, status, and pending input.
 */

import type { RemotePiEventV1, RemotePiPublicProjectionV1, RemotePiEventCursor } from "./remote-pi-types.js";
import { validateEventV1 } from "./remote-pi-types.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { logInfo, logDebug, logTrace, logError } from "../logger.js";

const TAG = "remote-pi-origin-projection";

/**
 * Origin-side remote Pi projection state.
 */
export interface RemotePiOriginProjection {
  run_id: string;
  card_id: number;
  origin_request_id: string;
  owner_peer: string;
  latest_sequence: number;
  acknowledged_sequence: number;
  latest_generation: number;
  latest_status: string;
  last_activity_at: string;
  pending_input?: {
    request_id: string;
    type: "select" | "confirm" | "input" | "editor";
    title?: string;
    prompt?: string;
    options?: Array<{ id: string; label: string }>;
  };
  result_summary?: string;
  error_summary?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  changed_files_summary?: string;
  resume_capability?: string;
  delivery?: {
    policy: "leave_remote" | "patch_artifact" | "commit_push";
    status: "pending" | "succeeded" | "failed" | "not_requested";
    references?: Array<{
      kind: string;
      id: string;
      sha256?: string;
      size?: number;
    }>;
    error?: string;
  };
  last_command_outcome?: {
    command_id: string;
    outcome: "succeeded" | "rejected" | "outcome_unknown";
    at: string;
  };
}

export interface ProjectionStore {
  /** Store or update a projection */
  upsertProjection(projection: RemotePiOriginProjection): void;

  /** Load a projection by run ID */
  getProjection(runId: string): RemotePiOriginProjection | null;

  /** Delete a projection */
  deleteProjection(runId: string): void;

  /** Get all projections for an owner peer */
  getProjectionsByOwner(ownerPeer: string): RemotePiOriginProjection[];
}

/**
 * SQLite-backed projection store.
 */
export class SqliteProjectionStore implements ProjectionStore {
  private readonly db: TaskDatabase;

  constructor(db: TaskDatabase) {
    this.db = db;
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_origin_projections (
      run_id TEXT PRIMARY KEY,
      card_id INTEGER NOT NULL,
      origin_request_id TEXT NOT NULL,
      owner_peer TEXT NOT NULL,
      latest_sequence INTEGER NOT NULL DEFAULT 0,
      acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
      latest_generation INTEGER NOT NULL DEFAULT 1,
      latest_status TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      pending_input_json TEXT,
      result_summary TEXT,
      error_summary TEXT,
      usage_json TEXT,
      changed_files_summary TEXT,
      resume_capability TEXT,
      delivery_json TEXT,
      last_command_outcome_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_projections_owner ON remote_pi_origin_projections(owner_peer)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_projections_card ON remote_pi_origin_projections(card_id)`);
  }

  upsertProjection(projection: RemotePiOriginProjection): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO remote_pi_origin_projections
        (run_id, card_id, origin_request_id, owner_peer, latest_sequence, acknowledged_sequence,
         latest_generation, latest_status, last_activity_at, pending_input_json, result_summary,
         error_summary, usage_json, changed_files_summary, resume_capability, delivery_json,
         last_command_outcome_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      projection.run_id,
      projection.card_id,
      projection.origin_request_id,
      projection.owner_peer,
      projection.latest_sequence,
      projection.acknowledged_sequence,
      projection.latest_generation,
      projection.latest_status,
      projection.last_activity_at,
      projection.pending_input ? JSON.stringify(projection.pending_input) : null,
      projection.result_summary ?? null,
      projection.error_summary ?? null,
      projection.usage ? JSON.stringify(projection.usage) : null,
      projection.changed_files_summary ?? null,
      projection.resume_capability ?? null,
      projection.delivery ? JSON.stringify(projection.delivery) : null,
      projection.last_command_outcome ? JSON.stringify(projection.last_command_outcome) : null,
    );
  }

  getProjection(runId: string): RemotePiOriginProjection | null {
    const row = this.db.prepare(`SELECT * FROM remote_pi_origin_projections WHERE run_id = ?`).get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this._rowToProjection(row);
  }

  deleteProjection(runId: string): void {
    this.db.prepare(`DELETE FROM remote_pi_origin_projections WHERE run_id = ?`).run(runId);
  }

  getProjectionsByOwner(ownerPeer: string): RemotePiOriginProjection[] {
    return (this.db.prepare(`SELECT * FROM remote_pi_origin_projections WHERE owner_peer = ? ORDER BY last_activity_at DESC`).all(ownerPeer) as Record<string, unknown>[])
      .map(r => this._rowToProjection(r));
  }

  private _rowToProjection(row: Record<string, unknown>): RemotePiOriginProjection {
    return {
      run_id: row.run_id as string,
      card_id: row.card_id as number,
      origin_request_id: row.origin_request_id as string,
      owner_peer: row.owner_peer as string,
      latest_sequence: row.latest_sequence as number,
      acknowledged_sequence: row.acknowledged_sequence as number,
      latest_generation: row.latest_generation as number,
      latest_status: row.latest_status as string,
      last_activity_at: row.last_activity_at as string,
      pending_input: row.pending_input_json ? JSON.parse(row.pending_input_json as string) : undefined,
      result_summary: row.result_summary as string | undefined,
      error_summary: row.error_summary as string | undefined,
      usage: row.usage_json ? JSON.parse(row.usage_json as string) : undefined,
      changed_files_summary: row.changed_files_summary as string | undefined,
      resume_capability: row.resume_capability as string | undefined,
      delivery: row.delivery_json ? JSON.parse(row.delivery_json as string) : undefined,
      last_command_outcome: row.last_command_outcome_json ? JSON.parse(row.last_command_outcome_json as string) : undefined,
    };
  }
}

/**
 * Origin-side projection reducer.
 */
export class RemotePiOriginReducer {
  private readonly store: ProjectionStore;
  private readonly listeners = new Map<string, Array<(projection: RemotePiOriginProjection) => void>>();

  constructor(store: ProjectionStore) {
    this.store = store;
  }

  /**
   * Reduce an event into the projection.
   * Returns true if the projection changed, false if rejected/idempotent.
   */
  reduce(event: RemotePiEventV1): boolean {
    // Validate event
    validateEventV1(event);

    // Load existing projection
    let projection = this.store.getProjection(event.run_id);

    // Initialize projection for first event
    if (!projection) {
      if (event.sequence !== 1) {
        logError(TAG, `First event for run ${event.run_id} has sequence ${event.sequence}, expected 1`);
        return false;
      }
      projection = this._initializeProjection(event);
    }

    // Validate monotonic sequence
    if (event.sequence <= projection.latest_sequence) {
      logTrace(TAG, `Ignoring stale event ${event.event_id} (seq ${event.sequence} <= ${projection.latest_sequence})`);
      return false;
    }

    // Check for gaps
    if (event.sequence > projection.latest_sequence + 1) {
      logDebug(TAG, `Gap detected for run ${event.run_id}: have ${projection.latest_sequence}, got ${event.sequence}`);
      // Don't reject - allow later catch-up to fill gaps
    }

    // Validate monotonic generation
    if (event.generation < projection.latest_generation) {
      logError(TAG, `Event generation regression for run ${event.run_id}: ${event.generation} < ${projection.latest_generation}`);
      return false;
    }

    // Don't regress terminal state
    const terminalKinds = ["completed", "failed", "cancelled"];
    if (terminalKinds.includes(projection.latest_status) && !terminalKinds.includes(event.kind)) {
      logDebug(TAG, `Ignoring non-terminal event for already-terminal run ${event.run_id}`);
      return false;
    }

    // Apply projection from event
    const updated = this._applyProjection(projection, event);

    // Store updated projection
    this.store.upsertProjection(updated);

    // Notify listeners
    this._notifyListeners(event.run_id, updated);

    logTrace(TAG, `Reduced event ${event.event_id} for run ${event.run_id}, now at seq ${updated.latest_sequence}`);

    return true;
  }

  /**
   * Get the current projection for a run.
   */
  getProjection(runId: string): RemotePiOriginProjection | null {
    return this.store.getProjection(runId);
  }

  /**
   * Get the cursor for a run.
   */
  getCursor(runId: string): RemotePiEventCursor | null {
    const projection = this.store.getProjection(runId);
    if (!projection) return null;
    return { run_id: runId, sequence: projection.acknowledged_sequence };
  }

  /**
   * Get all projections for an owner peer.
   */
  getProjectionsByOwner(ownerPeer: string): RemotePiOriginProjection[] {
    return this.store.getProjectionsByOwner(ownerPeer);
  }

  /**
   * Update the acknowledged cursor for a run.
   */
  acknowledgeCursor(runId: string, sequence: number): boolean {
    const projection = this.store.getProjection(runId);
    if (!projection) return false;

    if (sequence > projection.latest_sequence) {
      logError(TAG, `Cannot acknowledge sequence ${sequence} beyond latest ${projection.latest_sequence} for run ${runId}`);
      return false;
    }

    if (sequence <= projection.acknowledged_sequence) {
      return false; // No change
    }

    const updated = { ...projection, acknowledged_sequence: sequence, updated_at: new Date().toISOString() } as any;
    this.store.upsertProjection(updated);
    return true;
  }

  /**
   * Record a command outcome for a run.
   */
  recordCommandOutcome(runId: string, commandId: string, outcome: "succeeded" | "rejected" | "outcome_unknown"): void {
    const projection = this.store.getProjection(runId);
    if (!projection) {
      logError(TAG, `Cannot record command outcome for unknown run ${runId}`);
      return;
    }

    const updated = {
      ...projection,
      last_command_outcome: {
        command_id: commandId,
        outcome,
        at: new Date().toISOString(),
      },
    };
    this.store.upsertProjection(updated);
    this._notifyListeners(runId, updated);
  }

  /**
   * Subscribe to projection changes for a run.
   */
  subscribe(runId: string, listener: (projection: RemotePiOriginProjection) => void): () => void {
    if (!this.listeners.has(runId)) {
      this.listeners.set(runId, []);
    }
    this.listeners.get(runId)!.push(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(runId);
      if (listeners) {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      }
    };
  }

  /**
   * Initialize a new projection from the first event.
   */
  private _initializeProjection(event: RemotePiEventV1): RemotePiOriginProjection {
    return {
      run_id: event.run_id,
      card_id: event.card_id,
      origin_request_id: event.origin_request_id,
      owner_peer: event.origin_peer,
      latest_sequence: event.sequence,
      acknowledged_sequence: 0,
      latest_generation: event.generation,
      latest_status: event.projection.status,
      last_activity_at: event.occurred_at,
      pending_input: event.projection.pending_input,
      result_summary: event.projection.result_summary,
      error_summary: event.projection.error_summary,
      usage: event.projection.usage,
      changed_files_summary: event.projection.changed_files_summary,
      resume_capability: event.projection.resume_capability,
      delivery: event.projection.delivery,
    };
  }

  /**
   * Apply a projection from an event to an existing projection.
   */
  private _applyProjection(
    existing: RemotePiOriginProjection,
    event: RemotePiEventV1
  ): RemotePiOriginProjection {
    const updated: RemotePiOriginProjection = {
      ...existing,
      latest_sequence: event.sequence,
      latest_generation: event.generation,
      latest_status: event.projection.status,
      last_activity_at: event.occurred_at,
    };

    // Update pending input (clear if event kind clears it)
    if (event.kind === "input_cleared") {
      updated.pending_input = undefined;
    } else if (event.projection.pending_input) {
      updated.pending_input = event.projection.pending_input;
    }

    // Update terminal fields
    if (event.projection.result_summary !== undefined) {
      updated.result_summary = event.projection.result_summary;
    }
    if (event.projection.error_summary !== undefined) {
      updated.error_summary = event.projection.error_summary;
    }
    if (event.projection.usage !== undefined) {
      updated.usage = event.projection.usage;
    }
    if (event.projection.changed_files_summary !== undefined) {
      updated.changed_files_summary = event.projection.changed_files_summary;
    }
    if (event.projection.resume_capability !== undefined) {
      updated.resume_capability = event.projection.resume_capability;
    }
    if (event.projection.delivery !== undefined) {
      updated.delivery = event.projection.delivery;
    }

    return updated;
  }

  /**
   * Notify listeners of a projection change.
   */
  private _notifyListeners(runId: string, projection: RemotePiOriginProjection): void {
    const listeners = this.listeners.get(runId) || [];
    for (const listener of listeners) {
      try {
        listener(projection);
      } catch (err) {
        logError(TAG, `Projection listener error for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Delete a projection (for cleanup).
   */
  deleteProjection(runId: string): void {
    this.store.deleteProjection(runId);
    this.listeners.delete(runId);
    logDebug(TAG, `Deleted projection for run ${runId}`);
  }
}