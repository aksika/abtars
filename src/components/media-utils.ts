/**
 * media-utils.ts — inbound media handling: validate, detect MIME, save to disk, cleanup.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { logInfo, logWarn } from "./logger.js";

const TAG = "media";
const MAX_FILE_BYTES = 16 * 1024 * 1024; // 16MB

const MEDIA_DIR = (): string => join(homedir(), ".agentbridge", "received", "media");
const FILES_DIR = (): string => join(homedir(), ".agentbridge", "received", "files");

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

  const dir = isImage ? MEDIA_DIR() : MEDIA_DIR(); // all u2a goes to media/
  ensureDir(dir);
  const filename = buildFilename(chatId, ext);
  const path = join(dir, filename);
  writeFileSync(path, buffer);
  logInfo(TAG, `Saved ${isImage ? "image" : "file"}: ${filename} (${buffer.length}B, ${mime})`);

  return { path, mime, ext, size: buffer.length, isImage };
}

/**
 * Save inbound file from A2A agents. Always stored as .txt.
 */
export async function saveA2AFile(buffer: Buffer, chatId: number): Promise<SavedMedia | null> {
  if (buffer.length > MAX_FILE_BYTES) {
    logWarn(TAG, `Rejected A2A file: ${buffer.length} bytes exceeds ${MAX_FILE_BYTES}`);
    return null;
  }

  ensureDir(FILES_DIR());
  const filename = buildFilename(chatId, ".txt");
  const path = join(FILES_DIR(), filename);
  writeFileSync(path, buffer);
  logInfo(TAG, `Saved A2A file: ${filename} (${buffer.length}B, forced .txt)`);

  return { path, mime: "text/plain", ext: ".txt", size: buffer.length, isImage: false };
}

/**
 * FIFO cleanup: delete oldest files in received/ until total < maxBytes.
 * Returns bytes freed.
 */
export function cleanupReceived(maxBytes = 100 * 1024 * 1024): number {
  const baseDir = join(homedir(), ".agentbridge", "received");
  if (!existsSync(baseDir)) return 0;

  const files: { path: string; size: number; mtime: number }[] = [];
  for (const sub of ["media", "files"]) {
    const dir = join(baseDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const s = statSync(p);
        if (s.isFile()) files.push({ path: p, size: s.size, mtime: s.mtimeMs });
      } catch { /* skip */ }
    }
  }

  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxBytes) return 0;

  // Sort oldest first
  files.sort((a, b) => a.mtime - b.mtime);
  let freed = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(f.path);
      total -= f.size;
      freed += f.size;
      logInfo(TAG, `Cleanup: deleted ${f.path} (${f.size}B)`);
    } catch { /* skip */ }
  }
  return freed;
}
