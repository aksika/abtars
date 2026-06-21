/**
 * `abtars backup` — full or config-only backup.
 *
 * Full (default): abtars zip + abmind zip (filesystem + encrypted DB inside)
 * Config:         abtars config dirs only, no abmind
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

const ABMIND_EXCLUDE = [
  "lib", "node_modules", "backups", "working", "*.sock", "*.db-wal", "*.db-shm",
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
  const has7z = spawnSync("which", ["7z"], { encoding: "utf-8" }).status === 0;
  const zipExt = has7z ? ".7z" : ".zip";

  // 1. Zip abtars state
  const abtarsPrefix = isConfig ? `abtars-config-${ts}` : `abtars-${ts}`;
  const abtarsZip = join(destDir, abtarsPrefix + zipExt);
  let zipOk: boolean;

  if (isConfig) {
    const existingDirs = CONFIG_DIRS.filter(d => existsSync(join(abHome, d)));
    if (existingDirs.length === 0) {
      process.stderr.write("Nothing to backup — no config dirs found\n");
      return 1;
    }
    if (has7z) {
      zipOk = spawnSync("7z", ["a", abtarsZip, ...existingDirs], { cwd: abHome, encoding: "utf-8" }).status === 0;
    } else {
      zipOk = spawnSync("zip", ["-qr", abtarsZip, ...existingDirs], { cwd: abHome, encoding: "utf-8" }).status === 0;
    }
  } else {
    if (has7z) {
      const excludeArgs = ABTARS_EXCLUDE.flatMap(ex => ["-xr!" + ex]);
      zipOk = spawnSync("7z", ["a", abtarsZip, ".", ...excludeArgs], { cwd: abHome, encoding: "utf-8" }).status === 0;
    } else {
      const excludePatterns = ABTARS_EXCLUDE.flatMap(ex => [`${ex}/*`, ex]);
      zipOk = spawnSync("zip", ["-qr", abtarsZip, ".", "-x", ...excludePatterns], { cwd: abHome, encoding: "utf-8" }).status === 0;
    }
  }

  if (!zipOk) {
    process.stderr.write("abtars zip failed\n");
    return 1;
  }

  const abtarsSize = (statSync(abtarsZip).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`✓ ${basename(abtarsZip)} (${abtarsSize}MB)\n`);

  // 2. abmind backup (always runs abmind backup --database, full wraps it in a zip)
  if (!isConfig && existsSync(abmindHome)) {
    const abmFile = runAbmindDbBackup(abmindHome);
    if (!abmFile) {
      process.stderr.write("⚠️ abmind backup --database failed\n");
    } else {
      // Full: zip abmind filesystem + include the .abm inside
      const abmindZip = join(destDir, `abmind-${ts}${zipExt}`);
      if (has7z) {
        const excludeArgs = ABMIND_EXCLUDE.flatMap(ex => ["-xr!" + ex]);
        spawnSync("7z", ["a", abmindZip, ".", ...excludeArgs], { cwd: abmindHome, encoding: "utf-8" });
        spawnSync("7z", ["a", abmindZip, abmFile], { encoding: "utf-8" });
      } else {
        const excludePatterns = ABMIND_EXCLUDE.flatMap(ex => [`${ex}/*`, ex]);
        spawnSync("zip", ["-qr", abmindZip, ".", "-x", ...excludePatterns], { cwd: abmindHome, encoding: "utf-8" });
        spawnSync("zip", ["-qj", abmindZip, abmFile], { encoding: "utf-8" });
      }
      // Clean up the standalone .abm (it's inside the zip now)
      try { unlinkSync(abmFile); } catch { /* ignore */ }

      if (existsSync(abmindZip)) {
        const size = (statSync(abmindZip).size / 1024 / 1024).toFixed(1);
        process.stdout.write(`✓ ${basename(abmindZip)} (${size}MB)\n`);
      } else {
        process.stderr.write("⚠️ abmind zip failed\n");
      }
    }
  }

  // 3. Encrypt abtars zip if requested
  if (opts.encrypt) {
    const encPath = abtarsZip + ".enc";
    const ok = encryptFile(abtarsZip, encPath, abmindHome);
    if (!ok) return 1;
    unlinkSync(abtarsZip);
    process.stdout.write(`✓ encrypted → ${basename(encPath)}\n`);
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
        if (now - statSync(fPath).mtimeMs > maxAge) unlinkSync(fPath);
      } catch { /* skip */ }
    }
  }

  return 0;
}

function runAbmindDbBackup(abmindHome: string): string | null {
  const backupsDir = join(abmindHome, "backups");
  mkdirSync(backupsDir, { recursive: true });

  const result = spawnSync("abmind", ["backup", "--database"], { encoding: "utf-8", env: { ...process.env } });
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
