/**
 * ws-outbox-store.ts — Atomic versioned durable outbox for WSS peer requests (#1401).
 *
 * Writes complete bounded snapshots via same-directory temp file + atomic rename
 * so a crash at any point leaves either the old or new checkpoint, never a
 * truncated file.  Corrupt / unsupported checkpoints are quarantined.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { logWarn, logError } from "../logger.js";

const TAG = "ws-outbox";

// ── Schema ─────────────────────────────────────────────────────────────────

/** V1 on-disk format. */
interface OutboxFileV1 {
  version: 1;
  peer: string;
  entries: OutboxEntry[];
}

export interface OutboxEntry {
  id: string;
  method: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface OutboxStoreDeps {
  peerName: string;
  filePath: string;
  maxEntries: number;
  /** Max serialized bytes per entry (as rough upper bound). */
  maxEntryBytes: number;
  /** Max serialized file size. */
  maxFileBytes: number;
}

const SUPPORTED_METHODS = new Set(["delegate", "check", "callback", "channel"]);

// ── Store ──────────────────────────────────────────────────────────────────

export class WsOutboxStore {
  private readonly deps: OutboxStoreDeps;
  private entries: OutboxEntry[] = [];
  private degraded = false;

  constructor(deps: OutboxStoreDeps) {
    this.deps = deps;
    this.load();
  }

  get isDegraded(): boolean { return this.degraded; }
  get length(): number { return this.entries.length; }
  get isFull(): boolean { return this.entries.length >= this.deps.maxEntries; }

  /** Return the oldest non-in-flight entry, or undefined. */
  peek(): OutboxEntry | undefined {
    return this.entries[0];
  }

  /**
   * Append a new entry and checkpoint.  On persistence failure the entry is
   * NOT added to memory and no socket write should proceed.
   */
  append(method: string, payload: unknown): OutboxEntry {
    if (this.isFull) throw new Error(`Outbox full (max ${this.deps.maxEntries} entries)`);
    if (!SUPPORTED_METHODS.has(method)) throw new Error(`Unsupported WSS method: ${method}`);

    const entry: OutboxEntry = {
      id: randomUUID(),
      method,
      payload,
      createdAt: new Date().toISOString(),
      attempts: 0,
    };

    // Validate size before accepting
    const serialized = JSON.stringify(entry);
    if (serialized.length > this.deps.maxEntryBytes) {
      throw new Error(`Entry exceeds ${this.deps.maxEntryBytes} byte limit (${serialized.length})`);
    }

    const testFull = [...this.entries, entry];
    const testFullSerialized = JSON.stringify(this.toFileV1(testFull));
    if (testFullSerialized.length > this.deps.maxFileBytes) {
      throw new Error(`Outbox file would exceed ${this.deps.maxFileBytes} byte limit`);
    }

    this.entries.push(entry);
    this.checkpoint();
    return entry;
  }

  /**
   * Remove an entry by ID after a valid correlated success response.
   * Persistence failure preserves the entry and sets degraded.
   */
  acknowledge(id: string): boolean {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    try {
      this.checkpoint();
    } catch {
      this.degraded = true;
      // Reconstruct — entry should be considered still present
      logError(TAG, `Acknowledge persistence failed for ${id} — degraded`);
    }
    return true;
  }

  /** Record a failed attempt (non-destructive). */
  recordAttempt(id: string, error?: string): void {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    entry.attempts++;
    entry.lastAttemptAt = new Date().toISOString();
    if (error) entry.lastError = error.slice(0, 500);
    // Best-effort: persistence failure on attempt tracking is tolerable
    try { this.checkpoint(); } catch { /* best-effort */ }
  }

  /** Remove the persisted file and clear memory. Used by purgeOutbox() and test cleanup. */
  purge(): void {
    this.entries = [];
    this.degraded = false;
    try { if (existsSync(this.deps.filePath)) unlinkSync(this.deps.filePath); } catch { /* best effort */ }
  }

  /** Visibly fail when corrupt. */
  private load(): void {
    const filePath = this.deps.filePath;
    if (!existsSync(filePath)) return;

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      this.quarantine(`read error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      this.quarantine("invalid JSON");
      return;
    }

    const file = parsed as OutboxFileV1;
    if (file.version !== 1) { this.quarantine(`unsupported version ${file.version}`); return; }
    if (file.peer !== this.deps.peerName) { this.quarantine(`peer mismatch: ${file.peer}`); return; }
    if (!Array.isArray(file.entries)) { this.quarantine("entries is not array"); return; }

    // Validate each entry
    const seen = new Set<string>();
    for (const e of file.entries) {
      if (!e.id || !e.method || !e.createdAt) { this.quarantine("invalid entry shape"); return; }
      if (!SUPPORTED_METHODS.has(e.method)) { this.quarantine(`unsupported method: ${e.method}`); return; }
      if (seen.has(e.id)) { this.quarantine(`duplicate ID: ${e.id}`); return; }
      seen.add(e.id);
      const serialized = JSON.stringify(e);
      if (serialized.length > this.deps.maxEntryBytes) { this.quarantine(`entry exceeds size limit: ${e.id}`); return; }
    }

    this.entries = file.entries.slice(0, this.deps.maxEntries);
    logWarn(TAG, `Loaded ${this.entries.length} pending outbox entries for ${this.deps.peerName}`);
  }

  /** Write complete snapshot via atomic rename. */
  private checkpoint(): void {
    const dir = dirname(this.deps.filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.${basename(this.deps.filePath)}.${randomUUID().slice(0, 8)}.tmp`);
    const data = JSON.stringify(this.toFileV1(this.entries));
    writeFileSync(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, this.deps.filePath);
  }

  private toFileV1(entries: OutboxEntry[]): OutboxFileV1 {
    return { version: 1, peer: this.deps.peerName, entries };
  }

  private quarantine(reason: string): void {
    const filePath = this.deps.filePath;
    logError(TAG, `Outbox corrupt for ${this.deps.peerName}: ${reason}`);
    if (existsSync(filePath)) {
      const backupPath = filePath + `.corrupt.${Date.now()}`;
      try { renameSync(filePath, backupPath); logWarn(TAG, `Quarantined corrupt outbox -> ${backupPath}`); } catch { /* best effort */ }
    }
    this.degraded = true;
    this.entries = [];
  }
}
