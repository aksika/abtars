/**
 * `abtars deps` — manage optional dependencies.
 */
import { OPTIONAL_DEPS, SYSTEM_DEPS, isInstalled, installPackages } from "../../utils/lazy-require.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { abtarsHome } from "../../paths.js";

function list(): number {
  process.stdout.write("Optional dependencies:\n\n");
  for (const [name, dep] of Object.entries(OPTIONAL_DEPS)) {
    const installed = dep.packages.every(p => isInstalled(p));
    const icon = installed ? "✓" : "○";
    process.stdout.write(`  ${icon} ${name.padEnd(12)} ${dep.label} (${dep.packages.join(", ")})\n`);
  }

  process.stdout.write("\nSystem dependencies:\n\n");
  for (const [name, dep] of Object.entries(SYSTEM_DEPS)) {
    if (dep.platform && dep.platform !== (process.platform === "darwin" ? "darwin" : "linux")) continue;
    const installed = spawnSync("which", [dep.bin], { stdio: "pipe" }).status === 0;
    const icon = installed ? "✓" : "○";
    const hint = installed ? "" : `  → ${dep.installHint}`;
    process.stdout.write(`  ${icon} ${name.padEnd(12)} ${dep.label}${hint}\n`);
  }

  process.stdout.write(`\nInstall: abtars deps install <name|all>\nRemove:  abtars deps remove <name>\n`);
  return 0;
}

function install(names: string[]): number {
  if (names.length === 0) {
    process.stderr.write("Usage: abtars deps install <name|all> [<name>...]\nRun 'abtars deps list' to see available.\n");
    return 1;
  }
  const targets = names.includes("all") ? Object.keys(OPTIONAL_DEPS) : names;
  for (const name of targets) {
    const dep = OPTIONAL_DEPS[name];
    if (!dep) {
      process.stderr.write(`Unknown dep: ${name}. Run 'abtars deps list'.\n`);
      return 1;
    }
    if (dep.packages.every(p => isInstalled(p))) {
      process.stdout.write(`✓ ${name} already installed\n`);
      continue;
    }
    process.stdout.write(`→ Installing ${dep.label} (${dep.packages.join(", ")})...\n`);
    try {
      installPackages(dep.packages);
      if (dep.postInstall) {
        process.stdout.write(`→ Running post-install: ${dep.postInstall}\n`);
        const libNm = join(abtarsHome(), "lib", "node_modules");
        spawnSync("npx", ["--prefix", join(abtarsHome(), "lib"), ...dep.postInstall.split(" ")], { stdio: "inherit", cwd: libNm });
      }
      process.stdout.write(`✓ ${name} installed\n`);
    } catch (err) {
      process.stderr.write(`✗ ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  return 0;
}

function remove(names: string[]): number {
  if (names.length === 0) {
    process.stderr.write("Usage: abtars deps remove <name>\n");
    return 1;
  }
  const libNm = join(abtarsHome(), "lib", "node_modules");
  for (const name of names) {
    const dep = OPTIONAL_DEPS[name];
    if (!dep) {
      process.stderr.write(`Unknown dep: ${name}\n`);
      return 1;
    }
    for (const pkg of dep.packages) {
      const p = join(libNm, pkg);
      if (existsSync(p)) rmSync(p, { recursive: true });
    }
    process.stdout.write(`✓ ${name} removed\n`);
  }
  return 0;
}

export async function deps(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": return list();
    case "install": return install(args.slice(1));
    case "remove": return remove(args.slice(1));
    case "update": return update();
    default:
      process.stderr.write(`Unknown: abtars deps ${sub}\nUsage: abtars deps [list|install|remove|update]\n`);
      return 1;
  }
}

function update(): number {
  process.stdout.write("Updating all npm dependencies...\n");
  const result = spawnSync("npm", ["update"], { cwd: join(abtarsHome(), "src", "abtars"), stdio: "inherit", encoding: "utf-8" });
  if (result.status !== 0) {
    process.stderr.write("npm update failed\n");
    return 1;
  }
  process.stdout.write("✓ Dependencies updated\n");
  return 0;
}
