/**
 * `abtars backup` — full or config-only backup with optional encryption.
 *
 * Full (default): zip ~/.abtars/ (minus binaries/runtime) + ~/.abmind/ (minus raw DB)
 *                 + WAL-safe memory.db + encrypted .abm via `abmind backup`
 * Config:         zip config dirs only (config/, secret/, tasks/, skills/, core/, agents/)
 *
 * Flags: --full (default), --config, --encrypt, --output <dir>, --prune-days N
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { abtarsHome, abmindHome as resolveAbmindHome } from "../../paths.js";

const DEFAULT_PRUNE_DAYS = 7;

// Full mode: exclude these from ~/.abtars/ (everything else = user data, backup it all)
const ABTARS_EXCLUDE = [
  "logs", "overflow", "browser-socket", "app", "app/*", "bin", "bin/*", "bridge.lock", "*.sock",
];

// Full mode: exclude these from ~/.abmind/
const ABMIND_EXCLUDE = [
  "memory/memory.db", "lib", "node_modules", "backups",
  "*.sock", "*.db-wal", "*.db-shm",
];

// Config mode: include only these from ~/.abtars/
const CONFIG_DIRS = ["config", "secret", "tasks", "skills", "kanban", "metrics", "auth"];

export interface BackupOpts {
  config?: boolean;
  encrypt?: boolean;
  outputDir?: string;
  pruneDays?: number;
}

export async function backup(opts: BackupOpts = {}): Promise<number> {
  const abHome = abtarsHome();
  const abmindHome = resolveAbmindHome();
  const date = new Date().toISOString().slice(0, 10);
  const destDir = opts.outputDir ?? join(dirname(abHome), ".backup-abtars");
  mkdirSync(destDir, { recursive: true });

  const isConfig = opts.config === true;
  const prefix = isConfig ? `abtars-config-${date}` : `abtars-${date}`;

  // 1. Build exclude patterns for zip
  const zipExcludes: string[] = [];
  if (isConfig) {
    // Config mode: zip only specific dirs
    // We'll zip from abHome with explicit includes
  } else {
    // Full mode: zip everything except excludes
    for (const ex of ABTARS_EXCLUDE) {
      zipExcludes.push(`${ex}/*`, ex);
    }
    // Exclude .db-wal/.db-shm patterns
    zipExcludes.push("*.db-wal", "*.db-shm", "*.sock");
  }

  // 2. Create the zip
  const has7z = spawnSync("which", ["7z"], { encoding: "utf-8" }).status === 0;
  const zipExt = has7z ? ".7z" : ".zip";
  let zipPath = join(destDir, prefix + zipExt);

  let zipOk: boolean;

  if (isConfig) {
    // Config mode: zip specific dirs that exist
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
    // Full mode: zip ~/.abtars/ with excludes
    if (has7z) {
      const excludeArgs = ABTARS_EXCLUDE.flatMap(ex => ["-xr!" + ex]);
      excludeArgs.push("-xr!*.db-wal", "-xr!*.db-shm", "-xr!*.sock");
      const r = spawnSync("7z", ["a", zipPath, ".", ...excludeArgs], { cwd: abHome, encoding: "utf-8" });
      zipOk = r.status === 0;
    } else {
      const excludePatterns = ABTARS_EXCLUDE.flatMap(ex => [`${ex}/*`, ex]);
      excludePatterns.push("*.db-wal", "*.db-shm", "*.sock");
      const r = spawnSync("zip", ["-qr", zipPath, ".", "-x", ...excludePatterns], { cwd: abHome, encoding: "utf-8" });
      zipOk = r.status === 0;
    }

    // Add abmind tree (if exists)
    if (zipOk && existsSync(abmindHome)) {
      if (has7z) {
        const excludeArgs = ABMIND_EXCLUDE.flatMap(ex => ["-xr!" + ex]);
        const r = spawnSync("7z", ["a", zipPath, ".", ...excludeArgs], { cwd: abmindHome, encoding: "utf-8" });
        zipOk = r.status === 0;
      } else {
        const excludeArgs = ABMIND_EXCLUDE.flatMap(ex => ["-x", `${ex}/*`, "-x", ex]);
        const r = spawnSync("zip", ["-qr", zipPath, "-g", ".", ...excludeArgs], { cwd: abmindHome, encoding: "utf-8" });
        // -g = grow (append to existing zip)
        zipOk = r.status === 0;
      }
    }

    // WAL-safe memory.db copy
    const dbPath = join(abmindHome, "memory", "memory.db");
    if (zipOk && existsSync(dbPath)) {
      const tmpDb = join(process.env["TMPDIR"] ?? "/tmp", `abtars-backup-memory-${Date.now()}.db`);
      const sqliteResult = spawnSync("sqlite3", [dbPath, `.backup '${tmpDb}'`], { encoding: "utf-8" });
      if (sqliteResult.status === 0 && existsSync(tmpDb)) {
        if (has7z) {
          spawnSync("7z", ["a", zipPath, tmpDb], { encoding: "utf-8" });
        } else {
          spawnSync("zip", ["-qj", zipPath, tmpDb], { encoding: "utf-8" });
        }
        try { unlinkSync(tmpDb); } catch { /* ignore */ }
      }
    }
  }

  if (!zipOk) {
    process.stderr.write("Backup zip failed\n");
    return 1;
  }

  // 3. Verify
  if (!isConfig) {
    const actual = statSync(zipPath).size;
    if (actual < 100_000) {
      process.stderr.write(`⚠️ Backup suspiciously small (${actual} bytes)\n`);
    }
  }

  const zipSize = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`✓ ${basename(zipPath)} (${zipSize}MB)\n`);

  // 4. Encrypt if requested
  if (opts.encrypt) {
    const encPath = zipPath + ".enc";
    const ok = encryptFile(zipPath, encPath, abmindHome);
    if (!ok) return 1;
    unlinkSync(zipPath);
    zipPath = encPath;
    process.stdout.write(`✓ encrypted → ${basename(encPath)}\n`);
  }

  // 5. Full mode: run abmind backup (encrypted .abm)
  if (!isConfig) {
    const abmResult = runAbmindBackup(abHome, abmindHome);
    if (abmResult) {
      const dest = join(destDir, `abmind-${date}.abm`);
      renameSync(abmResult, dest);
      const size = (statSync(dest).size / 1024).toFixed(0);
      process.stdout.write(`✓ abmind-${date}.abm (${size}KB, encrypted)\n`);
    } else {
      process.stderr.write("⚠️ abmind backup failed or produced no .abm\n");
    }
  }

  // 6. Prune old backups
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
          process.stdout.write(`  🗑 pruned ${f}\n`);
        }
      } catch { /* skip */ }
    }
  }

  return 0;
}

function runAbmindBackup(abHome: string, abmindHome: string): string | null {
  const abmindPaths = [
    join(dirname(abHome), "workspace", "ab", "abmind", "dist", "cli", "abmind-backup.js"),
    join(abmindHome, "lib", "node_modules", "abmind", "dist", "cli", "abmind-backup.js"),
  ];
  const abmindBin = abmindPaths.find(p => existsSync(p));
  let result: ReturnType<typeof spawnSync>;
  if (abmindBin) {
    result = spawnSync("node", [abmindBin], { encoding: "utf-8", env: { ...process.env } });
  } else {
    result = spawnSync("abmind", ["backup"], { encoding: "utf-8", env: { ...process.env } });
  }

  if (result.status !== 0) return null;

  // Find latest .abm in backups dir
  const backupsDir = join(abmindHome, "backups");
  if (!existsSync(backupsDir)) return null;
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

  // Format: iv (12) + ciphertext + tag (16)
  const out = Buffer.concat([iv, encrypted, tag]);
  writeFileSync(outputPath, out);
  return true;
}
