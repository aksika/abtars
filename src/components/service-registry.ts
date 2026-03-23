/**
 * Service registry — manages lifecycle of bridge services (Telegram, Discord, Agent API).
 * Services are registered with a factory that creates them on demand.
 * The dashboard and CLI flags both use this to start/stop services.
 */

import { logInfo, logError } from "./logger.js";

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

export class ServiceRegistry {
  private readonly factories = new Map<string, ServiceFactory>();
  private readonly instances = new Map<string, ServiceInstance>();

  register(name: string, factory: ServiceFactory): void {
    this.factories.set(name, factory);
  }

  async start(name: string): Promise<{ ok: boolean; error?: string }> {
    const factory = this.factories.get(name);
    if (!factory) return { ok: false, error: `Unknown service: ${name}` };
    if (!factory.configured) return { ok: false, error: `${name} not configured (check .env)` };
    if (this.instances.has(name)) return { ok: false, error: `${name} already running` };

    try {
      const instance = await factory.create();
      await instance.start();
      this.instances.set(name, instance);
      logInfo(TAG, `Started service: ${name}`);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(TAG, `Failed to start ${name}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  stop(name: string): { ok: boolean; error?: string } {
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

  getStates(): Record<string, { configured: boolean; running: boolean }> {
    const states: Record<string, { configured: boolean; running: boolean }> = {};
    for (const [name, factory] of this.factories) {
      states[name] = { configured: factory.configured, running: this.instances.has(name) };
    }
    return states;
  }

  stopAll(): void {
    for (const name of [...this.instances.keys()]) {
      this.stop(name);
    }
  }
}
