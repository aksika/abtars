/**
 * Re-export of deploy-lib primitives. Local copy — synchronized with abmind's
 * deploy-lib manually. See abproject/docs/shared-utilities.md.
 */

export {
  packagePaths,
  resolveAbtarsHome,
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
} from './deploy-lib/index.js';
