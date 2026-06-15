/**
 * `abtars restore` — restore from backup archive, auto-detect type.
 *
 * .abm        → delegate to abmind restore
 * .zip/.7z    → extract to ~/.abtars/ + find sibling .abm → restore both
 * .enc        → find sibling .abm first (restore → key exists) → decrypt → extract
 * --config    → zip only, skip abmind
 * --passphrase → passed through to abmind restore
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { abtarsHome, abmindHome as resolveAbmindHome } from "../../paths.js";

export interface RestoreOpts {
  config?: boolean;
  passphrase?: string;
}

export async function restore(archivePath: string, opts: RestoreOpts = {}): Promise<number> {
  if (!archivePath) {
    process.stderr.write("Usage: abtars restore <file.zip|.7z|.abm|.enc> [--config] [--passphrase <p>]\n");
    return 1;
  }
  if (!existsSync(archivePath)) {
    process.stderr.write(`File not found: ${archivePath}\n`);
    return 1;
  }

  // Direct .abm → delegate entirely to abmind restore
  if (archivePath.endsWith(".abm")) {
    return restoreAbmind(archivePath, opts.passphrase);
  }

  // .enc → restore sibling .abm first (ensures key exists), then decrypt
  if (archivePath.endsWith(".enc")) {
    // Find sibling .abm
    const date = extractDate(archivePath);
    const dir = dirname(archivePath);
    const sibling = findSiblingAbm(dir, date);

    if (!opts.config && sibling) {
      const rc = restoreAbmind(sibling, opts.passphrase);
      if (rc !== 0) return rc;
    }

    // Decrypt .enc → temp zip
    const abmindHome = resolveAbmindHome();
    const keyPath = join(abmindHome, "secret", "abmind.key");
    if (!existsSync(keyPath)) {
      process.stderr.write("Error: abmind.key not found — run `abmind restore <file.abm>` first to recreate it, then retry.\n");
      return 1;
    }

    const tmpZip = join(process.env["TMPDIR"] ?? "/tmp", `abtars-restore-${Date.now()}.zip`);
    const ok = decryptFile(archivePath, tmpZip, keyPath);
    if (!ok) return 1;
    process.stdout.write("✓ decrypted\n");

    // Extract the decrypted zip
    const rc = extractZip(tmpZip, abtarsHome());
    try { unlinkSync(tmpZip); } catch { /* ignore */ }
    return rc;
  }

  // .zip/.7z
  if (!opts.config) {
    // Restore sibling .abm first
    const date = extractDate(archivePath);
    const dir = dirname(archivePath);
    const sibling = findSiblingAbm(dir, date);
    if (sibling) {
      const rc = restoreAbmind(sibling, opts.passphrase);
      if (rc !== 0) return rc;
    } else {
      process.stdout.write("ℹ no sibling .abm found — memory not restored\n");
    }
  }

  // Extract zip to ~/.abtars/
  return extractZip(archivePath, abtarsHome());
}

function restoreAbmind(abmPath: string, passphrase?: string): number {
  const args = ["restore", "--input", abmPath, "--mode", "merge"];
  if (passphrase) args.push("--passphrase", passphrase);

  const envPassphrase = process.env["ABMIND_BACKUP_PASSPHRASE"];
  const env = { ...process.env };
  if (!passphrase && envPassphrase) {
    env["ABMIND_BACKUP_PASSPHRASE"] = envPassphrase;
  }

  const result = spawnSync("abmind", args, { encoding: "utf-8", stdio: "inherit", env });
  if (result.status !== 0) {
    process.stderr.write("abmind restore failed\n");
    return 1;
  }
  process.stdout.write("✓ abmind memory restored\n");
  return 0;
}

function extractZip(archivePath: string, destDir: string): number {
  const is7z = archivePath.endsWith(".7z");

  // Sanity check
  const listCmd = is7z
    ? spawnSync("7z", ["l", archivePath], { encoding: "utf-8" })
    : spawnSync("unzip", ["-l", archivePath], { encoding: "utf-8" });
  if (!listCmd.stdout?.includes("config/")) {
    process.stderr.write("Error: archive does not contain config/ — not a valid abtars backup\n");
    return 1;
  }

  // Extract, excluding binary dirs + manifest (install state, not user data)
  let result;
  if (is7z) {
    result = spawnSync("7z", ["x", `-o${destDir}`, "-aoa", "-xr!releases", "-xr!current", "-xr!bin", "-xr!manifest.json", archivePath],
      { encoding: "utf-8", stdio: "inherit" });
  } else {
    result = spawnSync("unzip", ["-o", archivePath, "-d", destDir, "-x", "releases/*", "current/*", "bin/*", "manifest.json"],
      { encoding: "utf-8", stdio: "inherit" });
  }

  if (result.status !== 0) {
    process.stderr.write("Restore extract failed\n");
    return 1;
  }

  process.stdout.write(`✓ Restored to ${destDir}\n`);
  return 0;
}

function extractDate(filePath: string): string | null {
  const name = basename(filePath);
  const match = name.match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function findSiblingAbm(dir: string, date: string | null): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith(".abm"));
  if (date) {
    const exact = files.find(f => f.includes(date));
    if (exact) return join(dir, exact);
  }
  // Fallback: latest .abm in the dir
  const sorted = files.sort().reverse();
  return sorted[0] ? join(dir, sorted[0]) : null;
}

function decryptFile(inputPath: string, outputPath: string, keyPath: string): boolean {
  const master = Buffer.from(readFileSync(keyPath, "utf-8").trim(), "hex");
  const key = Buffer.from(hkdfSync("sha256", master, "", "abtars-backup-v1", 32));

  const buf = readFileSync(inputPath);
  if (buf.length < 28) { // 12 iv + 16 tag minimum
    process.stderr.write("Error: encrypted file too small\n");
    return false;
  }

  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    writeFileSync(outputPath, decrypted);
    return true;
  } catch {
    process.stderr.write("Error: decryption failed — wrong key or corrupted file\n");
    return false;
  }
}
