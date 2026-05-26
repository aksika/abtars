/**
 * abtars passwd — set or change encryption passphrase (#607).
 *
 * - Empty old passphrase = migration from key file
 * - Non-empty old passphrase = password change
 * Re-encrypts: abmind DB memories + ~/.abtars/secret/ files.
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDecipheriv, createCipheriv, randomBytes, hkdfSync } from "node:crypto";

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function passwd(): Promise<number> {
  const { deriveFromPassphrase, writeKeyVerify, validateKey, loadKeyFromFile, _resetKeyCache } = await import("abmind");
  const { writeToKeyring } = await import("abmind");

  const keyFile = join(homedir(), ".abmind", "secret", "abmind.key");
  const verifyFile = join(homedir(), ".abmind", "secret", "key.verify");
  const secretDir = join(homedir(), ".abtars", "secret");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Username
    const username = await ask(rl, "Username (same on all machines): ");
    if (!username.trim()) { console.error("Username cannot be empty."); return 1; }

    // Old key: from passphrase or from file
    let oldKey: Buffer;
    const oldPass = await ask(rl, "Current passphrase (empty = migrate from key file): ");
    if (oldPass) {
      oldKey = deriveFromPassphrase(oldPass, username.trim());
      if (existsSync(verifyFile) && !validateKey(oldKey)) {
        console.error("Wrong passphrase."); return 1;
      }
    } else {
      if (!existsSync(keyFile)) { console.error(`No key file at ${keyFile} and no passphrase. Run 'abtars install' first.`); return 1; }
      oldKey = loadKeyFromFile(keyFile);
    }

    // New passphrase
    const newPass = await ask(rl, "New passphrase (min 6 chars): ");
    if (newPass.length < 6) { console.error("Too short."); return 1; }
    const confirm = await ask(rl, "Confirm: ");
    if (newPass !== confirm) { console.error("Mismatch."); return 1; }

    const newKey = deriveFromPassphrase(newPass, username.trim());

    // Re-encrypt DB memories
    let dbCount = 0;
    try {
      const memDir = process.env["ABMIND_HOME"] ?? join(homedir(), ".abmind");
      const dbPath = join(memDir, "memory", "memory.db");
      if (existsSync(dbPath)) {
        const oldDbKey = Buffer.from(hkdfSync("sha256", oldKey, "", "abmind-secrets-v1", 32));
        const newDbKey = Buffer.from(hkdfSync("sha256", newKey, "", "abmind-secrets-v1", 32));
        const { loadNative } = await import("abmind");
        const Database = loadNative("better-sqlite3") as any;
        const db = new Database(dbPath, { readonly: false });
        const rows = db.prepare("SELECT id, content_en FROM extracted_memories WHERE classification = 3").all() as Array<{ id: number; content_en: string }>;
        const update = db.prepare("UPDATE extracted_memories SET content_en = ? WHERE id = ?");
        for (const row of rows) {
          try {
            const buf = Buffer.from(row.content_en, "base64");
            const iv = buf.subarray(0, 12);
            const tag = buf.subarray(buf.length - 16);
            const ct = buf.subarray(12, buf.length - 16);
            const d = createDecipheriv("aes-256-gcm", oldDbKey, iv);
            d.setAuthTag(tag);
            const plain = d.update(ct, undefined, "utf-8") + d.final("utf-8");
            const newIv = randomBytes(12);
            const c = createCipheriv("aes-256-gcm", newDbKey, newIv);
            const enc = Buffer.concat([c.update(plain, "utf-8"), c.final()]);
            update.run(Buffer.concat([newIv, enc, c.getAuthTag()]).toString("base64"), row.id);
            dbCount++;
          } catch { /* skip */ }
        }
        db.close();
      }
    } catch { /* DB not available */ }

    // Re-encrypt file-based secrets
    let fileCount = 0;
    if (existsSync(secretDir)) {
      const oldPurpose = Buffer.from(hkdfSync("sha256", oldKey, "", "abtars-secrets-files-v1", 32));
      const newPurpose = Buffer.from(hkdfSync("sha256", newKey, "", "abtars-secrets-files-v1", 32));
      for (const f of readdirSync(secretDir)) {
        const fp = join(secretDir, f);
        if (statSync(fp).isDirectory()) continue;
        const raw = readFileSync(fp, "utf-8").trim();
        if (!raw.startsWith("ENC:")) continue;
        try {
          const buf = Buffer.from(raw.slice(4), "base64");
          const iv = buf.subarray(1, 13);
          const tag = buf.subarray(buf.length - 16);
          const ct = buf.subarray(13, buf.length - 16);
          const d = createDecipheriv("aes-256-gcm", oldPurpose, iv);
          d.setAuthTag(tag);
          const plain = d.update(ct, undefined, "utf-8") + d.final("utf-8");
          const newIv = randomBytes(12);
          const c = createCipheriv("aes-256-gcm", newPurpose, newIv);
          const enc = Buffer.concat([c.update(plain, "utf-8"), c.final()]);
          const blob = "ENC:" + Buffer.concat([Buffer.from([0x01]), newIv, enc, c.getAuthTag()]).toString("base64");
          writeFileSync(fp, blob, { mode: 0o600 });
          fileCount++;
        } catch { /* skip */ }
      }
    }

    // Finalize
    _resetKeyCache();
    writeKeyVerify(newKey);
    if (existsSync(keyFile)) renameSync(keyFile, keyFile + ".backup");
    const stored = writeToKeyring(newPass);

    console.log(`✓ Done. ${dbCount} memories + ${fileCount} secrets re-encrypted.`);
    console.log(`\nABMIND_KEY=${newKey.toString("hex")}`);
    if (stored) console.log("✓ Passphrase stored in OS keyring.");
    else console.log("Set ABMIND_KEY as OS env var for daemon mode. Write your passphrase on paper.");
    return 0;
  } finally { rl.close(); }
}
