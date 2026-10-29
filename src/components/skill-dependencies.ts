/**
 * skill-dependencies.ts — universal optional skill dependency declarations (#1542).
 *
 * Any skill may declare npm runtime dependencies in <skill>/scripts/package.json
 * using the standard `dependencies` object with exact semantic versions only.
 * A missing manifest, missing `dependencies` key, or empty object means zero
 * dependencies and no work. Every declared entry must be validated and prepared
 * before the owning skill is admitted to the runtime catalog.
 *
 * Packages are installed centrally beneath $ABTARS_HOME/node_modules, where
 * scripts nested under $ABTARS_HOME/skills/.../scripts resolve them through
 * Node's parent-directory lookup (verified by a real nested resolution probe).
 * No root package.json or authoritative aggregate manifest is created; the
 * per-skill manifests remain the source of truth.
 *
 * Installation happens only at controlled lifecycle boundaries — release
 * deploy (strict, all-or-nothing) or startup/explicit skill reload (per-skill
 * admission) — never while a model executes a skill.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { logInfo } from "./logger.js";
import { abtarsHome } from "../paths.js";

const TAG = "skill-dependencies";

export const ERROR_PREFIX = "Skill dependency preparation failed";

/** Source-group precedence for shadowed skill identities (loader parity). */
const SOURCE_RANK: Record<string, number> = {
  self: 0,
  custom: 1,
  downloaded: 2,
  core: 3,
  other: 4,
};

/** npm package name: lowercase URL-safe, optional scope. */
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/**
 * Exact semantic version: MAJOR.MINOR.PATCH with optional valid
 * prerelease/build identifiers. Numeric identifiers cannot have leading zeroes
 * and a prerelease/build suffix cannot be empty.
 */
const EXACT_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Bounded tail of npm process output kept in diagnostics. */
const MAX_PROCESS_OUTPUT_CHARS = 2000;
/** Default npm process timeout. */
const DEFAULT_NPM_TIMEOUT_MS = 120_000;
/** Default nested-resolution probe timeout. */
const PROBE_TIMEOUT_MS = 15_000;

export interface SkillCandidate {
  /** Skill identity (leaf directory name). */
  name: string;
  /** Source group: core | self | custom | downloaded | <other top-level dir>. */
  source: string;
  /** Absolute path to the skill directory (realpathed, under the approved root). */
  rootDir: string;
  /** Absolute path to scripts/package.json when the skill declares one. */
  manifestPath?: string;
  /** Why an existing manifest could not be safely admitted. */
  manifestError?: string;
  /**
   * Resolution-probe base when rootDir is not under the dependency root
   * (staged core skills probed from a scratch location under the home).
   */
  probeDir?: string;
}

export interface SkillDependencyDeclaration {
  skill: SkillCandidate;
  packageName: string;
  version: string;
}

export interface SkillDependencyPlan {
  skills: SkillCandidate[];
  declarations: SkillDependencyDeclaration[];
  /** packageName -> exact version (conflict-free, deduplicated). */
  packages: Map<string, string>;
}

export interface InstalledPin {
  name: string;
  version: string;
}

export interface SkippedSkill {
  skill: SkillCandidate;
  reasons: string[];
}

export interface PreparationResult {
  ready: SkillCandidate[];
  skipped: SkippedSkill[];
  installed: InstalledPin[];
}

export interface NpmInstallOptions {
  /** npm binary; default "npm". Test hook for fake/slow npm. */
  npmBin?: string;
  /** Process timeout in ms; default 120s. */
  timeoutMs?: number;
  /** npm registry URL override; test hook for local fixture registries. */
  registryUrl?: string;
}

export interface PrepareOptions extends NpmInstallOptions {
  /** strict = throw on any invalid/conflicting/unpreparable declaration (deploy). */
  mode: "strict" | "per-skill";
  /** Dependency root; default abtarsHome(). */
  home?: string;
}

/** Env-var test hooks (never used by production defaults unless set). */
export function npmBinDefault(): string {
  return process.env["ABTARS_SKILL_NPM_BIN"] ?? "npm";
}

export function registryUrlDefault(): string | undefined {
  return process.env["ABTARS_SKILL_NPM_REGISTRY"] || undefined;
}

export class SkillDependencyError extends Error {
  readonly failureClass: string;
  constructor(message: string, failureClass: string) {
    super(message);
    this.name = "SkillDependencyError";
    this.failureClass = failureClass;
  }
}

/** True when path exists and its realpath stays under the approved real root. */
function safelyUnder(rootReal: string, path: string): string | null {
  try {
    const real = realpathSync(path);
    const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (real !== rootReal && !real.startsWith(prefix)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Recursively discover skills under a runtime skills root. A candidate is any
 * directory containing SKILL.md. Symlinked directories whose realpath escapes
 * the approved root are skipped (never traversed). Mirrors SkillWatcher
 * discovery semantics so dependency preparation sees the same inventory as
 * the catalog.
 */
export function discoverSkillCandidates(root: string): SkillCandidate[] {
  const rootReal = (() => {
    try {
      return realpathSync(root);
    } catch {
      return null;
    }
  })();
  if (!rootReal) return [];
  const out: SkillCandidate[] = [];
  const walk = (dir: string): void => {
    const dirReal = safelyUnder(rootReal, dir);
    if (!dirReal) return; // symlink escape — no traversal outside approved root
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(dirReal, { withFileTypes: true }).map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
      }));
    } catch {
      return;
    }
    if (entries.some(e => e.name === "SKILL.md" && !e.isDir)) {
      // A symlinked SKILL.md is still a file to Dirent, but it must not make
      // the catalog or dependency planner read instructions outside the
      // configured skill root.
      if (!safelyUnder(rootReal, join(dirReal, "SKILL.md"))) return;
      const manifestPath = join(dirReal, "scripts", "package.json");
      const manifestExists = existsSync(manifestPath);
      const safeManifest = manifestExists ? safelyUnder(rootReal, manifestPath) : null;
      out.push({
        name: basename(dirReal),
        source: sourceOfSkill(rootReal, dirReal),
        rootDir: dirReal,
        ...(safeManifest ? { manifestPath: safeManifest } : {}),
        ...(manifestExists && !safeManifest ? { manifestError: `manifest path escapes the configured skill root: ${manifestPath}` } : {}),
      });
    }
    for (const e of entries) {
      if (!e.isDir) continue;
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(join(dirReal, e.name));
    }
  };
  walk(rootReal);
  return out;
}

/** Source group of a discovered skill: first path segment under the root. */
export function sourceOfSkill(rootReal: string, skillDir: string): string {
  const rel = resolve(skillDir).slice(resolve(rootReal).length + 1);
  if (!rel) return "core";
  return rel.split(sep)[0] ?? "core";
}

/** Loader parity: rank source groups for shadowed identities. */
export function sourceRank(source: string): number {
  return SOURCE_RANK[source] ?? SOURCE_RANK["other"]!;
}

/**
 * Deduplicate candidates by skill identity, keeping the highest-precedence
 * source (self > custom > downloaded > core > other). Deterministic: ties are
 * broken by rootDir lexicographic order.
 */
export function resolveShadowedCandidates(candidates: SkillCandidate[]): SkillCandidate[] {
  const best = new Map<string, SkillCandidate>();
  for (const c of [...candidates].sort((a, b) => (a.rootDir < b.rootDir ? -1 : a.rootDir > b.rootDir ? 1 : 0))) {
    const existing = best.get(c.name);
    if (!existing || sourceRank(c.source) < sourceRank(existing.source)) {
      best.set(c.name, c);
    }
  }
  return [...best.values()].sort((a, b) => (a.rootDir < b.rootDir ? -1 : 1));
}

export function isValidPackageName(name: string): boolean {
  if (typeof name !== "string" || !NPM_NAME_RE.test(name)) return false;
  return !name.startsWith(".") && !name.startsWith("_");
}

export function isValidExactVersion(version: string): boolean {
  return typeof version === "string" && EXACT_VERSION_RE.test(version);
}

/** Parse a skill's scripts/package.json into declarations. */
export function readSkillDependencies(
  candidate: SkillCandidate,
): { ok: true; declarations: SkillDependencyDeclaration[] } | { ok: false; error: string } {
  if (candidate.manifestError) return { ok: false, error: candidate.manifestError };
  if (!candidate.manifestPath) return { ok: true, declarations: [] };
  let raw: string;
  try {
    raw = readFileSync(candidate.manifestPath, "utf-8");
  } catch {
    return { ok: false, error: `manifest unreadable: ${candidate.manifestPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `manifest is not valid JSON: ${candidate.manifestPath}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `manifest must be a JSON object: ${candidate.manifestPath}` };
  }
  const dependencies = (parsed as Record<string, unknown>)["dependencies"];
  if (dependencies === undefined) return { ok: true, declarations: [] };
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    return { ok: false, error: `"dependencies" must be an object: ${candidate.manifestPath}` };
  }
  const out: SkillDependencyDeclaration[] = [];
  for (const [packageName, version] of Object.entries(dependencies as Record<string, unknown>)) {
    out.push({ skill: candidate, packageName, version: typeof version === "string" ? version : String(version) });
  }
  return { ok: true, declarations: out };
}

export interface ValidationError {
  message: string;
  /** Skills that must be excluded when the error cannot be satisfied. */
  skills: SkillCandidate[];
}

/**
 * Validate and deterministically aggregate all declarations. Identical
 * package/version pins are deduplicated; conflicting exact versions in the
 * shared dependency root are rejected with every affected skill identified.
 * Returns structured per-declaration errors otherwise.
 */
export function validateAndAggregate(
  declarations: SkillDependencyDeclaration[],
): { ok: true; plan: SkillDependencyPlan } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const byPackage = new Map<string, Map<string, SkillDependencyDeclaration[]>>();
  for (const d of declarations) {
    const manifest = d.skill.manifestPath ?? join(d.skill.rootDir, "scripts", "package.json");
    const label = `skill "${d.skill.name}" (${d.skill.source}, manifest ${manifest})`;
    if (!isValidPackageName(d.packageName)) {
      errors.push({
        message: `${ERROR_PREFIX}: ${label}: invalid npm package name "${d.packageName}"`,
        skills: [d.skill],
      });
      continue;
    }
    if (!isValidExactVersion(d.version)) {
      errors.push({
        message: `${ERROR_PREFIX}: ${label}: "${d.packageName}" version "${d.version}" is not an exact MAJOR.MINOR.PATCH semantic version (ranges, tags, aliases, git/file/URL/workspace sources and unresolved variables are invalid)`,
        skills: [d.skill],
      });
      continue;
    }
    const versions = byPackage.get(d.packageName) ?? new Map<string, SkillDependencyDeclaration[]>();
    const list = versions.get(d.version) ?? [];
    list.push(d);
    versions.set(d.version, list);
    byPackage.set(d.packageName, versions);
  }

  const packages = new Map<string, string>();
  for (const [packageName, versions] of byPackage) {
    if (versions.size > 1) {
      const affected = [...versions.values()].flat();
      const conflictDesc = [...versions.entries()]
        .map(([v, ds]) => `${v} (${ds.map(d => `${d.skill.name} [${d.skill.source}]`).join(", ")})`)
        .join("; ");
      errors.push({
        message: `${ERROR_PREFIX}: package "${packageName}" has conflicting exact versions in the shared dependency root: ${conflictDesc}`,
        skills: affected.map(d => d.skill),
      });
      continue;
    }
    const entries = [...versions.entries()];
    const version = entries[0]?.[0];
    if (version === undefined) continue;
    packages.set(packageName, version);
  }

  if (errors.length > 0) return { ok: false, errors };

  const deduped: SkillDependencyDeclaration[] = [];
  const seen = new Set<string>();
  for (const d of [...declarations].sort((a, b) => {
    const byPkg = a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0;
    if (byPkg !== 0) return byPkg;
    const bySrc = a.skill.source < b.skill.source ? -1 : a.skill.source > b.skill.source ? 1 : 0;
    if (bySrc !== 0) return bySrc;
    return a.skill.rootDir < b.skill.rootDir ? -1 : 1;
  })) {
    const key = `${d.packageName}@${d.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(d);
  }

  return {
    ok: true,
    plan: {
      skills: resolveShadowedCandidates(declarations.map(d => d.skill)),
      declarations: deduped,
      packages,
    },
  };
}

/** Direct installed version of a package under the dependency root, or null. */
export function directInstalledVersion(home: string, packageName: string): string | null {
  const p = join(home, "node_modules", packageName, "package.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    return typeof raw["version"] === "string" ? raw["version"] : null;
  } catch {
    return null;
  }
}

/** Copyable recovery command for a set of exact pins. */
export function recoveryCommand(home: string, pins: ReadonlyArray<{ name: string; version: string }>): string {
  return [
    "npm install",
    `--prefix ${home}`,
    "--no-save",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
    ...pins.map(p => `${p.name}@${p.version}`),
  ].join(" ");
}

/** Build the bounded npm argv for a set of exact pins. */
export function npmInstallArgv(
  home: string,
  pins: ReadonlyArray<{ name: string; version: string }>,
  opts: NpmInstallOptions = {},
): string[] {
  const args = ["install", "--prefix", home, "--no-save", "--package-lock=false", "--no-audit", "--no-fund"];
  if (opts.registryUrl) args.push("--registry", opts.registryUrl);
  args.push(...pins.map(p => `${p.name}@${p.version}`));
  return args;
}

/**
 * One bounded, non-shell npm install with a finite timeout and bounded output.
 * Resolves { ok } — never throws on process failure.
 */
export function installNpmPackages(
  home: string,
  pins: ReadonlyArray<{ name: string; version: string }>,
  opts: NpmInstallOptions = {},
): Promise<{ ok: boolean; output: string }> {
  const bin = opts.npmBin ?? "npm";
  const args = npmInstallArgv(home, pins, opts);
  logInfo(TAG, `npm install (${pins.length} pin(s)): ${bin} ${args.join(" ")}`);
  return new Promise(resolve => {
    let output = "";
    let settled = false;
    const child = spawn(bin, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? DEFAULT_NPM_TIMEOUT_MS,
    });
    const append = (chunk: Buffer | string): void => {
      output = (output + chunk.toString()).slice(-MAX_PROCESS_OUTPUT_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", err => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, output: `spawn error: ${err.message}` });
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      resolve({ ok: code === 0, output });
    });
  });
}

/**
 * Real Node module resolution probe from a nested skill script path. Bare
 * specifiers resolve via parent-directory lookup, reaching
 * $ABTARS_HOME/node_modules from any $ABTARS_HOME/skills/.../scripts dir.
 * A real dynamic import throws (non-zero exit) when the package cannot be
 * resolved or loaded from the nested path. Read-only catalog checks can opt
 * into import.meta.resolve instead, which validates lookup without executing
 * dependency code.
 *
 * When the candidate carries a probeDir (staged core skills probed from a
 * scratch location under the home before reconcile), the scratch scripts dir
 * is created first — same parent-directory walk-up mechanism.
 */
export function probeNestedResolution(
  skill: SkillCandidate,
  packageName: string,
  options: { load?: boolean } = {},
): boolean {
  const scriptsDir = join(skill.probeDir ?? skill.rootDir, "scripts");
  if (!existsSync(scriptsDir)) {
    if (!skill.probeDir) return false;
    try {
      mkdirSync(scriptsDir, { recursive: true });
    } catch {
      return false;
    }
  }
  try {
    const expression = options.load === false
      ? `import.meta.resolve(${JSON.stringify(packageName)})`
      : `await import(${JSON.stringify(packageName)})`;
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", expression],
      { cwd: scriptsDir, stdio: "ignore", timeout: PROBE_TIMEOUT_MS },
    );
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function declareLabels(skill: SkillCandidate, packageName: string, version: string): string {
  const manifest = skill.manifestPath ?? join(skill.rootDir, "scripts", "package.json");
  return `skill "${skill.name}" (${skill.source}, manifest ${manifest}): "${packageName}@${version}"`;
}

/** Skills (by name+rootDir) owning a given package pin. */
function skillsOwningPin(
  candidates: SkillCandidate[],
  declarations: readonly SkillDependencyDeclaration[],
  packageName: string,
): SkillCandidate[] {
  return candidates.filter(c =>
    declarations.some(
      d => d.skill.name === c.name && d.skill.rootDir === c.rootDir && d.packageName === packageName,
    ),
  );
}

/**
 * Read-only dependency status for a single skill — never invokes npm, never
 * mutates anything. Used by the synchronous catalog path (passive refreshes)
 * so a declared-but-unprepared dependency is reported, not hidden; the async
 * prepare path remains the controlled installation boundary.
 */
export function readonlyDependencyStatus(home: string, candidate: SkillCandidate): string[] {
  const read = readSkillDependencies(candidate);
  if (!read.ok) return [read.error];
  if (read.declarations.length === 0) return [];
  const validated = validateAndAggregate(read.declarations);
  if (!validated.ok) return validated.errors.map(e => e.message);
  const reasons: string[] = [];
  for (const d of validated.plan.declarations) {
    const installed = directInstalledVersion(home, d.packageName);
    if (installed !== d.version) {
      reasons.push(`"${d.packageName}@${d.version}" not prepared (installed: ${installed ?? "none"}) — run /skill reload`);
    } else if (!probeNestedResolution(candidate, d.packageName, { load: false })) {
      reasons.push(`"${d.packageName}" not resolvable from ${join(candidate.rootDir, "scripts")}`);
    }
  }
  return reasons;
}

/**
 * Validate and prepare declared dependencies for a set of candidates.
 *
 * strict mode: any invalid/conflicting/unpreparable declaration throws
 * SkillDependencyError before the release can be activated — used by deploy.
 *
 * per-skill mode: affected skills are reported in `skipped` with explicit
 * reasons; unaffected skills remain ready — used by startup/reload.
 */
export async function prepareSkillDependencies(
  candidates: SkillCandidate[],
  opts: PrepareOptions,
): Promise<PreparationResult> {
  const home = opts.home ?? abtarsHome();
  const effectiveOpts: NpmInstallOptions = {
    npmBin: opts.npmBin ?? npmBinDefault(),
    registryUrl: opts.registryUrl ?? registryUrlDefault(),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const skipped = new Map<string, SkippedSkill>();
  const skipWith = (skill: SkillCandidate, reason: string): void => {
    const key = `${skill.name}\u0000${skill.rootDir}`;
    const existing = skipped.get(key);
    if (existing) existing.reasons.push(reason);
    else skipped.set(key, { skill, reasons: [reason] });
  };
  const isSkipped = (skill: SkillCandidate): boolean => skipped.has(`${skill.name}\u0000${skill.rootDir}`);
  const fail = (failureClass: string, message: string): never => {
    throw new SkillDependencyError(`${ERROR_PREFIX}: ${message}`, failureClass);
  };

  // Read all manifests first — no process work until the inventory is valid.
  const declarations: SkillDependencyDeclaration[] = [];
  for (const candidate of candidates) {
    const read = readSkillDependencies(candidate);
    if (!read.ok) {
      if (opts.mode === "strict") fail("invalid_manifest", read.error);
      skipWith(candidate, read.error);
      continue;
    }
    declarations.push(...read.declarations);
  }

  let plan: SkillDependencyPlan;
  let declarationsForPlan = declarations;
  while (true) {
    const validated = validateAndAggregate(declarationsForPlan);
    if (validated.ok) {
      plan = validated.plan;
      break;
    }
    if (opts.mode === "strict") fail("invalid_declaration", validated.errors.map(e => e.message).join("; "));

    // In per-skill mode, invalid/conflicting declarations exclude only their
    // owning skills. Rebuild the plan from unaffected declarations so valid
    // skills still get their dependencies prepared in this same lifecycle.
    for (const err of validated.errors) {
      for (const skill of err.skills) skipWith(skill, err.message);
    }
    const unaffected = declarationsForPlan.filter(d => !isSkipped(d.skill));
    if (unaffected.length === declarationsForPlan.length) {
      // Defensive guard: validation errors must always identify their owners.
      plan = { skills: [], declarations: [], packages: new Map() };
      break;
    }
    declarationsForPlan = unaffected;
  }

  // Determine which pins need work. Exact direct-version match = no-op.
  const allPins: InstalledPin[] = [...plan.packages.entries()].map(([name, version]) => ({ name, version }));
  const missing = allPins.filter(pin => directInstalledVersion(home, pin.name) !== pin.version);

  const installed: InstalledPin[] = [];
  if (missing.length > 0) {
    const result = await installNpmPackages(home, missing, effectiveOpts);
    const outputSnippet = result.output ? `\n  npm output (bounded): ${result.output.slice(-500)}` : "";
    // Attribution: re-verify each pin individually after the bounded attempt.
    const unsatisfied = missing.filter(pin => directInstalledVersion(home, pin.name) !== pin.version);
    for (const pin of missing) {
      if (!unsatisfied.some(p => p.name === pin.name)) installed.push(pin);
    }
    if (!result.ok) {
      const msg = `npm install failed. ${recoveryCommand(home, missing)}${outputSnippet}`;
      if (opts.mode === "strict") fail("install_failed", msg);
      for (const pin of unsatisfied) {
        for (const skill of skillsOwningPin(candidates, declarationsForPlan, pin.name)) skipWith(skill, msg);
      }
    } else if (unsatisfied.length > 0) {
      // npm exited 0 but a direct version is still wrong — post-install mismatch.
      const msg = `post-install verification failed for ${unsatisfied.map(p => `${p.name}@${p.version}`).join(", ")}. ${recoveryCommand(home, missing)}${outputSnippet}`;
      if (opts.mode === "strict") fail("post_install_mismatch", msg);
      for (const pin of unsatisfied) {
        for (const skill of skillsOwningPin(candidates, declarationsForPlan, pin.name)) skipWith(skill, msg);
      }
    }
  }

  // Re-verify every declared pin (even pre-existing ones) before admission.
  for (const pin of allPins) {
    if (directInstalledVersion(home, pin.name) !== pin.version) {
      const msg = `declared version "${pin.name}@${pin.version}" is not installed at ${join(home, "node_modules")}. ${recoveryCommand(home, [pin])}`;
      if (opts.mode === "strict") fail("missing_dependency", msg);
      for (const skill of skillsOwningPin(candidates, declarationsForPlan, pin.name)) skipWith(skill, msg);
    }
  }

  // Real nested Node resolution from each declaring skill's scripts dir.
  for (const candidate of candidates) {
    const owns = declarationsForPlan.filter(
      d => d.skill.name === candidate.name && d.skill.rootDir === candidate.rootDir,
    );
    if (owns.length === 0) continue;
    for (const d of owns) {
      if (!probeNestedResolution(candidate, d.packageName)) {
        const msg = `nested module resolution failed for ${declareLabels(candidate, d.packageName, d.version)} from ${join(candidate.rootDir, "scripts")}`;
        if (opts.mode === "strict") fail("resolution_failed", msg);
        skipWith(candidate, msg);
        break;
      }
    }
  }

  const ready = candidates.filter(c => !isSkipped(c));
  return { ready, skipped: [...skipped.values()], installed };
}

/**
 * Deploy-mode composition: staged release core skills (templates/skills/*,
 * which will replace runtime skills/core) plus every preserved user-owned
 * runtime skill (self/custom/downloaded/... — the old runtime core is
 * excluded because the staged core supersedes it). Strict mode: any failure
 * throws before the first activation mutation.
 *
 * Staged core skills are not yet under the dependency root (reconcile runs
 * after activation), so their resolution probes run from a scratch location
 * under the home that exercises the identical parent-directory walk-up to
 * $ABTARS_HOME/node_modules. The scratch tree is removed afterwards.
 */
export async function prepareDeploySkillDependencies(stagedTemplates: string, home: string): Promise<PreparationResult> {
  const candidates: SkillCandidate[] = [];
  const stagedCoreRoot = join(stagedTemplates, "skills");
  const scratchRoot = join(home, "skills", `.dep-probe-${randomBytes(4).toString("hex")}`);
  for (const c of discoverSkillCandidates(stagedCoreRoot)) {
    candidates.push({ ...c, probeDir: join(scratchRoot, c.name) });
  }
  for (const c of discoverSkillCandidates(join(home, "skills"))) {
    if (c.source === "core") continue; // superseded by the staged core
    candidates.push(c);
  }
  try {
    if (candidates.length === 0) return { ready: [], skipped: [], installed: [] };
    return await prepareSkillDependencies(candidates, { mode: "strict", home });
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}
