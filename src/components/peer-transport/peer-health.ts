/**
 * peer-health.ts — Capability registry with change subscriptions (#1455).
 *
 * Dynamic health observation store, signed status building, and UDP gossip
 * were removed by #1434 (authenticated mDNS doorbell). The capability
 * registry remains for #1433 static inventory and help service.
 *
 * Subscribers are notified on effective capability value changes after
 * register, dispose, or health mutations.
 */

const MAX_CAPABILITIES = 64;

type CapabilityListener = (values: readonly string[]) => void;

interface CapabilityOwner {
  generation: number;
  values: string[];
  healthy: boolean;
}

export class CapabilityRegistry {
  private owners = new Map<string, CapabilityOwner>();
  private nextGen = 1;
  private listeners: CapabilityListener[] = [];

  register(owner: string, values: string[]): () => void {
    const before = this.getEffective();
    const gen = this.nextGen++;
    this.owners.set(owner, { generation: gen, values: [...values], healthy: true });
    const after = this.getEffective();
    if (this.arraysDiffer(before, after)) {
      this.notifyListeners(after);
    }
    const disposer = (): void => {
      const beforeDispose = this.getEffective();
      const current = this.owners.get(owner);
      if (current && current.generation === gen) {
        this.owners.delete(owner);
      }
      const afterDispose = this.getEffective();
      if (this.arraysDiffer(beforeDispose, afterDispose)) {
        this.notifyListeners(afterDispose);
      }
    };
    return disposer;
  }

  setHealth(owner: string, healthy: boolean): void {
    const before = this.getEffective();
    const entry = this.owners.get(owner);
    if (entry) entry.healthy = healthy;
    const after = this.getEffective();
    if (this.arraysDiffer(before, after)) {
      this.notifyListeners(after);
    }
  }

  subscribe(listener: CapabilityListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getValues(): string[] {
    return this.getEffective();
  }

  private getEffective(): string[] {
    const result: string[] = [];
    for (const entry of this.owners.values()) {
      if (entry.healthy) result.push(...entry.values);
    }
    result.sort();
    const seen = new Set<string>();
    return result.filter(c => { const d = seen.has(c); seen.add(c); return !d; }).slice(0, MAX_CAPABILITIES);
  }

  private arraysDiffer(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return true;
    }
    return false;
  }

  private notifyListeners(values: string[]): void {
    const immutable = Object.freeze([...values]);
    const current = [...this.listeners];
    for (const l of current) {
      try { l(immutable); } catch { /* isolated */ }
    }
  }
}

let _instance: CapabilityRegistry | null = null;

export function getHealthStore(): CapabilityRegistry {
  if (!_instance) _instance = new CapabilityRegistry();
  return _instance;
}

export function getLocalCapabilities(): string[] {
  return getHealthStore().getValues();
}

export function resetHealthStore(): void {
  _instance = null;
}
