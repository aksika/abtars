/**
 * ModelHealthRegistry — shared per-model error tracking.
 * Leaky-bucket algorithm: fills on errors, drains over time. Full = skip.
 * One instance per bridge process, shared across all FallbackPolicy instances.
 */

export type ErrorKind = "rate_limit" | "auth" | "transient" | "weak";
export type ModelStatus = "healthy" | "degraded" | "exhausted" | "auth_failed";

interface Bucket {
  level: number;
  lastUpdate: number;
  consecutiveErrors: number;
  cooldownUntil?: number;
  authFailed?: boolean;
}

const LEAK_RATE_PER_MS = 0.03 / 60000; // 3% per minute
const SKIP_THRESHOLD = 0.7;
const PROGRESSIVE_FILL = [0.1, 0.2, 0.4, 0.8];

export class ModelHealthRegistry {
  private readonly buckets = new Map<string, Bucket>();

  private drain(b: Bucket, now: number): void {
    if (b.authFailed) return;
    const elapsed = now - b.lastUpdate;
    b.level = Math.max(0, b.level - elapsed * LEAK_RATE_PER_MS);
    b.lastUpdate = now;
  }

  shouldSkip(model: string, endpoint: string): boolean {
    const b = this.buckets.get(`${endpoint}|${model}`);
    if (!b) return false;
    const now = Date.now();
    if (b.cooldownUntil && now < b.cooldownUntil) return true;
    if (b.cooldownUntil && now >= b.cooldownUntil) b.cooldownUntil = undefined;
    this.drain(b, now);
    return b.level > SKIP_THRESHOLD;
  }

  recordSuccess(model: string, endpoint: string): void {
    const b = this.buckets.get(`${endpoint}|${model}`);
    if (!b) return;
    b.consecutiveErrors = 0;
    b.cooldownUntil = undefined;
    b.authFailed = false;
  }

  recordError(model: string, endpoint: string, kind: ErrorKind, retryAfterMs?: number): void {
    const key = `${endpoint}|${model}`;
    const now = Date.now();
    const b = this.buckets.get(key) ?? { level: 0, lastUpdate: now, consecutiveErrors: 0 };
    this.drain(b, now);

    if (kind === "auth") {
      b.level = 1.0;
      b.authFailed = true;
    } else if (kind === "weak") {
      b.level = Math.min(1.0, b.level + 0.05);
    } else if (kind === "rate_limit") {
      b.level = Math.min(1.0, b.level + 0.5);
      if (retryAfterMs && retryAfterMs > 0) b.cooldownUntil = now + retryAfterMs;
    } else {
      // transient — progressive fill + max cooldown 300s after 4+ errors
      const idx = Math.min(b.consecutiveErrors, PROGRESSIVE_FILL.length - 1);
      b.level = Math.min(1.0, b.level + PROGRESSIVE_FILL[idx]!);
      if (b.consecutiveErrors >= 3) b.cooldownUntil = now + Math.min((b.consecutiveErrors + 1) * 60_000, 300_000);
    }

    b.consecutiveErrors++;
    b.lastUpdate = now;
    this.buckets.set(key, b);
  }

  getHealth(): Map<string, { level: number; consecutiveErrors: number; cooldownUntil?: number; status: ModelStatus }> {
    const now = Date.now();
    const result = new Map<string, { level: number; consecutiveErrors: number; cooldownUntil?: number; status: ModelStatus }>();
    for (const [key, b] of this.buckets) {
      this.drain(b, now);
      let status: ModelStatus = "healthy";
      if (b.authFailed) status = "auth_failed";
      else if (b.level > SKIP_THRESHOLD) status = "exhausted";
      else if (b.level > 0.3) status = "degraded";
      result.set(key, { level: Math.round(b.level * 100), consecutiveErrors: b.consecutiveErrors, cooldownUntil: b.cooldownUntil, status });
    }
    return result;
  }

  /** Get bucket level for a specific model (0-100%). */
  getBucketLevel(model: string, endpoint: string): number {
    const b = this.buckets.get(`${endpoint}|${model}`);
    if (!b) return 0;
    this.drain(b, Date.now());
    return Math.round(b.level * 100);
  }

  resetAll(): void {
    this.buckets.clear();
  }
}

/** Classify HTTP status to error kind. */
export function classifyError(status: number): ErrorKind {
  if (status === 429 || status === 402) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  return "transient";
}
