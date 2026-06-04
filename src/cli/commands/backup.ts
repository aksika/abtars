/**
 * `abtars backup` — orchestrates abmind encrypted backup + abtars config zip.
 * Produces two files in ~/.backup-abtars/:
 *   abtars-YYYY-MM-DD.zip  — config, skills, workspace (plaintext)
 *   abmind-YYYY-MM-DD.abm  — encrypted memory (via abmind backup)
 */

import { existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { abtarsHome } from "../../paths.js";

const AB_SAVE = ["config", "secret", "tasks", "logo", "workspace", "skills/custom", "skills/self"];
const DEFAULT_PRUNE_DAYS = 7;

export async function backup(outputDir?: string, pruneDays?: number): Promise<number> {
  const abHome = abtarsHome();
  const date = new Date().toISOString().slice(0, 10);
  const destDir = outputDir ?? join(dirname(abHome), ".backup-abtars");
  mkdirSync(destDir, { recursive: true });

  // 1. Run abmind backup (encrypted .abm)
  const abmindPaths = [
    join(dirname(abHome), ".abmind", "lib", "node_modules", "abmind", "dist", "cli", "abmind-backup.js"),
    join(dirname(abHome), "workspace", "ab", "abmind", "dist", "cli", "abmind-backup.js"),
  ];
  const abmindBin = abmindPaths.find(p => existsSync(p));
  let abmResult: ReturnType<typeof spawnSync>;
  if (abmindBin) {
    abmResult = spawnSync("node", [abmindBin], { encoding: "utf-8", env: { ...process.env } });
  } else {
    abmResult = spawnSync("abmind", ["backup"], { encoding: "utf-8", env: { ...process.env } });
  }

  if (abmResult.status !== 0) {
    process.stderr.write(`⚠️ abmind backup failed: ${abmResult.stderr || abmResult.stdout}\n`);
    return 1;
  }

  // Find the .abm file produced (latest in ~/.abmind/backups/)
  const abmindBackupsDir = join(dirname(abHome), ".abmind", "backups");
  let abmFile: string | undefined;
  if (existsSync(abmindBackupsDir)) {
    const abmFiles = readdirSync(abmindBackupsDir)
      .filter(f => f.endsWith(".abm"))
      .sort()
      .reverse();
    if (abmFiles.length > 0) abmFile = abmFiles[0];
  }

  if (abmFile) {
    const src = join(abmindBackupsDir, abmFile);
    const dest = join(destDir, `abmind-${date}.abm`);
    renameSync(src, dest);
    const size = (statSync(dest).size / 1024).toFixed(0);
    process.stdout.write(`✓ abmind-${date}.abm (${size}KB, encrypted)\n`);
  } else {
    process.stderr.write(`⚠️ abmind backup produced no .abm file\n`);
  }

  // 2. Zip abtars config (plaintext — not sensitive)
  const files: Array<{ absPath: string; zipPath: string }> = [];
  for (const dir of AB_SAVE) {
    const abs = join(abHome, dir);
    if (existsSync(abs)) collectDir(abs, dir, files);
  }

  if (files.length === 0) {
    process.stderr.write("Nothing to zip from abtars.\n");
    return 1;
  }

  const tmpDir = join(process.env["TMPDIR"] ?? "/tmp", `abtars-backup-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  for (const f of files) {
    const dest = join(tmpDir, f.zipPath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.absPath, dest);
  }

  const zipPath = join(destDir, `abtars-${date}.zip`);
  const has7z = spawnSync("which", ["7z"], { encoding: "utf-8" }).status === 0;

  let zipOk: boolean;
  if (has7z) {
    const r = spawnSync("7z", ["a", zipPath.replace(/\.zip$/, ".7z"), "."], { cwd: tmpDir, encoding: "utf-8" });
    zipOk = r.status === 0;
  } else {
    const r = spawnSync("zip", ["-r", zipPath, "."], { cwd: tmpDir, encoding: "utf-8" });
    zipOk = r.status === 0;
  }

  spawnSync("rm", ["-rf", tmpDir]);

  if (!zipOk) {
    process.stderr.write(`⚠️ zip/7z failed\n`);
    return 1;
  }

  const actualZip = has7z ? zipPath.replace(/\.zip$/, ".7z") : zipPath;
  const sizeMb = (statSync(actualZip).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`✓ ${actualZip.split("/").pop()} (${sizeMb}MB, ${files.length} files)\n`);

  // 3. Prune old backups
  const maxAge = (pruneDays ?? DEFAULT_PRUNE_DAYS) * 86_400_000;
  const now = Date.now();
  for (const f of readdirSync(destDir)) {
    if (!(f.startsWith("abtars-") || f.startsWith("abmind-"))) continue;
    if (!(f.endsWith(".zip") || f.endsWith(".7z") || f.endsWith(".abm"))) continue;
    const fPath = join(destDir, f);
    try {
      if (now - statSync(fPath).mtimeMs > maxAge) {
        unlinkSync(fPath);
        process.stdout.write(`  🗑 pruned ${f}\n`);
      }
    } catch { /* skip */ }
  }

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
