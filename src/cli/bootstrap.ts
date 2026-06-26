/**
 * bootstrap.ts (#1237) — the STABLE, old-code surface of `abtars update`.
 *
 * Role: OBTAIN fresh code only (fail-safe — nothing is swapped here), then hand
 * off to the freshly-staged `__deploy` which performs activation. A bug in
 * activation is self-healing: the next update fetches the fixed __deploy and
 * runs it. Only this file (obtain) runs as old code, and its failure mode is
 * safe-abort (the running release keeps serving).
 *
 * Keep this minimal: reuse the existing obtain primitives (syncSrcRepos +
 * UpdateSource.prepare + copyAbmind). No imports from components/*, no business
 * logic, no activation logic.
 */
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanStaleStaging, packagePaths } from "./deploy-lib/index.js";
import { syncSrcRepos, ensureAbmindBuilt, copyAbmind } from "./deploy-lib/deploy.js";
import { makeLocalBuildSource } from "./update-sources/dev.js";
import { makeNpmSource } from "./update-sources/npm.js";
import type { SourceName, StagedRelease } from "./update-sources/types.js";

export interface BootstrapOptions {
  readonly channel: SourceName;
}

export async function bootstrap(opts: BootstrapOptions): Promise<number> {
  const { channel } = opts;
  const paths = packagePaths("abtars");
  const srcDir = join(paths.releasesDir, "src");
  const repoRoot = join(srcDir, "abtars");

  // ── Obtain (fail-safe) ─────────────────────────────────────────────
  cleanStaleStaging(paths.appStaging);
  let staged: StagedRelease;
  if (channel === "dev") {
    try { syncSrcRepos(srcDir, ["abtars", "abmind"]); } catch { return 1; }
    ensureAbmindBuilt(join(srcDir, "abmind"));
    const source = makeLocalBuildSource({ repoRoot, allowStale: true });
    staged = await source.prepare({ stagingDir: paths.appStaging, home: paths.home, allowStale: true });
  } else {
    const source = makeNpmSource("abtars", channel === "alpha" ? "alpha" : "latest");
    staged = await source.prepare({ stagingDir: paths.appStaging, home: paths.home, allowStale: true });
  }
  process.stdout.write(`✓ obtained ${staged.version}\n`);

  // abmind seam: acquire into the staged release here (dev: from the synced
  // src/abmind; alpha/stable: registry tarball). __deploy never touches abmind.
  await copyAbmind(staged.stagedPath, repoRoot);

  // ── Hand off to FRESH __deploy (runs the just-staged bundle) ───────
  // Detach (when needed) is the caller's concern: the /update bridge handler
  // already spawns this whole invocation detached+unref. So we run __deploy
  // synchronously and return its exit code; a terminal user sees the result.
  const freshCli = join(staged.stagedPath, "bundle", "abtars-cli.js");
  const args = [
    freshCli, "__deploy",
    "--staged", staged.stagedPath,
    "--version", staged.version,
    "--channel", channel,
    "--repo-root", repoRoot,
  ];
  if (staged.commit) args.push("--commit", staged.commit);
  if (staged.branch) args.push("--branch", staged.branch);
  if (staged.packageLockHash) args.push("--package-lock-hash", staged.packageLockHash);

  const r = spawnSync("node", args, { stdio: "inherit" });
  return r.status ?? 1;
}
