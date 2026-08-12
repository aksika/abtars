/**
 * pi-workspace-claim-store.ts — #1635 raw shared canonical-workspace claim.
 *
 * Extracted from PiRunStore.claimWorkspaceForStartInTx: the idempotent
 * primary-key claim and exact-generation release only. Existing standalone and
 * supervised lanes keep their run validation, status transitions, and card
 * behavior around these primitives; interactive sessions acquire and release
 * the same claim with owner_kind 'interactive'.
 */

import type { TaskDatabase } from "../tasks/kanban-board.js";

export type PiClaimOwnerKind = "standalone" | "supervised" | "interactive";

export type PiRawClaimResult =
  | { kind: "claimed" }
  | { kind: "idempotent" }
  | { kind: "busy"; holderOwnerId: string };

export type PiRawReleaseResult =
  | { released: true; canonicalPath: string }
  | { released: false; reason: "missing" | "not_holder" };

export interface PiWorkspaceClaimRow {
  canonicalPath: string;
  ownerId: string;
  generation: number;
  ownerKind: PiClaimOwnerKind;
}

export class PiWorkspaceClaimStore {
  private readonly db: TaskDatabase;

  constructor(db: TaskDatabase) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    const existing = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pi_workspace_claims'`
    ).get() as { sql?: string } | undefined;
    if (existing?.sql && !existing.sql.includes("'interactive'")) {
      // #1635 — the current CHECK permits only standalone|supervised; an
      // additive ALTER cannot change an enum domain. Atomic, data-preserving
      // rebuild: create → copy → drop → rename inside one transaction.
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE pi_workspace_claims_v2 (
          canonical_path TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          execution_generation INTEGER NOT NULL,
          owner_kind TEXT NOT NULL CHECK(owner_kind IN ('standalone','supervised','interactive')),
          acquired_at TEXT NOT NULL,
          UNIQUE(run_id, execution_generation)
        )`);
        this.db.exec(`INSERT INTO pi_workspace_claims_v2 (canonical_path, run_id, execution_generation, owner_kind, acquired_at)
          SELECT canonical_path, run_id, execution_generation, owner_kind, acquired_at FROM pi_workspace_claims`);
        this.db.exec(`DROP TABLE pi_workspace_claims`);
        this.db.exec(`ALTER TABLE pi_workspace_claims_v2 RENAME TO pi_workspace_claims`);
      });
      return;
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS pi_workspace_claims (
      canonical_path TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      execution_generation INTEGER NOT NULL,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('standalone','supervised','interactive')),
      acquired_at TEXT NOT NULL,
      UNIQUE(run_id, execution_generation)
    )`);
  }

  /**
   * #1635 — Idempotent primary-key claim, intended to run INSIDE the caller's
   * transaction (never opens its own). The exact same (ownerId, generation)
   * holder is idempotent; any other holder on the canonical path is busy.
   */
  tryAcquireInTx(input: {
    canonicalPath: string;
    ownerId: string;
    generation: number;
    ownerKind: PiClaimOwnerKind;
  }): PiRawClaimResult {
    const exactHolder = this.db.prepare(`
      SELECT run_id FROM pi_workspace_claims
      WHERE canonical_path = ? AND run_id = ? AND execution_generation = ?
    `).get(input.canonicalPath, input.ownerId, input.generation) as { run_id: string } | undefined;
    if (exactHolder) return { kind: "idempotent" };

    try {
      this.db.prepare(`
        INSERT INTO pi_workspace_claims (canonical_path, run_id, execution_generation, owner_kind, acquired_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(input.canonicalPath, input.ownerId, input.generation, input.ownerKind);
    } catch {
      const holder = this.db.prepare(`
        SELECT run_id FROM pi_workspace_claims WHERE canonical_path = ?
      `).get(input.canonicalPath) as { run_id: string } | undefined;
      if (holder && holder.run_id === input.ownerId) return { kind: "idempotent" };
      return { kind: "busy", holderOwnerId: holder?.run_id ?? "unknown" };
    }
    return { kind: "claimed" };
  }

  /**
   * #1635 — Exact (canonical_path, ownerId, generation) release. A late
   * generation can never free a newer holder. Safe to repeat.
   */
  releaseExact(input: {
    canonicalPath: string;
    ownerId: string;
    generation: number;
  }): PiRawReleaseResult {
    const result = this.db.prepare(`
      DELETE FROM pi_workspace_claims
      WHERE canonical_path = ? AND run_id = ? AND execution_generation = ?
    `).run(input.canonicalPath, input.ownerId, input.generation);
    if (result.changes === 0) {
      const anyHolder = this.db.prepare(`
        SELECT run_id FROM pi_workspace_claims WHERE canonical_path = ?
      `).get(input.canonicalPath) as { run_id: string } | undefined;
      return { released: false, reason: anyHolder ? "not_holder" : "missing" };
    }
    return { released: true, canonicalPath: input.canonicalPath };
  }

  /** Generation-fenced release by owner identity — usable when the canonical
   * path can no longer be resolved. Exact fence: never frees a newer holder. */
  releaseForGeneration(input: { ownerId: string; generation: number }): boolean {
    const result = this.db.prepare(`
      DELETE FROM pi_workspace_claims WHERE run_id = ? AND execution_generation = ?
    `).run(input.ownerId, input.generation);
    return result.changes === 1;
  }

  /** List every currently held claim. */
  list(): PiWorkspaceClaimRow[] {
    return (this.db.prepare(`
      SELECT canonical_path, run_id, execution_generation, owner_kind FROM pi_workspace_claims
    `).all() as Array<{
      canonical_path: string; run_id: string; execution_generation: number; owner_kind: PiClaimOwnerKind;
    }>).map(r => ({
      canonicalPath: r.canonical_path,
      ownerId: r.run_id,
      generation: r.execution_generation,
      ownerKind: r.owner_kind,
    }));
  }
}
