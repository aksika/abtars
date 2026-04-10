/**
 * LeakyBucket — per-model error tracking for smart fallback routing.
 * Bucket fills on errors, drains over time. Full bucket = skip model.
 * Progressive fill: consecutive errors fill more aggressively.
 */

const LEAK_RATE_PER_MS = 0.03 / 60000; // 3% per minute
const SKIP_THRESHOLD = 0.7; // skip when bucket > 70%

const PROGRESSIVE_FILL = [0.1, 0.2, 0.4, 0.8]; // 1st, 2nd, 3rd, 4th+ consecutive errors

interface Bucket {
  level: number;    // 0.0 – 1.0
  lastUpdate: number;
  consecutiveErrors: number;
  cooldownUntil?: number; // Retry-After absolute timestamp
}

const buckets = new Map<string, Bucket>();

function drain(b: Bucket, now: number): void {
  const elapsed = now - b.lastUpdate;
  b.level = Math.max(0, b.level - elapsed * LEAK_RATE_PER_MS);
  b.lastUpdate = now;
}

/** Record an error for a model. */
export function recordError(key: string, kind: "rate_limit" | "auth" | "transient", retryAfterMs?: number): void {
  const now = Date.now();
  const b = buckets.get(key) ?? { level: 0, lastUpdate: now, consecutiveErrors: 0 };
  drain(b, now);

  if (kind === "auth") {
    b.level = 1.0; // permanent — skip until drain
  } else {
    const idx = Math.min(b.consecutiveErrors, PROGRESSIVE_FILL.length - 1);
    b.level = Math.min(1.0, b.level + PROGRESSIVE_FILL[idx]!);
  }

  b.consecutiveErrors++;
  b.lastUpdate = now;

  // Retry-After: set exact cooldown if provided
  if (retryAfterMs && retryAfterMs > 0) {
    b.cooldownUntil = now + retryAfterMs;
  }

  buckets.set(key, b);
}

/** Record a successful request — reset consecutive errors. */
export function recordSuccess(key: string): void {
  const b = buckets.get(key);
  if (!b) return;
  b.consecutiveErrors = 0;
  b.cooldownUntil = undefined;
}

/** Check if a model should be skipped. */
export function shouldSkip(key: string): boolean {
  const b = buckets.get(key);
  if (!b) return false;
  const now = Date.now();
  // Retry-After cooldown takes priority
  if (b.cooldownUntil && now < b.cooldownUntil) return true;
  if (b.cooldownUntil && now >= b.cooldownUntil) b.cooldownUntil = undefined;
  drain(b, now);
  return b.level > SKIP_THRESHOLD;
}

/** Get bucket level for display (0–100%). */
export function getBucketLevel(key: string): number {
  const b = buckets.get(key);
  if (!b) return 0;
  drain(b, Date.now());
  return Math.round(b.level * 100);
}

/** Get bucket info for structured failure summary. */
export function getBucketInfo(key: string): { level: number; consecutiveErrors: number; cooldownUntil?: number } {
  const b = buckets.get(key);
  if (!b) return { level: 0, consecutiveErrors: 0 };
  drain(b, Date.now());
  return { level: Math.round(b.level * 100), consecutiveErrors: b.consecutiveErrors, cooldownUntil: b.cooldownUntil };
}

/** Classify HTTP status to error kind. */
export function classifyError(status: number): "rate_limit" | "auth" | "transient" {
  if (status === 429) return "rate_limit";
  if (status === 402) return "rate_limit"; // quota exceeded on free tiers is temporary
  if (status === 401 || status === 403) return "auth";
  return "transient";
}
