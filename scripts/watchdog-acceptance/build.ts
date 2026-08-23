/**
 * Temporary build and timing adapter (#1712 Phase 0).
 *
 * Everything here is produced inside a temporary artifacts directory:
 * - the real watchdog script, copied and transformed with count-checked
 *   timing replacements per named profile;
 * - the real supervisor-state CLI, freshly bundled from current source with
 *   an esbuild onLoad plugin that applies the profile's state transforms;
 * - the fixture bridge bundle, which imports the production bridge-lock
 *   modules;
 * - the real doctor CLI bundle for B5's cross-home boundary.
 *
 * The repository tree and any checked-in bundle/ output are never modified.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
import type { SourceTransform, TimingProfile } from "./contracts.ts";

export class TransformMismatchError extends Error {
  constructor(target: string, find: string, expected: number, actual: number) {
    super(
      `transform mismatch on ${target}: pattern ${JSON.stringify(find)} matched ${actual} time(s), expected exactly ${expected}. ` +
        `Source drift must abort setup instead of silently testing the wrong script.`,
    );
    this.name = "TransformMismatchError";
  }
}

export interface ProfileValues {
  readonly staleS: number;
  readonly pollS: number;
  readonly pollIntervalS: number;
  readonly bootGraceS: number;
  readonly healthAccountS: number;
  readonly backoffMs: readonly [number, number, number, number, number, number];
}

const PROFILES: Record<string, ProfileValues> = {
  // Ordinary compressed lifecycle: fast enough to observe several deaths and
  // respawns inside seconds without being so tight that scheduling noise flips
  // outcomes.
  lifecycle: { staleS: 8, pollS: 2, pollIntervalS: 0.3, bootGraceS: 3, healthAccountS: 2, backoffMs: [0, 400, 700, 1000, 1300, 1600] },
  staleFast: { staleS: 3, pollS: 2, pollIntervalS: 0.3, bootGraceS: 1, healthAccountS: 2, backoffMs: [0, 400, 700, 1000, 1300, 1600] },
  suspendFast: { staleS: 8, pollS: 2, pollIntervalS: 0.2, bootGraceS: 2, healthAccountS: 2, backoffMs: [0, 400, 700, 1000, 1300, 1600] },
  decayFast: { staleS: 6, pollS: 2, pollIntervalS: 0.3, bootGraceS: 2, healthAccountS: 1, backoffMs: [0, 300, 500, 800, 1100, 1400] },
  crashLoopFast: { staleS: 5, pollS: 1, pollIntervalS: 0.2, bootGraceS: 1, healthAccountS: 2, backoffMs: [0, 120, 120, 120, 120, 120] },
};

export const PROFILE_NAMES = Object.keys(PROFILES) as string[];

/** Compressed constant values for one profile (scenarios derive deadlines from these). */
export function getProfileValues(name: string): ProfileValues {
  const v = PROFILES[name];
  if (!v) throw new Error(`unknown timing profile '${name}' (have: ${PROFILE_NAMES.join(", ")})`);
  return v;
}

export function getProfile(name: string): TimingProfile {
  const v = getProfileValues(name);
  return { name, transforms: [...watchdogTransforms(v), ...stateTransforms(v)] };
}

/**
 * Watchdog script constants. Each `find` string is anchored to the exact
 * production source line; a count other than the declared expectation aborts.
 */
function watchdogTransforms(v: ProfileValues): SourceTransform[] {
  return [
    { target: "watchdog", find: "STALE=300", replace: `STALE=${v.staleS}`, expectedCount: 1 },
    { target: "watchdog", find: "POLL=60 ", replace: `POLL=${v.pollS} `, expectedCount: 1 },
    { target: "watchdog", find: "POLL_INTERVAL=5", replace: `POLL_INTERVAL=${v.pollIntervalS}`, expectedCount: 1 },
    { target: "watchdog", find: "SPAWNED_AT < 180", replace: `SPAWNED_AT < ${v.bootGraceS}`, expectedCount: 1 },
    {
      target: "watchdog",
      find: "LAST_HEALTH_ACCOUNT:-0} >= 60",
      replace: `LAST_HEALTH_ACCOUNT:-0} >= ${v.healthAccountS}`,
      expectedCount: 1,
    },
  ];
}

/** supervisor-state bundle inputs (backoff table in src/supervisor/state.ts). */
function stateTransforms(v: ProfileValues): SourceTransform[] {
  return [
    {
      target: "supervisor-state",
      find: "[0, 2000, 5000, 15000, 30000, 60000]",
      replace: `[${v.backoffMs.join(", ")}]`,
      expectedCount: 1,
    },
  ];
}

export function applyTransforms(source: string, transforms: readonly SourceTransform[], targetLabel: string): string {
  let out = source;
  for (const t of transforms) {
    if (t.target !== targetLabel) continue;
    const actual = out.split(t.find).length - 1;
    if (actual !== t.expectedCount) {
      throw new TransformMismatchError(targetLabel, t.find, t.expectedCount, actual);
    }
    out = out.split(t.find).join(t.replace);
  }
  return out;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface BuildEvidence {
  commit: string;
  nodeVersion: string;
  platform: string;
  sources: Record<string, string>;
  artifacts: Record<string, string>;
}

export class SuiteBuilder {
  private readonly evidence: BuildEvidence;
  private readonly watchdogCache = new Map<string, string>();
  private readonly supervisorStatePaths = new Map<string, string>();
  private fixtureBridgePath: string | null = null;
  private doctorCliPath: string | null = null;
  private prebuildDone = false;
  private prepared = false;

  constructor(
    private readonly repoRoot: string,
    private readonly artifactsRoot: string,
  ) {
    this.evidence = {
      commit: "",
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      sources: {},
      artifacts: {},
    };
  }

  prepare(): void {
    if (this.prepared) return;
    const required = [
      "scripts/abtars-watchdog.sh",
      "src/supervisor/state-cli.ts",
      "src/supervisor/state.ts",
      "src/cli/abtars.ts",
      "scripts/watchdog-acceptance/fixture-bridge.ts",
    ];
    for (const rel of required) {
      const p = join(this.repoRoot, rel);
      try {
        readFileSync(p);
      } catch {
        throw new Error(`expected repository source missing: ${rel}`);
      }
      this.evidence.sources[rel] = sha256(readFileSync(p, "utf-8"));
    }
    this.evidence.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.repoRoot, encoding: "utf-8" }).trim();
    mkdirSync(join(this.artifactsRoot, "bundles"), { recursive: true });
    mkdirSync(join(this.artifactsRoot, "watchdogs"), { recursive: true });
    writeFileSync(join(this.artifactsRoot, "build-evidence.json"), JSON.stringify(this.evidence, null, 2));
    this.prepared = true;
  }

  /** Transformed copy of the production watchdog script for one profile. */
  produceWatchdogCopy(profileName: string): string {
    this.prepare();
    const cached = this.watchdogCache.get(profileName);
    if (cached) return cached;
    const profile = getProfile(profileName);
    const src = readFileSync(join(this.repoRoot, "scripts/abtars-watchdog.sh"), "utf-8");
    const transformed = applyTransforms(src, profile.transforms, "watchdog");
    const dir = join(this.artifactsRoot, "watchdogs", profileName);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "abtars-watchdog.sh");
    writeFileSync(path, transformed);
    chmodSync(path, 0o755);
    this.evidence.artifacts[`watchdog:${profileName}`] = sha256(transformed);
    this.watchdogCache.set(profileName, path);
    return path;
  }

  /**
   * Build every artifact the suite needs before any scenario spawns. Uses the
   * async esbuild API because the timing adapter requires an onLoad plugin.
   * Sync accessors below throw unless this has completed.
   */
  async prebuild(profileNames: readonly string[]): Promise<void> {
    this.prepare();
    const timingPluginFor = (profileName: string): esbuild.Plugin => ({
      name: "timing-patch",
      setup(build) {
        const escaped = "supervisor/state.ts".replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        build.onLoad({ filter: new RegExp(`${escaped}$`) }, async (args) => ({
          contents: applyTransforms(readFileSync(args.path, "utf-8"), getProfile(profileName).transforms, "supervisor-state"),
          loader: "ts",
          resolveDir: dirname(args.path),
        }));
      },
    });

    for (const profileName of profileNames) {
      if (this.supervisorStatePaths.has(profileName)) continue;
      const outfile = join(this.artifactsRoot, "bundles", `abtars-supervisor-state.${profileName}.js`);
      await this.bundle({
        entry: join(this.repoRoot, "src/supervisor/state-cli.ts"),
        outfile,
        plugin: timingPluginFor(profileName),
        key: `supervisor-state:${profileName}`,
      });
      this.supervisorStatePaths.set(profileName, outfile);
    }

    if (this.fixtureBridgePath === null) {
      this.fixtureBridgePath = await this.bundle({
        entry: `${__dirname}/fixture-bridge.ts`,
        outfile: join(this.artifactsRoot, "bundles", "fixture-bridge.js"),
        key: "fixture-bridge",
      });
    }

    if (this.doctorCliPath === null) {
      this.doctorCliPath = await this.bundle({
        entry: join(this.repoRoot, "src/cli/abtars.ts"),
        outfile: join(this.artifactsRoot, "bundles", "abtars-cli.js"),
        key: "doctor",
        external: ["better-sqlite3", "cloakbrowser", "pdf-parse", "jimp", "youtube-transcript", "rettiwt-api"],
      });
    }

    writeFileSync(join(this.artifactsRoot, "build-evidence.json"), this.evidenceJson());
    this.prebuildDone = true;
  }

  /** Sync accessor used while seeding worlds. */
  bundleSupervisorState(profileName: string): string {
    const p = this.supervisorStatePaths.get(profileName);
    if (p === undefined) throw new Error(`supervisor-state bundle for '${profileName}' not prebuilt — call prebuild() first`);
    return p;
  }

  bundleFixtureBridge(): string {
    if (this.fixtureBridgePath === null) throw new Error("fixture bridge not prebuilt — call prebuild() first");
    return this.fixtureBridgePath;
  }

  bundleDoctorCli(): string {
    if (this.doctorCliPath === null) throw new Error("doctor CLI not prebuilt — call prebuild() first");
    return this.doctorCliPath;
  }

  isPrebuilt(): boolean {
    return this.prebuildDone;
  }

  private async bundle(opts: {
    entry: string;
    outfile: string;
    key: string;
    plugin?: esbuild.Plugin;
    external?: string[];
  }): Promise<string> {
    mkdirSync(dirname(opts.outfile), { recursive: true });
    await esbuild.build({
      entryPoints: [opts.entry],
      outfile: opts.outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: false,
      logLevel: "silent",
      external: opts.external ?? [],
      plugins: opts.plugin ? [opts.plugin] : [],
      banner: { js: "import { createRequire as __creq } from 'node:module';\nconst require = __creq(import.meta.url);" },
    });
    this.evidence.artifacts[opts.key] = sha256(readFileSync(opts.outfile, "utf-8"));
    return opts.outfile;
  }

  evidenceJson(): string {
    return JSON.stringify(this.evidence, null, 2);
  }
}
