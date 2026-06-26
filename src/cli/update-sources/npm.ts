/**
 * NpmSource: fetch latest published version directly from npm registry (#1176).
 * Pure HTTP fetch — no npm/pnpm CLI dependency.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveVersion, downloadTarball } from "./registry-client.js";
import type { PrepareContext, StagedRelease, UpdateSource } from "./types.js";

const TAR_TIMEOUT_MS = 60_000;

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: TAR_TIMEOUT_MS });
  if (r.error) throw new Error(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${r.stderr?.trim()}`);
  return r.stdout.trim();
}

function readLocalVersion(home: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(home, "app", "package.json"), "utf-8"));
    return pkg.version ?? null;
  } catch { return null; }
}

export function makeNpmSource(packageName: string, tag?: string): UpdateSource {
  const distTag = tag ?? "latest";
  const sourceName = distTag === "alpha" ? "alpha" : "stable";
  return {
    name: sourceName,
    async prepare(ctx: PrepareContext): Promise<StagedRelease> {
      const { version, tarballUrl } = await resolveVersion(packageName, distTag);
      const current = readLocalVersion(ctx.home);
      if (version === current) {
        throw new Error(`Already at ${distTag} version (${version}). Nothing to update.`);
      }

      const stagedPath = ctx.stagingDir;
      await rm(stagedPath, { recursive: true, force: true });
      await mkdir(stagedPath, { recursive: true });

      // Download tarball directly from registry
      const tgzPath = join(stagedPath, `${packageName.replace("/", "-")}-${version}.tgz`);
      await downloadTarball(tarballUrl, tgzPath);

      // Extract (strip package/ prefix)
      run("tar", ["-xzf", tgzPath, "--strip-components=1"], stagedPath);

      // Cleanup tarball
      if (existsSync(tgzPath)) unlinkSync(tgzPath);

      // No dep install — native deps handled by #1191 (manifest-driven copy from deps/ dir)

      return { version, stagedPath, commit: null, branch: null, packageLockHash: null, source: sourceName };
    },
  };
}
