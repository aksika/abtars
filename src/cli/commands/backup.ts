/**
 * `abtars backup` — full or config-only backup with optional encryption.
 *
 * Full (default): zip ~/.abtars/ (minus binaries/runtime) + encrypted .abm via `abmind backup`
 * Config:         zip config dirs only (config/, secret/, tasks/, skills/, kanban/, metrics/, auth/)
 *
 * Flags: --full (default), --config, --encrypt, --output <dir>, --prune-days N
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { abtarsHome, abmindHome as resolveAbmindHome } from "../../paths.js";

const DEFAULT_PRUNE_DAYS = 7;

const ABTARS_EXCLUDE = [
  "logs", "overflow", "browser-socket", "app", "app/*", "bin", "bin/*", "bridge.lock", "*.sock",
  "*.db-wal", "*.db-shm",
];

const CONFIG_DIRS = ["config", "secret", "tasks", "skills", "kanban", "metrics", "auth"];

export interface BackupOpts {
  config?: boolean;
  encrypt?: boolean;
  outputDir?: string;
  pruneDays?: number;
}

function timestamp(): string {
  const now = new Date();
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  const t = now.toTimeString().slice(0, 5).replace(":", "");
  return `${d}-${t}`;
}

export async function backup(opts: BackupOpts = {}): Promise<number> {
  const abHome = abtarsHome();
  const abmindHome = resolveAbmindHome();
  const ts = timestamp();
  const destDir = opts.outputDir ?? join(dirname(abHome), ".backup-abtars");
  mkdirSync(destDir, { recursive: true });

  const isConfig = opts.config === true;
  const prefix = isConfig ? `abtars-config-${ts}` : `abtars-${ts}`;

  // 1. Create the zip (abtars state only)
  const has7z = spawnSync("which", ["7z"], { encoding: "utf-8" }).status === 0;
  const zipExt = has7z ? ".7z" : ".zip";
  let zipPath = join(destDir, prefix + zipExt);

  let zipOk: boolean;

  if (isConfig) {
    const existingDirs = CONFIG_DIRS.filter(d => existsSync(join(abHome, d)));
    if (existingDirs.length === 0) {
      process.stderr.write("Nothing to backup — no config dirs found\n");
      return 1;
    }
    if (has7z) {
      const r = spawnSync("7z", ["a", zipPath, ...existingDirs], { cwd: abHome, encoding: "utf-8" });
      zipOk = r.status === 0;
    } else {
      const r = spawnSync("zip", ["-qr", zipPath, ...existingDirs], { cwd: abHome, encoding: "utf-8" });
      zipOk = r.status === 0;
    }
  } else {
    if (has7z) {
      const excludeArgs = ABTARS_EXCLUDE.flatMap(ex => ["-xr!" + ex]);
      const r = spawnSync("7z", ["a", zipPath, ".", ...excludeArgs], { cwd: abHome, encoding: "utf-8" });
      zipOk = r.status === 0;
    } else {
      const excludePatterns = ABTARS_EXCLUDE.flatMap(ex => [`${ex}/*`, ex]);
      const r = spawnSync("zip", ["-qr", zipPath, ".", "-x", ...excludePatterns], { cwd: abHome, encoding: "utf-8" });
      zipOk = r.status === 0;
    }
  }

  if (!zipOk) {
    process.stderr.write("Backup zip failed\n");
    return 1;
  }

  if (!isConfig) {
    const actual = statSync(zipPath).size;
    if (actual < 100_000) {
      process.stderr.write(`⚠️ Backup suspiciously small (${actual} bytes)\n`);
    }
  }

  const zipSize = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`✓ ${basename(zipPath)} (${zipSize}MB)\n`);

  // 2. Encrypt zip if requested
  if (opts.encrypt) {
    const encPath = zipPath + ".enc";
    const ok = encryptFile(zipPath, encPath, abmindHome);
    if (!ok) return 1;
    unlinkSync(zipPath);
    zipPath = encPath;
    process.stdout.write(`✓ encrypted → ${basename(encPath)}\n`);
  }

  // 3. Run abmind backup (produces encrypted .abm with all memory data)
  if (!isConfig) {
    const abmResult = runAbmindBackup(abmindHome);
    if (abmResult) {
      const dest = join(destDir, basename(abmResult));
      renameSync(abmResult, dest);
      const size = (statSync(dest).size / 1024).toFixed(0);
      process.stdout.write(`✓ ${basename(dest)} (${size}KB)\n`);
    } else {
      process.stderr.write("⚠️ abmind backup failed or produced no .abm\n");
    }
  }

  // 4. Prune old backups
  const pruneDays = opts.pruneDays ?? DEFAULT_PRUNE_DAYS;
  if (pruneDays > 0) {
    const maxAge = pruneDays * 86_400_000;
    const now = Date.now();
    for (const f of readdirSync(destDir)) {
      if (!(f.startsWith("abtars-") || f.startsWith("abmind-"))) continue;
      if (!(f.endsWith(".zip") || f.endsWith(".7z") || f.endsWith(".abm") || f.endsWith(".enc"))) continue;
      const fPath = join(destDir, f);
      try {
        if (now - statSync(fPath).mtimeMs > maxAge) {
          unlinkSync(fPath);
        }
      } catch { /* skip */ }
    }
  }

  return 0;
}

function runAbmindBackup(abmindHome: string): string | null {
  const backupsDir = join(abmindHome, "backups");
  mkdirSync(backupsDir, { recursive: true });

  const result = spawnSync("abmind", ["backup"], { encoding: "utf-8", env: { ...process.env } });
  if (result.status !== 0) return null;

  const abmFiles = readdirSync(backupsDir).filter(f => f.endsWith(".abm")).sort().reverse();
  return abmFiles[0] ? join(backupsDir, abmFiles[0]) : null;
}

function encryptFile(inputPath: string, outputPath: string, abmindHome: string): boolean {
  const keyPath = join(abmindHome, "secret", "abmind.key");
  if (!existsSync(keyPath)) {
    process.stderr.write(`⚠️ --encrypt requires ${keyPath}\n`);
    return false;
  }
  const master = Buffer.from(readFileSync(keyPath, "utf-8").trim(), "hex");
  const key = Buffer.from(hkdfSync("sha256", master, "", "abtars-backup-v1", 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const input = readFileSync(inputPath);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = Buffer.concat([iv, encrypted, tag]);
  writeFileSync(outputPath, out);
  return true;
}
