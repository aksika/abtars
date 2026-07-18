import { printBanner } from './banner.js';
import { OPTIONAL_DEPS, SYSTEM_DEPS } from "../../utils/lazy-require.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  acquireLock, releaseLock, generateLockToken,
} from "../deploy-lib/shared-native-deps-lock.js";
import {
  readManifest, createEmptyManifest, writeManifest, addConsumer, removeConsumer,
} from "../deploy-lib/shared-native-deps-manifest.js";
import {
  resolvePiInstallation, clearPiCache, resolvePiFromPath,
} from "../../components/pi-installation.js";
import { inspectPiRuntimeSurfaces } from "../../components/pi-inspector.js";
import { PI_COMPATIBILITY } from "../../config/pi-compatibility.js";

// ── Observation types ─────────────────────────────────────────────────────────

export type PackageObservation =
  | { state: "absent" }
  | { state: "installed"; version: string }
  | { state: "invalid"; reason: string };

export type GroupState = "absent" | "partial" | "ready" | "drifted" | "invalid";

export type GroupObservation = {
  name: string;
  packages: ReadonlyArray<{ name: string; target: string; observed: PackageObservation }>;
  state: GroupState;
};

export type DependencyOperation = "install" | "update";

export type GroupAction = {
  group: string;
  reason: "missing" | "partial" | "invalid" | "drifted" | "refresh";
};

// ── External distribution registry ────────────────────────────────────────────

export type ExternalDistribution = {
  name: string;
  packageName: string;
  binaryName: string;
  label: string;
};

export const EXTERNAL_DISTRIBUTIONS: Record<string, ExternalDistribution> = {
  pi: {
    name: "pi",
    packageName: "@earendil-works/pi-coding-agent",
    binaryName: "pi",
    label: "Pi coding agent (CLI + AI + TUI)",
  },
};

// ── Shared prefix paths ──────────────────────────────────────────────────────

function libDir(): string {
  return join(homedir(), ".local", "lib");
}

function resolveNmDir(): string {
  return process.env['ABTARS_NM'] ?? join(homedir(), '.local', 'lib', 'node_modules');
}

// ── Package observation (npm prefix deps) ─────────────────────────────────────

export function observePackage(pkgName: string): PackageObservation {
  const pkgDir = join(resolveNmDir(), pkgName);
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return { state: "absent" };
  try {
    const raw = readFileSync(pkgJsonPath, "utf-8");
    const meta = JSON.parse(raw) as { version?: string };
    if (typeof meta.version !== "string" || !meta.version) {
      return { state: "invalid", reason: "missing-version" };
    }
    return { state: "installed", version: meta.version };
  } catch {
    return { state: "invalid", reason: "invalid-json" };
  }
}

function pkgTarget(pkg: string, dep: (typeof OPTIONAL_DEPS)[string]): string {
  if (dep.targets?.[pkg]) return dep.targets[pkg];
  if (dep.version) return dep.version;
  return "latest";
}

export function observeGroup(name: string): GroupObservation {
  const dep = OPTIONAL_DEPS[name];
  if (!dep) throw new Error(`Unknown dep group: ${name}`);

  const packages = dep.packages.map(pkg => {
    const target = pkgTarget(pkg, dep);
    return { name: pkg, target, observed: observePackage(pkg) };
  });

  const absent = packages.every(p => p.observed.state === "absent");
  const hasVersionPin = !packages.every(p => p.target === "latest");
  const allReady = hasVersionPin
    ? packages.every(p => p.observed.state === "installed" && p.observed.version === p.target)
    : packages.every(p => p.observed.state === "installed");
  const anyInvalid = packages.some(p => p.observed.state === "invalid");
  const anyInstalled = packages.some(p => p.observed.state === "installed");

  let state: GroupState;
  if (absent) state = "absent";
  else if (anyInvalid) state = "invalid";
  else if (allReady) state = "ready";
  else if (anyInstalled) state = "drifted";
  else state = "partial";

  return { name, packages, state };
}

// ── Pi observation ────────────────────────────────────────────────────────────

type PiObserveState = "absent" | "compatible" | "unloadable" | "below-minimum" | "incomplete" | "invalid";

type PiObservation = {
  state: PiObserveState;
  version?: string;
  executable?: string;
  reason?: string;
  remediation?: string;
};

function observePi(): PiObservation {
  const result = resolvePiInstallation({ useCache: false });
  switch (result.state) {
    case "absent":
      return { state: "absent" };
    case "compatible": {
      const surfaces = inspectPiRuntimeSurfaces(result.installation);
      const unloadable = Object.entries(surfaces).filter(([, v]) => v.status === "unloadable");
      if (unloadable.length > 0) {
        const reason = unloadable.map(([key, v]) => `${key}: ${(v as { reason: string }).reason}`).join("; ");
        return {
          state: "unloadable",
          version: result.installation.version,
          executable: result.installation.executable,
          reason,
          remediation: `Pi's package structure matches, but ${unloadable.length} runtime module surface(s) failed to resolve. Reinstall with: abtars deps install pi`,
        };
      }
      return { state: "compatible", version: result.installation.version, executable: result.installation.executable };
    }
    case "below-minimum":
    case "incomplete":
    case "invalid":
      return {
        state: result.state,
        version: result.observedVersion,
        executable: result.executable,
        reason: result.reason,
        remediation: result.remediation,
      };
  }
}

// ── Pure target resolver ──────────────────────────────────────────────────────

const LEGACY_PI_GROUPS = new Set(["provider", "tui"]);

function guideLegacyGroup(name: string): string | null {
  if (LEGACY_PI_GROUPS.has(name)) {
    return `'${name}' has been replaced by 'pi'. Use: abtars deps install pi`;
  }
  return null;
}

export function resolveGroupActions(
  operation: DependencyOperation,
  requestedNames: string[],
): GroupAction[] {
  for (const n of requestedNames) {
    if (n === "all") continue;
    if (!OPTIONAL_DEPS[n] && !SYSTEM_DEPS[n] && !EXTERNAL_DISTRIBUTIONS[n]) {
      const guide = guideLegacyGroup(n);
      throw new Error(guide
        ? `${guide}\nRun 'abtars deps list'.`
        : `Unknown dep group: ${n}. Run 'abtars deps list'.`);
    }
  }

  const effectiveNames = requestedNames.filter(n => n === "all" || OPTIONAL_DEPS[n]);
  const hasExternalAll = requestedNames.includes("all") || requestedNames.some(n => !!EXTERNAL_DISTRIBUTIONS[n]);

  const allGroups = Object.keys(OPTIONAL_DEPS);
  let selected: string[];

  if (effectiveNames.length === 0 && !hasExternalAll) {
    selected = operation === "install" ? ["native"] : allGroups;
  } else if (effectiveNames.includes("all")) {
    if (effectiveNames.length > 1) throw new Error("Cannot combine 'all' with other names.");
    selected = [...allGroups];
  } else {
    selected = [...new Set(effectiveNames)];
  }

  const actions: GroupAction[] = [];
  for (const name of selected) {
    const obs = observeGroup(name);
    const explicitlyNamed = effectiveNames.length > 0 && !effectiveNames.includes("all");
    if (operation === "update" && obs.state === "absent" && !explicitlyNamed) continue;
    switch (obs.state) {
      case "absent": actions.push({ group: name, reason: "missing" }); break;
      case "partial": actions.push({ group: name, reason: "partial" }); break;
      case "invalid": actions.push({ group: name, reason: "invalid" }); break;
      case "drifted": actions.push({ group: name, reason: "drifted" }); break;
      case "ready":
        if (operation === "update") actions.push({ group: name, reason: "refresh" });
        break;
    }
  }

  return actions;
}

// ── Mutation engine (npm prefix deps) ─────────────────────────────────────────

type MutationResult = { group: string; ok: boolean; error?: string };

function versionedArg(pkg: string, dep: (typeof OPTIONAL_DEPS)[string]): string {
  if (dep.targets?.[pkg]) return `${pkg}@${dep.targets[pkg]}`;
  if (dep.version) return `${pkg}@${dep.version}`;
  return pkg;
}

function mutateGroup(action: GroupAction, dep: (typeof OPTIONAL_DEPS)[string]): MutationResult {
  const token = generateLockToken();
  acquireLock("abtars", `${action.reason === "refresh" ? "update" : "install"}:${action.group}`, token);
  try {
    const args: string[] = ["install", "--prefix", libDir(), "--no-audit", "--no-fund"];
    for (const pkg of dep.packages) {
      args.push(versionedArg(pkg, dep));
    }

    const result = spawnSync("npm", args, {
      stdio: "pipe",
      shell: false,
      encoding: "utf-8",
    });

    if (result.error || result.status !== 0) {
      const msg = result.error?.message ?? result.stderr?.slice(0, 200) ?? `exit code ${result.status}`;
      return { group: action.group, ok: false, error: msg };
    }

    if (dep.postInstall) {
      const pi = spawnSync("npx", [...dep.postInstall.split(" ")], {
        stdio: "inherit",
        shell: false,
      });
      if (pi.status !== 0) {
        return { group: action.group, ok: false, error: `post-install failed (exit ${pi.status})` };
      }
    }

    const obs = observeGroup(action.group);
    if (obs.state !== "ready") {
      return { group: action.group, ok: false, error: `verification failed: state=${obs.state}` };
    }

    const manifest = readManifest() ?? createEmptyManifest();
    for (const pkg of dep.packages) {
      const updated = addConsumer(manifest, pkg, "abtars");
      Object.assign(manifest, updated);
    }
    writeManifest(manifest);

    return { group: action.group, ok: true };
  } catch (err) {
    return { group: action.group, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseLock(token);
  }
}

// ── Pi mutation ────────────────────────────────────────────────────────────────

function piInstall(repairExisting: boolean): MutationResult {
  const token = generateLockToken();
  acquireLock("abtars", "install:pi", token);
  try {
    const npmArgs = ["install", "-g", "--ignore-scripts"];
    if (repairExisting) npmArgs.push("--force");
    npmArgs.push("@earendil-works/pi-coding-agent");

    const result = spawnSync("npm", npmArgs, {
      stdio: "pipe",
      shell: false,
      encoding: "utf-8",
    });

    if (result.error || result.status !== 0) {
      const msg = result.error?.message ?? result.stderr?.slice(0, 200) ?? `exit code ${result.status}`;
      return { group: "pi", ok: false, error: msg };
    }

    clearPiCache();

    // Try PATH-based discovery first
    const fromPath = resolvePiFromPath();
    if (fromPath) {
      // Re-check with the found executable
      const piState = observePi();
      if (piState.state === "compatible") return { group: "pi", ok: true };

      // The executable is present on PATH, but the installation may still be
      // incomplete/invalid. Do not misreport that as a PATH problem.
      return {
        group: "pi",
        ok: false,
        error: `Pi found on PATH at ${fromPath}, but the installation is ${piState.state}: ${piState.reason ?? "compatibility check failed"}. ${piState.remediation ?? "Reinstall with: abtars deps install pi"}`,
      };
    }

    // PATH did not have it — try the npm global bin dir directly.
    const binDir = findNpmGlobalBin();
    if (binDir) {
      const piInBin = join(binDir, "pi");
      if (existsSync(piInBin)) {
        process.stdout.write(
          `Pi installed at ${piInBin} but not on current PATH.\n` +
          `Add to your shell profile:\n  export PATH="${binDir}:$PATH"\n`,
        );
        return { group: "pi", ok: true };
      }
    }

    // Could not locate pi anywhere — report failure
    if (binDir) {
      process.stdout.write(
        `Pi not found on PATH after install.\n` +
        `The npm global bin directory is ${binDir}.\n` +
        `Add it to your shell profile:\n  export PATH="${binDir}:$PATH"\n`,
      );
    }
    return { group: "pi", ok: false, error: `Pi installation not found on PATH. Ensure npm global bin is in your PATH.` };
  } catch (err) {
    return { group: "pi", ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseLock(token);
  }
}

function findNpmGlobalBin(): string | null {
  try {
    const result = spawnSync("npm", ["bin", "-g"], {
      stdio: "pipe",
      shell: false,
      encoding: "utf-8",
    });
    if (result.status === 0) {
      const dir = (result.stdout ?? "").trim();
      if (dir && existsSync(dir)) return dir;
    }
    // Fallback: npm config get prefix + /bin
    const prefixResult = spawnSync("npm", ["config", "get", "prefix"], {
      stdio: "pipe",
      shell: false,
      encoding: "utf-8",
    });
    if (prefixResult.status === 0) {
      const prefix = (prefixResult.stdout ?? "").trim();
      if (prefix) {
        const binDir = join(prefix, "bin");
        if (existsSync(binDir)) return binDir;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function piUpdate(): MutationResult {
  const token = generateLockToken();
  acquireLock("abtars", "update:pi", token);
  try {
    const result = resolvePiInstallation({ useCache: false });
    if (result.state !== "compatible") {
      return {
        group: "pi",
        ok: false,
        error: result.state === "absent"
          ? "Pi is not installed. Run 'abtars deps install pi' first."
          : `Pi status: ${result.state}. ${result.remediation}`,
      };
    }

    const updateResult = spawnSync(result.installation.executable, ["update", "--self"], {
      stdio: "pipe",
      shell: false,
      encoding: "utf-8",
    });

    if (updateResult.error || updateResult.status !== 0) {
      const msg = updateResult.error?.message ?? updateResult.stderr?.slice(0, 200) ?? `exit code ${updateResult.status}`;
      return { group: "pi", ok: false, error: msg };
    }

    clearPiCache();
    const postState = observePi();
    if (postState.state !== "compatible") {
      return { group: "pi", ok: false, error: `Pi update completed but verification failed: ${postState.state}` };
    }

    return { group: "pi", ok: true };
  } catch (err) {
    return { group: "pi", ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseLock(token);
  }
}

function piRemove(): MutationResult {
  const token = generateLockToken();
  acquireLock("abtars", "remove:pi", token);
  try {
    const result = resolvePiInstallation({ useCache: false });
    if (result.state === "absent") {
      return { group: "pi", ok: true }; // already absent
    }
    if (result.state !== "compatible") {
      return { group: "pi", ok: false, error: `Cannot determine Pi installation ownership: ${result.remediation}` };
    }

    const pkgRoot = result.installation.packageRoot;
    if (!pkgRoot.startsWith(join(homedir(), ".local")) && !pkgRoot.startsWith(join(homedir(), ".npm"))) {
      return {
        group: "pi",
        ok: false,
        error:
          `Pi at ${pkgRoot} was not installed by abtars.\n` +
          `Remove it manually using Pi's documented uninstall instructions.`,
      };
    }

    const uninstallResult = spawnSync("npm", ["uninstall", "-g", "@earendil-works/pi-coding-agent"], {
      stdio: "pipe",
      shell: false,
      encoding: "utf-8",
    });

    if (uninstallResult.error || uninstallResult.status !== 0) {
      const msg = uninstallResult.error?.message ?? uninstallResult.stderr?.slice(0, 200) ?? `exit code ${uninstallResult.status}`;
      return { group: "pi", ok: false, error: msg };
    }

    clearPiCache();
    return { group: "pi", ok: true };
  } catch (err) {
    return { group: "pi", ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    releaseLock(token);
  }
}

// ── System dep helper ─────────────────────────────────────────────────────────

function printSystemDepHint(name: string): boolean {
  const sys = SYSTEM_DEPS[name];
  if (!sys) return false;
  process.stdout.write(
    `${name} is a system binary, not an npm package — abtars can't auto-install it.\n` +
    `Install it manually:\n  ${sys.installHint}\n`,
  );
  return true;
}

// ── Subcommands ───────────────────────────────────────────────────────────────

function list(): number {
  // Pi installation
  process.stdout.write("External distributions:\n\n");
  const piState = observePi();
  const piDesc = (() => {
    switch (piState.state) {
      case "compatible":
        return `✓ pi ${piState.version} (${piState.executable})`;
      case "unloadable":
        return `✗ pi ${piState.version ?? "?"}  —  installed but unloadable: ${piState.reason ?? "runtime module surface failed"}`;
      case "absent":
        return "○ pi  —  not installed";
      case "below-minimum":
        return `◐ pi ${piState.version ?? "?"}  —  below minimum ${PI_COMPATIBILITY.minimumPiVersion}`;
      case "incomplete":
        return `◐ pi ${piState.version ?? "?"}  —  incomplete installation`;
      case "invalid":
        return `✗ pi ${piState.version ?? "?"}  —  invalid installation`;
    }
  })();
  process.stdout.write(`  ${piDesc}\n`);
  process.stdout.write(`    minimum: ${PI_COMPATIBILITY.minimumPiVersion}\n`);
  if (piState.state === "compatible") {
    const inst = resolvePiInstallation({ useCache: true });
    if (inst.state === "compatible") {
      const m = inst.installation.moduleRoots;
      process.stdout.write(
        `    ai=${existsSync(m.ai) ? "present" : "absent"} ` +
        `tui=${existsSync(m.tui) ? "present" : "absent"} ` +
        `core=${existsSync(m.agentCore) ? "present" : "absent"}\n`,
      );
    }
  }

  process.stdout.write("\nSystem binaries (install manually — see hint):\n\n");
  for (const [name, dep] of Object.entries(SYSTEM_DEPS)) {
    if (dep.platform && dep.platform !== (process.platform === "darwin" ? "darwin" : "linux")) continue;
    const installed = spawnSync("which", [dep.bin], { stdio: "pipe" }).status === 0;
    const icon = installed ? "✓" : "○";
    const hint = installed ? "" : `  → ${dep.installHint}`;
    process.stdout.write(`  ${icon} ${name.padEnd(12)} ${dep.label}${hint}\n`);
  }

  process.stdout.write("\nNpm packages:\n\n");
  for (const [name, dep] of Object.entries(OPTIONAL_DEPS)) {
    const obs = observeGroup(name);
    const stateIcon: Record<GroupState, string> = {
      ready: "✓",
      absent: "○", partial: "◐", drifted: "◐",
      invalid: "✗",
    };
    const icon = stateIcon[obs.state];
    const versionParts = obs.packages.map(p => {
      if (p.observed.state === "absent") return `${p.name} —`;
      if (p.observed.state === "invalid") return `${p.name} ✗ (${p.observed.reason})`;
      return `${p.name} ${p.observed.version} (target ${p.target})`;
    });

    process.stdout.write(
      `  ${icon} ${name.padEnd(12)} ${dep.label}\n` +
      `         ${versionParts.join(", ")}\n`,
    );
  }

  process.stdout.write(
    `\nInstall: abtars deps install [name|all]  (default: native)\n` +
    `Update:  abtars deps update [name|all]   (refresh installed)\n` +
    `Remove:  abtars deps remove <name>\n`,
  );
  return 0;
}

function install(names: string[]): number {
  for (const n of names) {
    if (n !== "all" && SYSTEM_DEPS[n]) {
      printSystemDepHint(n);
      return 0;
    }
  }

  const hasPi = names.includes("pi") || names.includes("all");
  const onlyPi = names.length === 1 && names[0] === "pi";
  const npmNames = names.filter(n => n !== "pi");

  let failed = false;

  if (hasPi) {
    const piState = observePi();
    if (piState.state === "compatible") {
      process.stdout.write("✓ pi already installed\n");
    } else {
      const repairExisting = piState.state !== "absent";
      process.stdout.write(repairExisting ? "→ pi: repairing installation...\n" : "→ pi: installing...\n");
      const result = piInstall(repairExisting);
      if (result.ok) {
        process.stdout.write("✓ pi installed\n");
      } else {
        process.stdout.write(`✗ pi failed: ${result.error}\n`);
        failed = true;
      }
    }
  }

  // When only "pi" was requested, don't fall through to npm groups
  if (onlyPi) return failed ? 1 : 0;

  try {
    const actions = resolveGroupActions("install", npmNames);
    if (actions.length === 0 && !hasPi) {
      process.stdout.write("All selected groups already up to date.\n");
      return 0;
    }

    for (const action of actions) {
      const dep = OPTIONAL_DEPS[action.group];
      if (!dep) {
        if (printSystemDepHint(action.group)) continue;
        process.stdout.write(`Unknown dep: ${action.group}\n`);
        failed = true;
        continue;
      }

      process.stdout.write(`→ ${action.group}: ${action.reason}\n`);
      const result = mutateGroup(action, dep);
      if (result.ok) {
        process.stdout.write(`✓ ${action.group} installed\n`);
      } else {
        process.stdout.write(`✗ ${action.group} failed: ${result.error}\n`);
        failed = true;
      }
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  return failed ? 1 : 0;
}

function update(names: string[]): number {
  const hasPi = names.includes("pi") || names.includes("all") || names.length === 0;
  const onlyPi = names.length === 1 && names[0] === "pi";
  const npmNames = names.filter(n => n !== "pi");

  let failed = false;

  if (hasPi) {
    const piState = observePi();
    if (piState.state === "absent" && names.length === 0) {
      // bare `update` skips absent pi silently
    } else if (piState.state === "absent") {
      process.stdout.write("○ pi is not installed. Run 'abtars deps install pi' first.\n");
      failed = true;
    } else {
      process.stdout.write(`→ pi: updating...\n`);
      const result = piUpdate();
      if (result.ok) {
        process.stdout.write("✓ pi updated\n");
      } else {
        process.stdout.write(`✗ pi failed: ${result.error}\n`);
        failed = true;
      }
    }
  }

  // When only "pi" was requested, don't fall through to npm groups
  if (onlyPi) return failed ? 1 : 0;

  try {
    const actions = resolveGroupActions("update", npmNames);
    if (actions.length === 0) {
      if (!failed) process.stdout.write("No installed optional dependencies to update.\n");
      return failed ? 1 : 0;
    }

    for (const action of actions) {
      const dep = OPTIONAL_DEPS[action.group];
      if (!dep) {
        if (printSystemDepHint(action.group)) continue;
        process.stdout.write(`Unknown dep: ${action.group}\n`);
        failed = true;
        continue;
      }

      if (action.reason === "missing") {
        process.stdout.write(
          `○ ${action.group} is not installed. Run 'abtars deps install ${action.group}' first.\n`,
        );
        failed = true;
        continue;
      }

      process.stdout.write(`→ ${action.group}: ${action.reason}\n`);
      const result = mutateGroup(action, dep);
      if (result.ok) {
        process.stdout.write(`✓ ${action.group} updated\n`);
      } else {
        process.stdout.write(`✗ ${action.group} failed: ${result.error}\n`);
        failed = true;
      }
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  return failed ? 1 : 0;
}

function remove(names: string[]): number {
  if (names.length === 0) {
    process.stderr.write("Usage: abtars deps remove <name>\n");
    return 1;
  }

  let result = 0;

  for (const name of names) {
    if (name === "pi") {
      process.stdout.write("→ pi: removing...\n");
      const r = piRemove();
      if (r.ok) {
        process.stdout.write("✓ pi removed\n");
      } else {
        process.stderr.write(`✗ pi remove failed: ${r.error}\n`);
        result = 1;
      }
      continue;
    }

    const dep = OPTIONAL_DEPS[name];
    if (!dep) {
      if (printSystemDepHint(name)) continue;
      process.stderr.write(`Unknown dep: ${name}. Run 'abtars deps list'.\n`);
      result = 1;
      continue;
    }

    const token = generateLockToken();
    acquireLock("abtars", `remove:${name}`, token);
    try {
      const manifest = readManifest() ?? createEmptyManifest();
      const nm = resolveNmDir();
      for (const pkg of dep.packages) {
        const { manifest: updated, canDelete } = removeConsumer(manifest, pkg, "abtars");
        Object.assign(manifest, updated);
        const shouldDelete = canDelete || !manifest.packages[pkg];
        if (shouldDelete) {
          const p = join(nm, pkg);
          if (existsSync(p)) rmSync(p, { recursive: true });
        }
        process.stdout.write(
          shouldDelete
            ? `  ✓ ${pkg} deleted\n`
            : `  ○ ${pkg} kept (consumed by ${updated.packages[pkg]?.consumers.join(", ") ?? "?"})\n`,
        );
      }
      writeManifest(manifest);
      process.stdout.write(`✓ ${name} removed\n`);
    } catch (err) {
      process.stderr.write(`x ${name} remove failed: ${err instanceof Error ? err.message : String(err)}\n`);
      result = 1;
    } finally {
      releaseLock(token);
    }
  }
  return result;
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function deps(args: string[]): Promise<number> {
  await printBanner("deps");
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": return list();
    case "install": return install(args.slice(1));
    case "update": return update(args.slice(1));
    case "remove": return remove(args.slice(1));
    default:
      process.stderr.write(`Unknown: abtars deps ${sub}\nUsage: abtars deps [list|install|update|remove]\n`);
      return 1;
  }
}
