import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { PI_COMPATIBILITY } from "../config/pi-compatibility.js";
import { compareSemver } from "../utils/version-compare.js";

export const PI_VERSION_PROBE_TIMEOUT_MS = 5_000;
export const PI_VERSION_PROBE_MAX_BYTES = 1024;
const ANCESTOR_WALK_MAX = 10;

export type PiInstallationSource = "configured" | "path";

export type PiInstallation = {
  executable: string;
  packageRoot: string;
  version: string;
  source: PiInstallationSource;
  moduleRoots: {
    ai: string;
    tui: string;
    agentCore: string;
  };
};

export type PiInstallationState =
  | { state: "absent" }
  | { state: "compatible"; installation: PiInstallation }
  | {
      state: "below-minimum" | "incomplete" | "invalid";
      executable?: string;
      packageRoot?: string;
      observedVersion?: string;
      reason: string;
      remediation: string;
    };

let _cachedInstallation: PiInstallation | null = null;

export function clearPiCache(): void {
  _cachedInstallation = null;
}

/**
 * Resolve a `pi` executable path without a shell.
 */
export function resolvePiFromPath(): string | null {
  return resolveExecutableFromPath("pi");
}

/**
 * Resolve any bare executable name from PATH without a shell. Returns the
 * canonical absolute path or null.
 * - Absolute paths are returned as-is (must exist on disk).
 * - Bare names are searched across PATH directories.
 * - Relative names (containing a separator but not absolute) return null.
 */
export function resolveExecutableFromPath(command: string): string | null {
  if (isAbsolute(command)) {
    try {
      if (!existsSync(command)) return null;
      return realpathSync(command);
    } catch { return null; }
  }
  if (command.includes("/") || command.includes("\\")) {
    // Relative path — reject, not on PATH
    return null;
  }
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, command);
    try {
      if (!existsSync(candidate)) continue;
      return realpathSync(candidate);
    } catch { continue; }
  }
  return null;
}

function findPackageRoot(startDir: string, targetName: string): string | null {
  let current = resolve(startDir);
  for (let i = 0; i < ANCESTOR_WALK_MAX; i++) {
    const pkgJsonPath = join(current, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const meta = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { name?: string };
        if (meta.name === targetName) return current;
      } catch {
        // continue walking
      }
    }
    const parent = dirname(current);
    if (parent === current) break; // root
    current = parent;
  }
  return null;
}

function findPiPackageRoot(executable: string): string | null {
  let canonical: string;
  try {
    canonical = realpathSync(executable);
  } catch {
    return findPackageRoot(dirname(resolve(executable)), PI_COMPATIBILITY.packageName);
  }
  const dir = dirname(canonical);
  return findPackageRoot(dir, PI_COMPATIBILITY.packageName);
}

function probePiVersion(executable: string): string | null {
  const result = spawnSync(executable, ["--version"], {
    shell: false,
    encoding: "utf-8",
    timeout: PI_VERSION_PROBE_TIMEOUT_MS,
    maxBuffer: PI_VERSION_PROBE_MAX_BYTES,
  });
  if (result.error || result.signal || result.status !== 0) return null;
  const stdout = (result.stdout ?? "").trim();
  if (!stdout || stdout.length > 100) return null;
  return stdout;
}

function readPackageVersion(packageRoot: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as { version?: string };
    return meta.version ?? null;
  } catch {
    return null;
  }
}

export function resolveNestedPackageRoot(packageRoot: string, pkgName: string): string | null {
  const installRoot = resolve(packageRoot, "node_modules");
  const candidateRoot = join(installRoot, ...pkgName.split("/"));
  try {
    const canonicalRoot = realpathSync(candidateRoot);
    const canonicalInstallRoot = realpathSync(installRoot);
    const containedPath = relative(canonicalInstallRoot, canonicalRoot);
    if (containedPath.startsWith("..") || isAbsolute(containedPath)) return null;

    const meta = JSON.parse(readFileSync(join(canonicalRoot, "package.json"), "utf-8")) as { name?: string };
    if (meta.name !== pkgName) return null;
    return canonicalRoot;
  } catch {
    return null;
  }
}

export function resolvePiInstallation(options?: { useCache?: boolean }): PiInstallationState {
  if (options?.useCache !== false && _cachedInstallation) {
    return { state: "compatible", installation: _cachedInstallation };
  }

  let executable: string | null = null;
  let source: PiInstallationSource = "path";
  try {
    const { loadPiConfig } = require("./pi-executor/config.js") as { loadPiConfig: () => { command?: string } | null };
    const config = loadPiConfig();
    if (config?.command) {
      const resolved = resolveExecutableFromPath(config.command);
      if (!resolved) {
        return {
          state: "invalid",
          reason: `Configured command "${config.command}" not found on PATH`,
          remediation: `Ensure "${config.command}" is installed and on your PATH, or configure an absolute path in pi-executor.json`,
        };
      }
      executable = resolved;
      source = "configured";
    }
  } catch {
    // config not available, fall through to PATH
  }

  if (!executable) {
    const fromPath = resolvePiFromPath();
    if (!fromPath) return { state: "absent" };
    executable = fromPath;
    source = "path";
  }

  const version = probePiVersion(executable);
  if (!version) {
    return {
      state: "invalid",
      executable,
      reason: "pi --version returned no valid output",
      remediation: `Verify the pi executable at ${executable} is working. Install with: abtars deps install pi`,
    };
  }

  const packageRoot = findPiPackageRoot(executable);
  if (!packageRoot) {
    return {
      state: "invalid",
      executable,
      observedVersion: version,
      reason: `Could not find ${PI_COMPATIBILITY.packageName} package root from ${executable}`,
      remediation: `The pi executable at ${executable} is not part of an official Pi installation. Install with: abtars deps install pi`,
    };
  }

  const pkgVersion = readPackageVersion(packageRoot);
  if (!pkgVersion) {
    return {
      state: "invalid",
      executable,
      packageRoot,
      observedVersion: version,
      reason: `Missing or invalid version in ${join(packageRoot, "package.json")}`,
      remediation: `Corrupt installation at ${packageRoot}. Reinstall with: abtars deps install pi`,
    };
  }

  if (pkgVersion !== version) {
    return {
      state: "invalid",
      executable,
      packageRoot,
      observedVersion: `${pkgVersion} (pkg) / ${version} (cli)`,
      reason: `Package version (${pkgVersion}) does not match CLI version (${version})`,
      remediation: `Installation at ${packageRoot} seems corrupted. Reinstall with: abtars deps install pi`,
    };
  }

  const cmp = compareSemver(version, PI_COMPATIBILITY.minimumPiVersion);
  if (cmp === -1) {
    return {
      state: "below-minimum",
      executable,
      packageRoot,
      observedVersion: version,
      reason: `Pi version ${version} is below minimum ${PI_COMPATIBILITY.minimumPiVersion}`,
      remediation: `Update Pi with: abtars deps update pi, or manually run: ${executable} update --self`,
    };
  }

  const aiRoot = resolveNestedPackageRoot(packageRoot, PI_COMPATIBILITY.nestedPackages.ai);
  const tuiRoot = resolveNestedPackageRoot(packageRoot, PI_COMPATIBILITY.nestedPackages.tui);
  const agentCoreRoot = resolveNestedPackageRoot(packageRoot, PI_COMPATIBILITY.nestedPackages.agentCore);

  const missingNested: string[] = [];
  if (!aiRoot) missingNested.push(PI_COMPATIBILITY.nestedPackages.ai);
  if (!tuiRoot) missingNested.push(PI_COMPATIBILITY.nestedPackages.tui);
  if (!agentCoreRoot) missingNested.push(PI_COMPATIBILITY.nestedPackages.agentCore);

  if (missingNested.length > 0) {
    return {
      state: "incomplete",
      executable,
      packageRoot,
      observedVersion: version,
      reason: `Missing nested Pi packages: ${missingNested.join(", ")}`,
      remediation: `Installation at ${packageRoot} is incomplete. Reinstall with: abtars deps install pi`,
    };
  }

  const installation: PiInstallation = {
    executable,
    packageRoot,
    version,
    source,
    moduleRoots: {
      ai: aiRoot!,
      tui: tuiRoot!,
      agentCore: agentCoreRoot!,
    },
  };

  _cachedInstallation = installation;
  return { state: "compatible", installation };
}

export function createPiRequire(installation: PiInstallation): ReturnType<typeof createRequire> {
  return createRequire(join(installation.packageRoot, "package.json"));
}

export function loadPiModule<T>(installation: PiInstallation, specifier: string): T {
  const piRequire = createPiRequire(installation);
  return piRequire(specifier) as T;
}
