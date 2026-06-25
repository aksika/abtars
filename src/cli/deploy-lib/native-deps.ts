/**
 * native-deps.ts — Manifest-driven native dependency deployment.
 *
 * Compares source versions (from repo node_modules) against manifest,
 * runs `npm install <dep>@<ver>` only when a version changes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { Manifest } from "./manifest.js";

const NATIVE_DEPS = ["better-sqlite3"];

export function syncNativeDeps(
  repoRoot: string,
  depsDir: string,
  manifest: Manifest,
): string[] {
  const updated: string[] = [];

  for (const dep of NATIVE_DEPS) {
    const srcPkg = join(repoRoot, "node_modules", dep, "package.json");
    if (!existsSync(srcPkg)) continue;

    const srcVer = JSON.parse(readFileSync(srcPkg, "utf-8")).version as string;
    const deployedVer = manifest.nativeDeps?.[dep] ?? null;
    if (srcVer === deployedVer) continue;

    mkdirSync(depsDir, { recursive: true });
    if (!existsSync(join(depsDir, "package.json"))) {
      writeFileSync(join(depsDir, "package.json"), '{"private":true}\n');
    }

    execSync(`npm install ${dep}@${srcVer} --no-audit --no-fund --loglevel=error`, {
      cwd: depsDir, stdio: "pipe", timeout: 120_000,
    });

    (manifest as any).nativeDeps = { ...manifest.nativeDeps, [dep]: srcVer };
    updated.push(`${dep}@${srcVer}`);
  }

  return updated;
}
