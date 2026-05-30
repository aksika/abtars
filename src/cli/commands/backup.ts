/**
 * `abtars backup` — zip config + data from both abtars and abmind.
 * Uses SQLite db.backup() for WAL-safe memory.db copy.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { abtarsHome } from "../../paths.js";

const AB_SAVE = ["config", "skills", "prompts", "core", "secret", "tasks", "logo", "workspace"];
const ABMIND_SAVE = ["config", "prompts", "secret"];
const ABMIND_MEMORY_SAVE = ["core", "weekly"]; // subdirs of memory/ to include

export async function backup(outputDir?: string): Promise<number> {
  const abHome = abtarsHome();
  const abmindHome = process.env["ABMIND_HOME"] ?? join(dirname(abHome), ".abmind");
  const timestamp = new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "");
  const zipName = `abtars-backup-${timestamp}.zip`;
  const destDir = outputDir ?? process.cwd();
  mkdirSync(destDir, { recursive: true });
  const zipPath = join(destDir, zipName);

  // Collect files to zip
  const files: Array<{ absPath: string; zipPath: string }> = [];

  // abtars dirs
  for (const dir of AB_SAVE) {
    const abs = join(abHome, dir);
    if (existsSync(abs)) collectDir(abs, `abtars/${dir}`, files);
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

  // abmind memory/ loose files (garbage.json, watermarks, etc.)
  const memDir = join(abmindHome, "memory");
  if (existsSync(memDir)) {
    for (const entry of readdirSync(memDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name !== "memory.db" && !entry.name.endsWith("-wal") && !entry.name.endsWith("-shm")) {
        files.push({ absPath: join(memDir, entry.name), zipPath: `abmind/memory/${entry.name}` });
      }
    }
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
  const tmpDir = join(process.env["TMPDIR"] ?? "/tmp", `abtars-backup-${Date.now()}`);
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
