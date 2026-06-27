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

function libNmDir(): string {
  return join(homedir(), ".local", "lib", "node_modules");
}

function list(): number {
  process.stdout.write("External binaries:\n\n");
  for (const [name, dep] of Object.entries(SYSTEM_DEPS)) {
    if (dep.platform && dep.platform !== (process.platform === "darwin" ? "darwin" : "linux")) continue;
    const installed = spawnSync("which", [dep.bin], { stdio: "pipe" }).status === 0;
    const icon = installed ? "✓" : "○";
    const hint = installed ? "" : `  → ${dep.installHint}`;
    process.stdout.write(`  ${icon} ${name.padEnd(12)} ${dep.label}${hint}\n`);
  }

  process.stdout.write("\nNpm packages (auto-installable):\n\n");
  for (const [name, dep] of Object.entries(OPTIONAL_DEPS)) {
    const installed = dep.packages.every(p => isInstalled(p));
    const icon = installed ? "✓" : "○";
    process.stdout.write(`  ${icon} ${name.padEnd(12)} ${dep.label} (${dep.packages.join(", ")})\n`);
  }

  process.stdout.write(`\nInstall: abtars deps install <name|all>  (fresh, always reinstall)\nUpdate:  abtars deps update [name|all]   (skip if present)\nRemove:  abtars deps remove <name>\n`);
  return 0;
}

function install(names: string[]): number {
  if (names.length === 0) {
    process.stderr.write("Usage: abtars deps install <name|all>\nRun 'abtars deps list' to see available.\n");
    return 1;
  }
  const targets = names.includes("all") ? Object.keys(OPTIONAL_DEPS) : names;
  for (const name of targets) {
    const dep = OPTIONAL_DEPS[name];
    if (!dep) {
      process.stderr.write(`Unknown dep: ${name}. Run 'abtars deps list'.\n`);
      return 1;
    }
    // Always remove + reinstall
    const nm = libNmDir();
    for (const pkg of dep.packages) {
      const p = join(nm, pkg);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    process.stdout.write(`→ Installing ${dep.label} (${dep.packages.join(", ")})...\n`);
    try {
      installPackages(dep.packages);
      if (dep.postInstall) {
        process.stdout.write(`  post-install: ${dep.postInstall}\n`);
        spawnSync("npx", ["--prefix", join(homedir(), ".abtars-releases", "deps"), ...dep.postInstall.split(" ")], { stdio: "inherit" });
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
      process.stderr.write(`Unknown dep: ${name}. Run 'abtars deps list'.\n`);
      return 1;
    }
    if (dep.packages.every(p => isInstalled(p))) {
      skipped++;
      continue;
    }
    process.stdout.write(`→ Installing ${dep.label} (${dep.packages.join(", ")})...\n`);
    try {
      installPackages(dep.packages);
      if (dep.postInstall) {
        process.stdout.write(`  post-install: ${dep.postInstall}\n`);
        spawnSync("npx", ["--prefix", join(homedir(), ".abtars-releases", "deps"), ...dep.postInstall.split(" ")], { stdio: "inherit" });
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
  const nm = libNmDir();
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
