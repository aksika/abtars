/**
 * NpmSource: fetch latest published version from npm registry (#462).
 * Downloads tarball, extracts, installs prod deps, stages.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PrepareContext, StagedRelease, UpdateSource } from "./types.js";

const TIMEOUT_MS = 60_000;

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: TIMEOUT_MS });
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
      // --force: workaround for pnpm dist-tag cache bug (#1147). Remove when pnpm fixes.
      const latest = run("npm", ["view", `${packageName}@${distTag}`, "version"], ctx.home);
      const current = readLocalVersion(ctx.home);
      if (latest === current) {
        throw new Error(`Already at ${distTag} version (${latest}). Nothing to update.`);
      }

      const stagedPath = ctx.stagingDir;
      await rm(stagedPath, { recursive: true, force: true });
      await mkdir(stagedPath, { recursive: true });

      // Download tarball
      run("npm", ["pack", `${packageName}@${latest}`, "--pack-destination", stagedPath], stagedPath);
      const tgzName = `${packageName}-${latest}.tgz`.replace("@", "").replace("/", "-");
      const tgzPath = join(stagedPath, tgzName);

      // Extract (strip package/ prefix)
      run("tar", ["-xzf", tgzPath, "--strip-components=1"], stagedPath);

      // Cleanup tarball
      if (existsSync(tgzPath)) unlinkSync(tgzPath);

      // Install production deps
      run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], stagedPath);

      return { version: latest, stagedPath, commit: null, branch: null, packageLockHash: null, source: sourceName };
    },
  };
}
