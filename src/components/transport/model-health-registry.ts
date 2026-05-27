/**
 * ModelHealthRegistry — shared per-model error tracking.
 * Leaky-bucket algorithm: fills on errors, drains over time. Full = skip.
 * One instance per bridge process, shared across all FallbackPolicy instances.
 *
 * All tuning constants configurable via transport.json `healthPolicy` key.
 * Missing fields fall back to hardcoded defaults.
 */

export type ErrorKind = "rate_limit" | "auth" | "transient" | "weak";
export type ModelStatus = "healthy" | "degraded" | "exhausted" | "auth_failed";

export interface HealthPolicyConfig {
  /** Bucket level (0-1) above which model is skipped. Default: 0.7 */
  skipThreshold?: number;
  /** Drain rate per minute (0-1). Default: 0.03 */
  leakPerMinute?: number;
  /** Auth error: fill amount (0-1). Default: 1.0 (instant full) */
  authFill?: number;
  /** Auth errors are sticky (never auto-drain). Default: true */
  authSticky?: boolean;
  /** Rate-limit fill per hit. Default: 0.5 */
  rateLimitFill?: number;
  /** Weak-model fill per hit. Default: 0.05 */
  weakFill?: number;
  /** Transient progressive fill array. Default: [0.1, 0.2, 0.4, 0.8] */
  transientProgressive?: number[];
  /** Consecutive errors before cooldown kicks in. Default: 3 */
  transientCooldownAfter?: number;
  /** Max cooldown seconds for transient errors. Default: 300 */
  transientMaxCooldownSec?: number;
}

interface Bucket {
  level: number;
  lastUpdate: number;
  consecutiveErrors: number;
  cooldownUntil?: number;
  authFailed?: boolean;
  demoted?: boolean;
}

// Defaults (unchanged from pre-config behavior)
const D_SKIP_THRESHOLD = 0.7;
const D_LEAK_PER_MIN = 0.03;
const D_AUTH_STICKY = true;
const D_RATE_LIMIT_FILL = 0.5;
const D_WEAK_FILL = 0.35;
const D_TRANSIENT_PROGRESSIVE = [0.1, 0.2, 0.4, 0.8];
const D_TRANSIENT_COOLDOWN_AFTER = 3;
const D_TRANSIENT_MAX_COOLDOWN_SEC = 300;

export class ModelHealthRegistry {
  private readonly buckets = new Map<string, Bucket>();
  private readonly skipThreshold: number;
  private readonly leakPerMs: number;
  private readonly authSticky: boolean;
  private readonly rateLimitFill: number;
  private readonly weakFill: number;
  private readonly transientProgressive: number[];
  private readonly transientCooldownAfter: number;
  private readonly transientMaxCooldownMs: number;

  /** Fired when a model crosses the demotion threshold. Wired at boot. */
  onDemote?: (model: string, endpoint: string, reason: "auth" | "timeout") => void;

  constructor(config?: HealthPolicyConfig) {
    this.skipThreshold = config?.skipThreshold ?? D_SKIP_THRESHOLD;
    this.leakPerMs = (config?.leakPerMinute ?? D_LEAK_PER_MIN) / 60000;
    this.authSticky = config?.authSticky ?? D_AUTH_STICKY;
    this.rateLimitFill = config?.rateLimitFill ?? D_RATE_LIMIT_FILL;
    this.weakFill = config?.weakFill ?? D_WEAK_FILL;
    this.transientProgressive = config?.transientProgressive ?? D_TRANSIENT_PROGRESSIVE;
    this.transientCooldownAfter = config?.transientCooldownAfter ?? D_TRANSIENT_COOLDOWN_AFTER;
    this.transientMaxCooldownMs = (config?.transientMaxCooldownSec ?? D_TRANSIENT_MAX_COOLDOWN_SEC) * 1000;
  }

  private drain(b: Bucket, now: number): void {
    if (this.authSticky && b.authFailed) return;
    const elapsed = now - b.lastUpdate;
    b.level = Math.max(0, b.level - elapsed * this.leakPerMs);
    b.lastUpdate = now;
  }

  shouldSkip(model: string, endpoint: string): boolean {
    const b = this.buckets.get(`${endpoint}|${model}`);
    if (!b) return false;
    const now = Date.now();
    if (b.cooldownUntil && now < b.cooldownUntil) return true;
    if (b.cooldownUntil && now >= b.cooldownUntil) b.cooldownUntil = undefined;
    this.drain(b, now);
    return b.level > this.skipThreshold;
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

    switch (kind) {
      case "auth":
        b.level = 1.0;
        b.authFailed = true;
        if (this.onDemote && !b.demoted) {
          b.demoted = true;
          this.onDemote(model, endpoint, "auth");
        }
        break;
      case "transient": {
        const idx = Math.min(b.consecutiveErrors, this.transientProgressive.length - 1);
        b.level = Math.min(1.0, b.level + this.transientProgressive[idx]!);
        if (b.consecutiveErrors >= this.transientCooldownAfter) {
          b.cooldownUntil = now + Math.min((b.consecutiveErrors + 1) * 60_000, this.transientMaxCooldownMs);
        }
        break;
      }
      case "rate_limit":
        b.level = Math.min(1.0, b.level + this.rateLimitFill);
        if (retryAfterMs && retryAfterMs > 0) b.cooldownUntil = now + retryAfterMs;
        break;
      case "weak":
        b.level = Math.min(1.0, b.level + this.weakFill);
        break;
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
      else if (b.level > this.skipThreshold) status = "exhausted";
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
export function classifyError(status: number, message?: string): ErrorKind {
  if (status === 429 || status === 402) return "rate_limit";
  if (status === 404 && message && /image input|No endpoints found/i.test(message)) return "transient";
  if (status === 401 || status === 403 || status === 404) return "auth";
  return "transient";
}
