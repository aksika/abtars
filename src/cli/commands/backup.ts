/**
 * `agentbridge backup` — zip config + data from both agentbridge and abmind.
 * Uses SQLite db.backup() for WAL-safe memory.db copy.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { agentBridgeHome } from "../../paths.js";

const AB_SAVE = ["config", "skills", "prompts", "core", "secret", "tasks", "logo"];
const ABMIND_SAVE = ["config", "prompts", "secret"];
const ABMIND_MEMORY_SAVE = ["core"]; // subdirs of memory/ to include

export async function backup(): Promise<number> {
  const abHome = agentBridgeHome();
  const abmindHome = process.env["ABMIND_HOME"] ?? join(dirname(abHome), ".abmind");
  const timestamp = new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "");
  const zipName = `agentbridge-backup-${timestamp}.zip`;
  const zipPath = join(process.cwd(), zipName);

  // Collect files to zip
  const files: Array<{ absPath: string; zipPath: string }> = [];

  // agentbridge dirs
  for (const dir of AB_SAVE) {
    const abs = join(abHome, dir);
    if (existsSync(abs)) collectDir(abs, `agentbridge/${dir}`, files);
  }

  // abmind dirs
  for (const dir of ABMIND_SAVE) {
    const abs = join(abmindHome, dir);
    if (existsSync(abs)) collectDir(abs, `abmind/${dir}`, files);
  }

  // abmind memory/core/
  for (const dir of ABMIND_MEMORY_SAVE) {
    const abs = join(abmindHome, "memory", dir);
    if (existsSync(abs)) collectDir(abs, `abmind/memory/${dir}`, files);
  }

  // abmind memory.db — WAL-safe backup via sqlite3 CLI
  const dbPath = join(abmindHome, "memory", "memory.db");
  if (existsSync(dbPath)) {
    const tmpDb = join(process.env["TMPDIR"] ?? "/tmp", `abmind-backup-${Date.now()}.db`);
    const result = spawnSync("sqlite3", [dbPath, `.backup '${tmpDb}'`], { encoding: "utf-8" });
    if (result.status === 0 && existsSync(tmpDb)) {
      files.push({ absPath: tmpDb, zipPath: "abmind/memory/memory.db" });
    } else {
      process.stderr.write(`⚠️ SQLite backup failed — copying raw (may be incomplete if bridge is running)\n`);
      files.push({ absPath: dbPath, zipPath: "abmind/memory/memory.db" });
    }
  }

  if (files.length === 0) {
    process.stderr.write("Nothing to backup.\n");
    return 1;
  }

  // Create zip using system zip command
  const tmpDir = join(process.env["TMPDIR"] ?? "/tmp", `agentbridge-backup-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  for (const f of files) {
    const dest = join(tmpDir, f.zipPath);
    mkdirSync(dirname(dest), { recursive: true });
    const { copyFileSync } = await import("node:fs");
    copyFileSync(f.absPath, dest);
  }

  const zipResult = spawnSync("zip", ["-r", zipPath, "."], { cwd: tmpDir, encoding: "utf-8" });

  // Cleanup temp dir
  spawnSync("rm", ["-rf", tmpDir]);

  if (zipResult.status !== 0) {
    process.stderr.write(`zip failed: ${zipResult.stderr}\n`);
    return 1;
  }

  const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`✓ ${zipName} (${sizeMb}MB, ${files.length} files)\n`);
  return 0;
}

function collectDir(dir: string, prefix: string, out: Array<{ absPath: string; zipPath: string }>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collectDir(abs, rel, out);
    } else if (entry.isFile()) {
      out.push({ absPath: abs, zipPath: rel });
    }
  }
}
