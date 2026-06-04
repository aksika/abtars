/**
 * Service registry — manages lifecycle of bridge services (Telegram, Discord, Agent API).
 * Services are registered with a factory that creates them on demand.
 * The dashboard and CLI flags both use this to start/stop services.
 *
 * Background retry (#321): when backgroundRetry is true and foreground attempts
 * exhaust, a non-blocking retry loop with exponential backoff runs indefinitely
 * until the service starts or is explicitly stopped.
 */

import { logInfo, logError, logWarn, logDebug } from "./logger.js";

const TAG = "service-registry";

export interface ServiceInstance {
  start(): void | Promise<void>;
  stop(): void;
}

export interface ServiceFactory {
  /** Whether required config (tokens, etc.) is present in .env */
  configured: boolean;
  /** Create and wire the service. Called on start(). */
  create(): Promise<ServiceInstance>;
}

export interface StartResult {
  ok: boolean;
  error?: string;
  retryingInBackground?: boolean;
}

interface PendingRetry {
  attempt: number;
  nextAttemptAt: number;
  lastError: string;
  aborted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ServiceState {
  configured: boolean;
  running: boolean;
  retrying?: { attempt: number; nextAttemptAt: number; lastError: string };
}

/** Jittered delay: nominal × random factor in [0.8, 1.2]. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** Exponential backoff schedule: 15s, 30s, 60s, 120s, 300s (capped). */
function backoffDelay(bgAttempt: number): number {
  const delays = [15_000, 30_000, 60_000, 120_000, 300_000];
  const nominal = delays[Math.min(bgAttempt, delays.length - 1)] ?? 300_000;
  return jitter(nominal);
}

export class ServiceRegistry {
  private readonly factories = new Map<string, ServiceFactory>();
  private readonly instances = new Map<string, ServiceInstance>();
  private readonly pending = new Map<string, PendingRetry>();

  register(name: string, factory: ServiceFactory): void {
    this.factories.set(name, factory);
  }

  async start(name: string, opts?: { retries?: number; delayMs?: number; backgroundRetry?: boolean }): Promise<StartResult> {
    const retries = opts?.retries ?? 3;
    const delayMs = opts?.delayMs ?? 5000;
    const backgroundRetry = opts?.backgroundRetry ?? false;

    // Cancel any pending background retry for this service
    this.cancelPending(name);

    const factory = this.factories.get(name);
    if (!factory) return { ok: false, error: `Unknown service: ${name}` };
    if (!factory.configured) return { ok: false, error: `${name} not configured (check .env)` };
    if (this.instances.has(name)) return { ok: false, error: `${name} already running` };

    // Foreground retry loop (unchanged semantics)
    let lastError = "";
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const instance = await factory.create();
        await instance.start();
        this.instances.set(name, instance);
        this.pending.delete(name); // atomic: clear retry state on success
        logInfo(TAG, `Started service: ${name}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
        return { ok: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < retries) {
          logWarn(TAG, `Failed to start ${name} (attempt ${attempt}/${retries}): ${lastError} — retrying in ${delayMs / 1000}s`);
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          if (backgroundRetry) {
            logWarn(TAG, `Failed to start ${name} after ${retries} attempts: ${lastError} — retrying in background`);
            this.spawnBackgroundRetry(name, factory);
            return { ok: false, error: lastError, retryingInBackground: true };
          }
          logError(TAG, `Failed to start ${name} after ${retries} attempts: ${lastError}`);
          return { ok: false, error: lastError };
        }
      }
    }
    return { ok: false, error: "unreachable" };
  }

  stop(name: string): { ok: boolean; error?: string } {
    // Cancel pending retry if any
    if (this.pending.has(name)) {
      this.cancelPending(name);
      logInfo(TAG, `Cancelled pending retry for ${name}`);
      return { ok: true };
    }

    const instance = this.instances.get(name);
    if (!instance) return { ok: false, error: `${name} not running` };

    try {
      instance.stop();
      this.instances.delete(name);
      logInfo(TAG, `Stopped service: ${name}`);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(TAG, `Failed to stop ${name}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  isRunning(name: string): boolean {
    return this.instances.has(name);
  }

  isConfigured(name: string): boolean {
    return this.factories.get(name)?.configured ?? false;
  }

  getStates(): Record<string, ServiceState> {
    const states: Record<string, ServiceState> = {};
    for (const [name, factory] of this.factories) {
      const state: ServiceState = { configured: factory.configured, running: this.instances.has(name) };
      const p = this.pending.get(name);
      if (p && !state.running) {
        state.retrying = { attempt: p.attempt, nextAttemptAt: p.nextAttemptAt, lastError: p.lastError };
      }
      states[name] = state;
    }
    return states;
  }

  stopAll(): void {
    // Cancel all pending retries first (fire-and-forget, don't await in-flight)
    for (const name of [...this.pending.keys()]) {
      this.cancelPending(name);
    }
    for (const name of [...this.instances.keys()]) {
      this.stop(name);
    }
  }

  // --- Background retry internals ---

  private cancelPending(name: string): void {
    const p = this.pending.get(name);
    if (p) {
      p.aborted = true;
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(name);
    }
  }

  private spawnBackgroundRetry(name: string, factory: ServiceFactory): void {
    const state: PendingRetry = { attempt: 0, nextAttemptAt: 0, lastError: "", aborted: false, timer: null };
    this.pending.set(name, state);
    this.scheduleNextAttempt(name, factory, state);
  }

  private scheduleNextAttempt(name: string, factory: ServiceFactory, state: PendingRetry): void {
    const delay = backoffDelay(state.attempt);
    state.nextAttemptAt = Date.now() + delay;
    logDebug(TAG, `Background retry for ${name}: attempt ${state.attempt + 4} in ${Math.round(delay / 1000)}s`);

    state.timer = setTimeout(async () => {
      state.timer = null;
      if (state.aborted) return;
      if (this.instances.has(name)) { this.pending.delete(name); return; } // started externally

      // Heal port if last error was EADDRINUSE
      if (state.lastError?.includes("EADDRINUSE")) {
        const portMatch = state.lastError.match(/:(\d+)/);
        if (portMatch) {
          const { healPort } = await import("./self-healer-utils.js");
          healPort(parseInt(portMatch[1]!, 10));
        }
      }

      try {
        const instance = await factory.create();
        if (state.aborted) return; // aborted during create()
        await instance.start();
        if (state.aborted) return; // aborted during start()
        this.instances.set(name, instance);
        this.pending.delete(name); // atomic clear
        logInfo(TAG, `Started service: ${name} (background retry, attempt ${state.attempt + 4})`);
      } catch (err) {
        if (state.aborted) return;
        state.lastError = err instanceof Error ? err.message : String(err);
        state.attempt++;
        logWarn(TAG, `Background retry for ${name} failed (attempt ${state.attempt + 3}): ${state.lastError}`);
        this.scheduleNextAttempt(name, factory, state);
      }
    }, delay);
  }
}
