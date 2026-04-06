/**
 * LeakyBucket — per-model error tracking for smart fallback routing.
 * Bucket fills on errors, drains over time. Full bucket = skip model.
 */

const LEAK_RATE_PER_MS = 0.03 / 60000; // 3% per minute
const SKIP_THRESHOLD = 0.7; // skip when bucket > 70%

const FILL_AMOUNTS: Record<string, number> = {
  rate_limit: 0.4,  // 429 — heavy
  auth: 1.0,        // 401/402 — flood
  transient: 0.15,  // 500/timeout — light
};

interface Bucket {
  level: number;    // 0.0 – 1.0
  lastUpdate: number;
}

const buckets = new Map<string, Bucket>();

function drain(b: Bucket, now: number): void {
  const elapsed = now - b.lastUpdate;
  b.level = Math.max(0, b.level - elapsed * LEAK_RATE_PER_MS);
  b.lastUpdate = now;
}

/** Record an error for a model. */
export function recordError(key: string, kind: "rate_limit" | "auth" | "transient"): void {
  const now = Date.now();
  const b = buckets.get(key) ?? { level: 0, lastUpdate: now };
  drain(b, now);
  b.level = Math.min(1.0, b.level + (FILL_AMOUNTS[kind] ?? 0.15));
  b.lastUpdate = now;
  buckets.set(key, b);
}

/** Check if a model should be skipped. */
export function shouldSkip(key: string): boolean {
  const b = buckets.get(key);
  if (!b) return false;
  drain(b, Date.now());
  return b.level > SKIP_THRESHOLD;
}

/** Get bucket level for display (0–100%). */
export function getBucketLevel(key: string): number {
  const b = buckets.get(key);
  if (!b) return 0;
  drain(b, Date.now());
  return Math.round(b.level * 100);
}

/** Classify HTTP status to error kind. */
export function classifyError(status: number): "rate_limit" | "auth" | "transient" {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 402 || status === 403) return "auth";
  return "transient";
}
