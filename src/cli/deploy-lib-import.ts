/**
 * Re-export of abmind's deploy-lib primitives, so command files can import
 * from a single stable path inside agentbridge. If we ever decide to vendor
 * or fork deploy-lib, only this file changes.
 */

export {
  packagePaths,
  resolveBridgeHome,
  resolveAbmindHome,
  resolveUserBinDir,
  type PackagePaths,
} from 'abmind/deploy-lib/paths.js';

export {
  readManifest,
  writeManifest,
  emptyManifest,
  type Manifest,
  type PriorRelease,
} from 'abmind/deploy-lib/manifest.js';

export {
  acquireLock,
  inspectLock,
  LockHeldError,
  type LockContent,
} from 'abmind/deploy-lib/lock.js';

export {
  activate,
  hashFile,
  listReleases,
  pruneReleases,
  readCurrent,
  releaseExists,
  RETENTION,
  type StagedRelease as StagedReleaseRecord,
} from 'abmind/deploy-lib/releases.js';

export {
  isUnsafeRemovalTarget,
  planRemoval,
  removePath,
  type RemovePlan,
} from 'abmind/deploy-lib/cleanup.js';

export { safeCopyTree } from 'abmind/deploy-lib/safe-copy.js';
