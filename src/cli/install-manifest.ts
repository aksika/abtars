/**
 * install-manifest.ts — Load and validate install-manifest.json.
 * Single source of truth for install-time requirements.
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { logWarn } from "../components/logger.js";

const TAG = "manifest";
const SUPPORTED_VERSION = 2;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManifestDirectory {
  path: string;
  mode?: string;
}

export interface ManifestConfigSeed {
  source: string;
  dest: string;
  mode?: string;
}

export interface ManifestRequiredConfig {
  path: string;
  remediation: string;
}

export interface ManifestScripts {
  include: string[];
  executable: string;
}

export interface ManifestServices {
  supervised: {
    macos?: { plist: string; placeholders: string[] };
    linux?: { units: string[] };
  };
}


export interface InstallManifest {
  manifestVersion: number;
  directories: ManifestDirectory[];
  lazyRoots: string[];
  configSeeds: ManifestConfigSeed[];
  requiredConfigs: ManifestRequiredConfig[];
  scripts: ManifestScripts;
  services: ManifestServices;
  cliWrappers: string[];
}

// ── Loader ──────────────────────────────────────────────────────────────────

let cached: InstallManifest | null = null;

export function loadManifest(repoRoot?: string): InstallManifest {
  if (cached) return cached;
  const root = repoRoot ?? process.cwd();
  const p = join(root, "install-manifest.json");
  let raw: InstallManifest;
  try { raw = JSON.parse(readFileSync(p, "utf-8")) as InstallManifest; }
  catch (err) { throw new Error(`Invalid JSON in install-manifest.json: ${err instanceof Error ? err.message : String(err)}`); }
  if (raw.manifestVersion > SUPPORTED_VERSION) {
    logWarn(TAG, `manifest version ${raw.manifestVersion} > supported ${SUPPORTED_VERSION} — some features may not be applied`);
  }
  cached = raw;
  return raw;
}

/** Clear cache (for tests). */
export function _resetManifestCache(): void { cached = null; }

/** Check if a path is under a declared lazyRoot. */
export function isLazyRootAllowed(manifest: InstallManifest, relPath: string): boolean {
  return manifest.lazyRoots.some(root => relPath === root || relPath.startsWith(root + "/"));
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export interface ReconcileResult {
  ok: string[];
  fixed: string[];
  warnings: string[];
}

/**
 * Reconcile install state against manifest. If fix=true, creates missing dirs
 * and seeds missing configs. Returns a report.
 */
export function reconcileManifest(
  manifest: InstallManifest,
  home: string,
  repoRoot: string,
  fix: boolean,
): ReconcileResult {
  const ok: string[] = [];
  const fixed: string[] = [];
  const warnings: string[] = [];

  // Eager directories
  for (const dir of manifest.directories) {
    const abs = join(home, dir.path);
    if (existsSync(abs)) {
      if (dir.mode) {
        const actual = (statSync(abs).mode & 0o777).toString(8);
        const expected = dir.mode.replace(/^0/, "");
        if (actual !== expected) {
          if (fix) {
            chmodSync(abs, parseInt(dir.mode, 8));
            fixed.push(`${dir.path}/ permissions ${actual} → ${expected}`);
          } else {
            warnings.push(`${dir.path}/ permissions ${actual}, expected ${expected}`);
          }
        } else {
          ok.push(`${dir.path}/`);
        }
      } else {
        ok.push(`${dir.path}/`);
      }
    } else if (fix) {
      mkdirSync(abs, { recursive: true, mode: dir.mode ? parseInt(dir.mode, 8) : undefined });
      fixed.push(`created ${dir.path}/`);
    } else {
      warnings.push(`${dir.path}/ MISSING`);
    }
  }

  // Config seeds
  for (const seed of manifest.configSeeds) {
    const dest = join(home, seed.dest);
    if (existsSync(dest)) {
      ok.push(seed.dest);
    } else {
      const src = join(repoRoot, seed.source);
      if (fix && existsSync(src)) {
        mkdirSync(join(home, seed.dest, ".."), { recursive: true });
        copyFileSync(src, dest);
        if (seed.mode) chmodSync(dest, parseInt(seed.mode, 8));
        fixed.push(`seeded ${seed.dest} from ${seed.source}`);
      } else if (!existsSync(src)) {
        warnings.push(`${seed.dest} MISSING (source ${seed.source} not found)`);
      } else {
        warnings.push(`${seed.dest} MISSING (seed from ${seed.source})`);
      }
    }
  }

  // Required configs (report only, never auto-fix)
  for (const req of manifest.requiredConfigs) {
    const abs = join(home, req.path);
    if (existsSync(abs)) {
      ok.push(req.path);
    } else {
      warnings.push(`${req.path} MISSING — ${req.remediation}`);
    }
  }

  return { ok, fixed, warnings };
}
