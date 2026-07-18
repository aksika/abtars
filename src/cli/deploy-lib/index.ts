/**
 * Deploy-lib: shared install/update/rollback primitives.
 *
 * Consumed locally by abtars CLI commands. Mirrors the abmind deploy-lib
 * protocol for #1388 shared native-dependency management.
 *
 * Entry points are the module files directly:
 *   import { resolveAbtarsHome } from './paths.js'
 *   import { readManifest, writeManifest } from './manifest.js'
 *   etc.
 *
 * See abproject/docs/plans/158-deploy-rewrite.md for the full contract.
 */

export * from './paths.js';
export * from './manifest.js';
export * from './lock.js';
export * from './releases.js';
export * from './cleanup.js';
export * from './safe-copy.js';
