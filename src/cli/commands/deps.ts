import { printBanner } from './banner.js';
/**
 * `abtars deps` — manage optional dependencies.
 *
 * install = ensure listed groups are present at their declared target (reuse ready ones).
 * update  = refresh installed groups (always mutates, even if version matches).
 * remove  = deletes package and removes consumer from shared manifest.
 *
 * #1388: All shared-root mutations go through the native-deps lock + manifest
 * to prevent concurrent corruption and track consumers for safe uninstall.
 */
import { OPTIONAL_DEPS, SYSTEM_DEPS } from "../../utils/lazy-require.js";
import { PI_COMPATIBILITY } from "../../config/pi-compatibility.js";
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

// ── Shared prefix paths ───────────────────────────────────────────────────────

function libDir(): string {
  return join(homedir(), ".local", "lib");
}

function resolveNmDir(): string {
  return process.env['ABTARS_NM'] ?? join(homedir(), '.local', 'lib', 'node_modules');
}

// ── Package observation ───────────────────────────────────────────────────────

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

export function observeGroup(name: string): GroupObservation {
  const dep = OPTIONAL_DEPS[name];
  if (!dep) throw new Error(`Unknown dep group: ${name}`);

  const piKey = piGroupKey(name);
  const packages = dep.packages.map(pkg => {
    const target = piKey ? PI_COMPATIBILITY.packages[piKey].version : (dep.version ?? "latest");
    return { name: pkg, target, observed: observePackage(pkg) };
  });

  const absent = packages.every(p => p.observed.state === "absent");
  // For groups without a version pin, "ready" means all packages are installed
  // (any version is acceptable — the group has no declared target).
  const hasVersionPin = !!dep.version || piKey !== null;
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

/** Map OPTIONAL_DEPS group name to PI_COMPATIBILITY key, if applicable. */
function piGroupKey(name: string): "ai" | "tui" | null {
  if (name === "provider") return "ai";
  if (name === "tui") return "tui";
  return null;
}

// ── Pure target resolver ──────────────────────────────────────────────────────

export function resolveGroupActions(
  operation: DependencyOperation,
  requestedNames: string[],
): GroupAction[] {
  // Validate first (system deps are handled by callers)
  for (const n of requestedNames) {
    if (n === "all") continue;
    if (!OPTIONAL_DEPS[n] && !SYSTEM_DEPS[n]) throw new Error(`Unknown dep group: ${n}. Run 'abtars deps list'.`);
  }
  // Filter out system deps — callers (install/update) handle them
  const effectiveNames = requestedNames.filter(n => n === "all" || OPTIONAL_DEPS[n]);

  const allGroups = Object.keys(OPTIONAL_DEPS);
  let selected: string[];

  if (effectiveNames.length === 0) {
    selected = operation === "install" ? ["native"] : allGroups;
  } else if (effectiveNames.includes("all")) {
    if (effectiveNames.length > 1) throw new Error("Cannot combine 'all' with other names.");
    selected = allGroups;
  } else {
    selected = [...new Set(effectiveNames)];
  }

  const actions: GroupAction[] = [];
  for (const name of selected) {
    const obs = observeGroup(name);

    // Update silently skips wholly absent groups unless explicitly named.
    const explicitlyNamed = effectiveNames.length > 0 && !effectiveNames.includes("all");
    if (operation === "update" && obs.state === "absent" && !explicitlyNamed) continue;

    switch (obs.state) {
      case "absent":
        actions.push({ group: name, reason: "missing" });
        break;
      case "partial":
        actions.push({ group: name, reason: "partial" });
        break;
      case "invalid":
        actions.push({ group: name, reason: "invalid" });
        break;
      case "drifted":
        actions.push({ group: name, reason: "drifted" });
        break;
      case "ready":
        if (operation === "update") actions.push({ group: name, reason: "refresh" });
        break;
    }
  }

  return actions;
}

// ── Mutation engine ───────────────────────────────────────────────────────────

type MutationResult = { group: string; ok: boolean; error?: string };

function versionedArg(pkg: string, dep: (typeof OPTIONAL_DEPS)[string], piKey: "ai" | "tui" | null): string {
  if (piKey) return `${pkg}@${PI_COMPATIBILITY.packages[piKey].version}`;
  if (dep.version) return `${pkg}@${dep.version}`;
  return pkg;
}

function mutateGroup(action: GroupAction, dep: (typeof OPTIONAL_DEPS)[string]): MutationResult {
  const token = generateLockToken();
  acquireLock("abtars", `${action.reason === "refresh" ? "update" : "install"}:${action.group}`, token);
  try {
    const piKey = piGroupKey(action.group);
    const args: string[] = ["install", "--prefix", libDir(), "--no-audit", "--no-fund"];
    for (const pkg of dep.packages) {
      args.push(versionedArg(pkg, dep, piKey));
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

    // Post-install hook
    if (dep.postInstall) {
      const pi = spawnSync("npx", [...dep.postInstall.split(" ")], {
        stdio: "inherit",
        shell: false,
      });
      if (pi.status !== 0) {
        return { group: action.group, ok: false, error: `post-install failed (exit ${pi.status})` };
      }
    }

    // Verify
    const obs = observeGroup(action.group);
    if (obs.state !== "ready") {
      return { group: action.group, ok: false, error: `verification failed: state=${obs.state}` };
    }

    // Track consumer
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
  process.stdout.write("System binaries (install manually — see hint):\n\n");
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
    `\nNpm packages auto-install. System binaries do NOT.\n\n` +
    `Install: abtars deps install [name|all]  (default: native)\n` +
    `Update:  abtars deps update [name|all]   (refresh installed)\n` +
    `Remove:  abtars deps remove <name>\n`,
  );
  return 0;
}

function install(names: string[]): number {
  // Handle system deps before calling resolver
  for (const n of names) {
    if (n !== "all" && SYSTEM_DEPS[n]) {
      printSystemDepHint(n);
      return 0;
    }
  }
  try {
    const actions = resolveGroupActions("install", names);
    if (actions.length === 0) {
      process.stdout.write("All selected groups already up to date.\n");
      return 0;
    }

    let failed = false;
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
    return failed ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function update(names: string[]): number {
  try {
    const actions = resolveGroupActions("update", names);
    if (actions.length === 0) {
      process.stdout.write("No installed optional dependencies to update.\n");
      return 0;
    }

    let failed = false;
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
    return failed ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function remove(names: string[]): number {
  if (names.length === 0) {
    process.stderr.write("Usage: abtars deps remove <name>\n");
    return 1;
  }
  let result = 0;
  for (const name of names) {
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
