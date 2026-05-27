/**
 * session-registry.ts — Single source of truth for per-session mutable state.
 * Replaces 8 scattered Sets/Maps keyed by sessionKey.
 */
import type { InboundMessage } from "../types/platform.js";
import type { PlatformAdapter } from "../types/platform.js";

export interface QueuedMessage {
  msg: InboundMessage;
  adapter: PlatformAdapter;
}

export interface SessionEntry {
  busy: boolean;
  queue: QueuedMessage[];
  fullMode: boolean;
  pendingStart: boolean;
  seen: boolean;
  compacting: boolean;
  ctxWarned: boolean;
  compactFailures: number;
  primingTerms: string[];
  lastActiveAt: number;
  pendingWait?: string;
}

function createEntry(): SessionEntry {
  return {
    busy: false,
    queue: [],
    fullMode: false,
    pendingStart: false,
    seen: false,
    compacting: false,
    ctxWarned: false,
    compactFailures: 0,
    primingTerms: [],
    lastActiveAt: Date.now(),
  };
}

export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();

  get(key: string): SessionEntry | undefined {
    return this.entries.get(key);
  }

  getOrCreate(key: string): SessionEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = createEntry();
      this.entries.set(key, entry);
    }
    entry.lastActiveAt = Date.now();
    return entry;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Mark every tracked session as needing session-start injection on its next message. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  get size(): number {
    return this.entries.size;
  }

  /** JSON-serializable snapshot for dashboard. */
  snapshot(): Record<string, SessionEntry> {
    return Object.fromEntries(this.entries);
  }

  /** Remove idle entries older than maxAgeMs. Returns count pruned. */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [key, entry] of this.entries) {
      if (entry.lastActiveAt < cutoff && !entry.busy && !entry.compacting && entry.queue.length === 0) {
        this.entries.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}
