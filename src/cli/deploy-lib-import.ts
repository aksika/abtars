/**
 * Re-export of deploy-lib primitives. Local copy — see abproject/docs/shared-utilities.md
 * for the SHARED/PARAMETERIZED-SHARED classification and abproject/docs/shared-utils.lock
 * for the drift guard hashes.
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
  type AcquireLockOptions,
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
