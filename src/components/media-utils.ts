/**
 * media-utils.ts — inbound media handling: validate, detect MIME, save to disk, cleanup.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { randomBytes } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { logInfo, logWarn } from "./logger.js";

const TAG = "media";
const MAX_FILE_BYTES = 16 * 1024 * 1024; // 16MB
const IMAGE_MAX_PX = parseInt(process.env["IMAGE_MAX_PX"] ?? "1024", 10);
const IMAGE_MAX_BASE64_MB = parseFloat(process.env["IMAGE_MAX_BASE64_MB"] ?? "3");

const MEDIA_DIR = join(abtarsHome(), "received", "media");
const FILES_DIR = join(abtarsHome(), "received", "files");

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const EXT_MAP: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv", "text/markdown": ".md",
};

export interface SavedMedia {
  path: string;
  mime: string;
  ext: string;
  size: number;
  isImage: boolean;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function buildFilename(chatId: number | string, ext: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = randomBytes(3).toString("hex");
  return `${ts}_${chatId}_${rand}${ext}`;
}

/**
 * Detect MIME from buffer with fallback chain: sniff → extension hint → claimed.
 */
async function detectMime(buffer: Buffer, extHint?: string, claimedMime?: string): Promise<string> {
  // 1. Sniff from buffer
  const sniffed = await fileTypeFromBuffer(buffer);
  if (sniffed && sniffed.mime !== "application/octet-stream" && sniffed.mime !== "application/zip") {
    return sniffed.mime;
  }

  // 2. Extension hint
  if (extHint) {
    const extLower = extHint.toLowerCase();
    for (const [mime, ext] of Object.entries(EXT_MAP)) {
      if (ext === extLower) return mime;
    }
  }

  // 3. Claimed
  if (claimedMime && claimedMime !== "application/octet-stream") {
    return claimedMime;
  }

  return sniffed?.mime ?? "application/octet-stream";
}

/**
 * Save inbound media from user platforms (Telegram/Discord).
 * Returns null if file exceeds size limit.
 */
export async function saveInboundMedia(
  buffer: Buffer,
  chatId: number | string,
  opts?: { extHint?: string; claimedMime?: string },
): Promise<SavedMedia | null> {
  if (buffer.length > MAX_FILE_BYTES) {
    logWarn(TAG, `Rejected file from chat ${chatId}: ${buffer.length} bytes exceeds ${MAX_FILE_BYTES}`);
    return null;
  }

  const mime = await detectMime(buffer, opts?.extHint, opts?.claimedMime);
  const isImage = IMAGE_MIMES.has(mime);
  const ext = EXT_MAP[mime] ?? ".bin";

  if (opts?.claimedMime && opts.claimedMime !== mime) {
    logWarn(TAG, `MIME mismatch: claimed=${opts.claimedMime}, detected=${mime}`);
  }

  const dir = isImage ? MEDIA_DIR : MEDIA_DIR; // all u2a goes to media/
  ensureDir(dir);
  const filename = buildFilename(chatId, ext);
  const path = join(dir, filename);

  // Resize images if needed (progressive: halve + reduce quality until under target)
  let finalBuffer = buffer;
  if (isImage && buffer.length > 300_000 && (mime === "image/jpeg" || mime === "image/png")) {
    try {
      finalBuffer = await resizeImage(buffer, mime);
    } catch (err) {
      logWarn(TAG, `Resize failed, saving original: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  writeFileSync(path, finalBuffer);
  logInfo(TAG, `Saved ${isImage ? "image" : "file"}: ${filename} (${finalBuffer.length}B, ${mime})`);

  return { path, mime, ext, size: finalBuffer.length, isImage };
}

/** Progressive resize: cap dimensions + reduce quality until base64 fits under target. */
async function resizeImage(buffer: Buffer, mime: string): Promise<Buffer> {
  const { Jimp } = await import("jimp");
  const img = await Jimp.read(buffer);
  const maxBytes = IMAGE_MAX_BASE64_MB * 1024 * 1024;
  let w = img.width;
  let h = img.height;

  // Cap longest edge at IMAGE_MAX_PX
  if (w > IMAGE_MAX_PX || h > IMAGE_MAX_PX) {
    const scale = IMAGE_MAX_PX / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    img.resize({ w, h });
  }

  // Progressive quality reduction (JPEG only, up to 4 rounds)
  const isJpeg = mime === "image/jpeg";
  const qualities = isJpeg ? [85, 70, 50, 30] : [undefined];
  for (let round = 0; round < 4; round++) {
    for (const q of qualities) {
      const out = isJpeg
        ? await img.getBuffer("image/jpeg", { quality: q })
        : await img.getBuffer("image/png");
      const b64Size = Math.ceil(out.length * 4 / 3);
      if (b64Size <= maxBytes) return Buffer.from(out);
    }
    // Still too large — halve dimensions
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    if (w < 64 || h < 64) break;
    img.resize({ w, h });
  }

  // Last resort: return smallest we got
  const out = isJpeg
    ? await img.getBuffer("image/jpeg", { quality: 30 })
    : await img.getBuffer("image/png");
  return Buffer.from(out);
}

/** Prune media folder: delete files >7 days old, then oldest if >100MB total. */
export function pruneMediaFolder(): number {
  if (!existsSync(MEDIA_DIR)) return 0;
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  const maxBytes = 100 * 1024 * 1024;
  const now = Date.now();
  let deleted = 0;

  // Pass 1: delete old files
  const files = readdirSync(MEDIA_DIR)
    .map(f => ({ name: f, path: join(MEDIA_DIR, f), stat: statSync(join(MEDIA_DIR, f)) }))
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs); // oldest first

  for (const f of files) {
    if (now - f.stat.mtimeMs > maxAge) {
      try { unlinkSync(f.path); deleted++; } catch { /* */ }
    }
  }

  // Pass 2: prune oldest if still over budget
  const remaining = files.filter(f => existsSync(f.path));
  let totalSize = remaining.reduce((sum, f) => sum + f.stat.size, 0);
  for (const f of remaining) {
    if (totalSize <= maxBytes) break;
    try { unlinkSync(f.path); totalSize -= f.stat.size; deleted++; } catch { /* */ }
  }

  if (deleted > 0) logInfo(TAG, `Pruned ${deleted} media files`);
  return deleted;
}

/**
 * Save inbound file from A2A agents. Always stored as .txt.
 */
export async function saveA2AFile(buffer: Buffer, chatId: number): Promise<SavedMedia | null> {
  if (buffer.length > MAX_FILE_BYTES) {
    logWarn(TAG, `Rejected A2A file: ${buffer.length} bytes exceeds ${MAX_FILE_BYTES}`);
    return null;
  }

  ensureDir(FILES_DIR);
  const filename = buildFilename(chatId, ".txt");
  const path = join(FILES_DIR, filename);
  writeFileSync(path, buffer);
  logInfo(TAG, `Saved A2A file: ${filename} (${buffer.length}B, forced .txt)`);

  return { path, mime: "text/plain", ext: ".txt", size: buffer.length, isImage: false };
}
