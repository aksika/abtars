/**
 * Update source adapter interface (#158 Phase 1).
 *
 * An UpdateSource produces a StagedRelease: a fully-populated
 * releases/<version>/ directory containing dist/, ready to activate.
 *
 * Phase 1 ships only LocalBuildSource. Phase 5 (post-#155 npm publish)
 * will add NpmSource. The command layer dispatches on --source flag.
 */

export type SourceName = 'local' | 'npm' | 'github';

export interface StagedRelease {
  readonly version: string;
  readonly stagedPath: string; // absolute path to releases/<version>/
  readonly commit: string | null;
  readonly branch: string | null;
  readonly packageLockHash: string | null;
  readonly source: SourceName;
}

export interface UpdateSource {
  readonly name: SourceName;
  /**
   * Produce a StagedRelease on disk under releasesDir. Must be idempotent
   * w.r.t. the caller acquiring a lock first. Must not flip `current`.
   */
  prepare(ctx: PrepareContext): Promise<StagedRelease>;
}

export interface PrepareContext {
  /** Absolute path to the package's releases/ dir. */
  readonly releasesDir: string;
  /** Absolute path to the shared node_modules/. */
  readonly nodeModulesDir: string;
  /** Absolute path to the package's home (parent of releases/). */
  readonly home: string;
  /** If true, adapter may skip fetching/building when source hasn't changed. */
  readonly allowStale: boolean;
}
