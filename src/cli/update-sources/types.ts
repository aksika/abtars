/**
 * Update source adapter interface (#785).
 *
 * An UpdateSource produces a StagedRelease: a fully-populated
 * app.staging/ directory containing the bundle, ready for atomic swap.
 */

export type SourceName = 'local' | 'npm' | 'github';

export interface StagedRelease {
  readonly version: string;
  readonly stagedPath: string; // absolute path to app.staging/
  readonly commit: string | null;
  readonly branch: string | null;
  readonly packageLockHash: string | null;
  readonly source: SourceName;
}

export interface UpdateSource {
  readonly name: SourceName;
  /**
   * Produce a StagedRelease on disk at stagingDir. Must be idempotent
   * w.r.t. the caller acquiring a lock first. Must not perform the swap.
   */
  prepare(ctx: PrepareContext): Promise<StagedRelease>;
}

export interface PrepareContext {
  /** Absolute path to app.staging/ (target for build output). */
  readonly stagingDir: string;
  /** Absolute path to the package's home (~/.abtars). */
  readonly home: string;
  /** If true, adapter may skip fetching when source hasn't changed. */
  readonly allowStale: boolean;
}
