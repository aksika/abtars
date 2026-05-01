/**
 * Re-export of abmind's deploy-lib primitives, so command files can import
 * from a single stable path inside agentbridge. If we ever decide to vendor
 * or fork deploy-lib, only this file changes.
 *
 * All imports go through abmind's "./deploy-lib" subpath export (#355).
 */

export {
  packagePaths,
  resolveBridgeHome,
  resolveAbmindHome,
  resolveUserBinDir,
  type PackagePaths,
  readManifest,
  writeManifest,
  emptyManifest,
  type Manifest,
  type PriorRelease,
  acquireLock,
  inspectLock,
  LockHeldError,
  type LockContent,
  activate,
  hashFile,
  listReleases,
  pruneReleases,
  readCurrent,
  releaseExists,
  RETENTION,
  type StagedRelease as StagedReleaseRecord,
  isUnsafeRemovalTarget,
  planRemoval,
  removePath,
  type RemovePlan,
  safeCopyTree,
} from 'abmind/deploy-lib';
