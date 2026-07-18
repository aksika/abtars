/**
 * peer-health.ts — Capability registry only.
 *
 * Dynamic health observation store, signed status building, and UDP gossip
 * were removed by #1434 (authenticated mDNS doorbell). The capability
 * registry remains for #1433 static inventory and help service.
 *
 * No more PeerHealthStore, ingestSignedStatus, getPeerTable, findCapablePeer,
 * buildSignedStatus, getLocalSnapshot, or related types.
 */

const MAX_CAPABILITIES = 64;

interface CapabilityOwner {
  generation: number;
  values: string[];
  healthy: boolean;
}

export class CapabilityRegistry {
  private owners = new Map<string, CapabilityOwner>();
  private nextGen = 1;

  register(owner: string, values: string[]): () => void {
    const gen = this.nextGen++;
    this.owners.set(owner, { generation: gen, values: [...values], healthy: true });
    const disposer = (): void => {
      const current = this.owners.get(owner);
      if (current && current.generation === gen) {
        this.owners.delete(owner);
      }
    };
    return disposer;
  }

  setHealth(owner: string, healthy: boolean): void {
    const entry = this.owners.get(owner);
    if (entry) entry.healthy = healthy;
  }

  getValues(): string[] {
    const result: string[] = [];
    for (const entry of this.owners.values()) {
      if (entry.healthy) result.push(...entry.values);
    }
    result.sort();
    const seen = new Set<string>();
    return result.filter(c => { const d = seen.has(c); seen.add(c); return !d; }).slice(0, MAX_CAPABILITIES);
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
