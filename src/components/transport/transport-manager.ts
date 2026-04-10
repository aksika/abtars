/**
 * TransportManager — wraps primary + fallback transport behind IKiroTransport.
 * Recovery L3: swap to fallback when primary is unrecoverable.
 * Cold init — fallback only created on first failure.
 */

import { logInfo, logWarn } from "../logger.js";
import type { IKiroTransport } from "./kiro-transport.js";

const TAG = "transport-mgr";
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface FallbackConfig {
  createFallback: () => Promise<IKiroTransport>;
  threshold?: number; // consecutive failures before swap (default 3)
  onFallbackActivated?: () => void;
}

export class TransportManager implements IKiroTransport {
  private readonly primary: IKiroTransport;
  private readonly fallbackConfig: FallbackConfig;
  private fallback: IKiroTransport | null = null;
  private usingFallback = false;
  private consecutiveFailures = 0;
  private readonly threshold: number;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(primary: IKiroTransport, fallbackConfig: FallbackConfig) {
    this.primary = primary;
    this.fallbackConfig = fallbackConfig;
    this.threshold = fallbackConfig.threshold ?? 3;
  }

  private get active(): IKiroTransport { return this.usingFallback && this.fallback ? this.fallback : this.primary; }

  async initialize(): Promise<void> {
    await this.primary.initialize();
  }

  async sendPrompt(sessionKey: string, message: string): Promise<string> {
    try {
      const result = await this.active.sendPrompt(sessionKey, message);
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveFailures++;

      if (!this.usingFallback && this.consecutiveFailures >= this.threshold) {
        logWarn(TAG, `Primary transport failed ${this.consecutiveFailures}x — swapping to fallback`);
        try {
          if (!this.fallback) {
            this.fallback = await this.fallbackConfig.createFallback();
            await this.fallback.initialize();
          }
          this.usingFallback = true;
          this.startHealthCheck();
          this.fallbackConfig.onFallbackActivated?.();
          logInfo(TAG, "✅ Fallback transport active");
          return this.fallback.sendPrompt(sessionKey, message);
        } catch (fbErr) {
          logWarn(TAG, `Fallback init failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
        }
      }
      throw err;
    }
  }

  async resetSession(sessionKey: string): Promise<void> {
    await this.active.resetSession(sessionKey);
  }

  async sendInterrupt(): Promise<void> {
    await this.active.sendInterrupt();
  }

  destroy(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.primary.destroy();
    this.fallback?.destroy();
  }

  get isReady(): boolean { return this.active.isReady; }
  get contextPercent(): number { return this.active.contextPercent; }

  /** Proxy currentModel from active transport if available. */
  get currentModel(): string | undefined {
    const t = this.active;
    return "currentModel" in t ? (t as unknown as { currentModel: string }).currentModel : undefined;
  }

  /** Proxy setModel to active transport if available. */
  async setModel(model: string): Promise<void> {
    const t = this.active;
    if ("setModel" in t && typeof (t as { setModel: unknown }).setModel === "function") {
      await (t as unknown as { setModel: (m: string) => Promise<void> }).setModel(model);
    }
  }

  /** Whether currently using the fallback transport. */
  get isOnFallback(): boolean { return this.usingFallback; }

  /** Force switch back to primary transport. */
  forceRestorePrimary(): void {
    this.usingFallback = false;
    this.consecutiveFailures = 0;
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    logInfo(TAG, "🔄 Forced restore to primary transport");
  }
  get answerOnly(): string { return this.active.answerOnly; }
  get intermediateDeliveredText(): string { return this.active.intermediateDeliveredText; }
  get transportCommands(): string[] { return this.active.transportCommands; }

  get onIntermediateResponse(): ((text: string) => void) | undefined { return this.active.onIntermediateResponse; }
  set onIntermediateResponse(cb: ((text: string) => void) | undefined) {
    this.primary.onIntermediateResponse = cb;
    if (this.fallback) this.fallback.onIntermediateResponse = cb;
  }

  // Expose for watchdog
  get promptStartedAt(): number | null { return (this.active as { promptStartedAt?: number | null }).promptStartedAt ?? null; }
  get lastActivityAt(): number | null { return (this.active as { lastActivityAt?: number | null }).lastActivityAt ?? null; }

  /** Periodically check if primary is back. */
  private startHealthCheck(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(async () => {
      if (!this.usingFallback) {
        if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
        return;
      }
      try {
        // Lightweight check — just verify the transport can initialize
        if (!this.primary.isReady) await this.primary.initialize();
        if (this.primary.isReady) {
          logInfo(TAG, "🔄 Primary transport restored — swapping back");
          this.usingFallback = false;
          this.consecutiveFailures = 0;
          if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
        }
      } catch { /* primary still down */ }
    }, HEALTH_CHECK_INTERVAL_MS);
  }
}
