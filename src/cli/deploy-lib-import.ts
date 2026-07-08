/**
 * Re-export of deploy-lib primitives. Local copy — synchronized with abmind's
 * deploy-lib manually. See abproject/docs/shared-utilities.md.
 */

export {
  packagePaths,
  resolveAbtarsHome,
  resolveAbmindHome,
  resolveReleasesDir,
  resolveUserBinDir,
  type PackagePaths,
  readManifest,
  writeManifest,
  emptyManifest,
  type Manifest,
  acquireLock,
  inspectLock,
  LockHeldError,
  type LockContent,
  atomicSwap,
  configSnapshot,
  healthProbe,
  hashFile,
  cleanStaleStaging,
  writeSentinel,
  readSentinel,
  clearSentinel,
  type UpdateSentinel,
  isUnsafeRemovalTarget,
  planRemoval,
  removePath,
  type RemovePlan,
  safeCopyTree,
} from './deploy-lib/index.js';
