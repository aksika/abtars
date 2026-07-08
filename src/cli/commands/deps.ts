import { printBanner } from './banner.js';
/**
 * `abtars deps` — manage optional dependencies.
 *
 * install = always fresh install (rm + npm install). Default for setup.
 * update  = skip if already installed (version-aware in future via manifest).
 */
import { OPTIONAL_DEPS, SYSTEM_DEPS, isInstalled, installPackages } from "../../utils/lazy-require.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolveReleasesDir } from "../deploy-lib/paths.js";

function resolveNmDir(): string {
  return process.env['ABTARS_NM'] ?? join(homedir(), '.local', 'lib', 'node_modules');
}

function list(): number {
  process.stdout.write("System binaries (install manually — see hint):\n\n");
  for (const [name, dep] of Object.entries(SYSTEM_DEPS)) {
    if (dep.platform && dep.platform !== (process.platform === "darwin" ? "darwin" : "linux")) continue;
    const installed = spawnSync("which", [dep.bin], { stdio: "pipe" }).status === 0;
    const icon = installed ? "✓" : "○";
    const hint = installed ? "" : `  → ${dep.installHint}`;
    process.stdout.write(`  ${icon} ${name.padEnd(12)} ${dep.label}${hint}\n`);
  }

  process.stdout.write("\nNpm packages (auto-install via 'abtars deps install <name>'):\n\n");
  for (const [name, dep] of Object.entries(OPTIONAL_DEPS)) {
    const installed = dep.packages.every(p => isInstalled(p));
    const icon = installed ? "✓" : "○";
    process.stdout.write(`  ${icon} ${name.padEnd(12)} ${dep.label} (${dep.packages.join(", ")})\n`);
  }

  process.stdout.write(
    `\nNpm packages install automatically. System binaries do NOT — 'install <binary>'\n` +
    `prints the upstream install command to run yourself.\n\n` +
    `Install: abtars deps install [name|all]  (default: native)\n` +
    `Update:  abtars deps update [name|all]   (skip if present)\n` +
    `Remove:  abtars deps remove <name>\n`,
  );
  return 0;
}

/**
 * If `name` is a system binary (ollama, bwrap, lightpanda), print its manual
 * install hint and return true. These are NOT npm-auto-installable — abtars
 * only points at the upstream installer. Returns false if `name` is unknown.
 */
function printSystemDepHint(name: string): boolean {
  const sys = SYSTEM_DEPS[name];
  if (!sys) return false;
  process.stdout.write(
    `${name} is a system binary, not an npm package — abtars can't auto-install it.\n` +
    `Install it manually:\n  ${sys.installHint}\n`,
  );
  return true;
}

function install(names: string[]): number {
  const targets = names.length === 0 ? ["native"] : names.includes("all")
    ? Object.keys(OPTIONAL_DEPS)
    : names;
  for (const name of targets) {
    const dep = OPTIONAL_DEPS[name];
    if (!dep) {
      // System binaries (ollama, bwrap, lightpanda) aren't npm-installable —
      // print the manual hint instead of a dead-end "Unknown dep".
      if (printSystemDepHint(name)) return 0;
      process.stderr.write(`Unknown dep: ${name}. Run 'abtars deps list'.\n`);
      return 1;
    }
    // Always remove + reinstall
    const nm = resolveNmDir();
    for (const pkg of dep.packages) {
      const p = join(nm, pkg);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    process.stdout.write(`→ Installing ${dep.label} (${dep.packages.join(", ")})...\n`);
    try {
      installPackages(dep.packages.map(p => `${p}${dep.version ? "@" + dep.version : ""}`));
      if (dep.postInstall) {
        process.stdout.write(`  post-install: ${dep.postInstall}\n`);
        spawnSync("npx", ["--prefix", join(resolveReleasesDir(), "deps"), ...dep.postInstall.split(" ")], { stdio: "inherit" });
      }
      process.stdout.write(`✓ ${name} installed\n`);
    } catch (err) {
      process.stderr.write(`x ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  return 0;
}

function update(names: string[]): number {
  const targets = names.length === 0 || names.includes("all") ? Object.keys(OPTIONAL_DEPS) : names;
  let skipped = 0;
  for (const name of targets) {
    const dep = OPTIONAL_DEPS[name];
    if (!dep) {
      if (printSystemDepHint(name)) return 0;
      process.stderr.write(`Unknown dep: ${name}. Run 'abtars deps list'.\n`);
      return 1;
    }
    if (dep.packages.every(p => isInstalled(p))) {
      skipped++;
      continue;
    }
    process.stdout.write(`→ Installing ${dep.label} (${dep.packages.join(", ")})...\n`);
    try {
      installPackages(dep.packages.map(p => `${p}${dep.version ? "@" + dep.version : ""}`));
      if (dep.postInstall) {
        process.stdout.write(`  post-install: ${dep.postInstall}\n`);
        spawnSync("npx", ["--prefix", join(resolveReleasesDir(), "deps"), ...dep.postInstall.split(" ")], { stdio: "inherit" });
      }
      process.stdout.write(`✓ ${name} installed\n`);
    } catch (err) {
      process.stderr.write(`x ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (skipped === targets.length) process.stdout.write("All deps up to date.\n");
  return 0;
}

function remove(names: string[]): number {
  if (names.length === 0) {
    process.stderr.write("Usage: abtars deps remove <name>\n");
    return 1;
  }
  const nm = resolveNmDir();
  for (const name of names) {
    const dep = OPTIONAL_DEPS[name];
    if (!dep) {
      process.stderr.write(`Unknown dep: ${name}\n`);
      return 1;
    }
    for (const pkg of dep.packages) {
      const p = join(nm, pkg);
      if (existsSync(p)) rmSync(p, { recursive: true });
    }
    process.stdout.write(`✓ ${name} removed\n`);
  }
  return 0;
}

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
